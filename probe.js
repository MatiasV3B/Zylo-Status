import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = resolve(__dirname, 'data/history.json');
// Admin-set manual overrides. A model can be forced to 'maintenance' (amber, not
// counted), 'down' (red), or 'stable' (green) regardless of the live check. Written
// by the admin panel via the GitHub Contents API.
const OVERRIDES_FILE = resolve(__dirname, 'data/overrides.json');
const API_URL = 'https://api.zyloai.net';

// Spacing between model probes. A free key is rate-limited to 10 req/min, so we
// never fire faster than one every 600ms. With a limitless probe key this is just
// gentle pacing so we don't hammer the upstream providers.
const PROBE_SPACING_MS = 600;
// One image model in the catalog. Image generation is real GPU inference (costs
// money even with a limitless key), so it can be disabled with ZYLO_PROBE_IMAGES=0.
const PROBE_IMAGES = process.env.ZYLO_PROBE_IMAGES !== '0';
// Paid policy: higher-tier ("paid"/GO) models are asserted STABLE (green) without a
// live probe — only the lowest tier ("free"/BASIC) is actually checked, since those
// are the ones that flap. Set PAID_ALWAYS_STABLE=0 (e.g. a manual dispatch) to
// live-probe the paid models too.
const PAID_ALWAYS_STABLE = process.env.PAID_ALWAYS_STABLE !== '0';

const ts = () => new Date().toISOString();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Plan hierarchy rank (free < BASIC < GO < PRO < MEGA < ENTERPRISE; limitless = all).
// Returns undefined for unknown/non-hierarchical plans.
function planRank(p) {
  const R = { free: 0, basic: 1, go: 2, pro: 3, mega: 4, enterprise: 5, limitless: 99 };
  return R[String(p == null ? '' : p).toLowerCase()];
}

async function main() {
  console.log(`[${ts()}] Starting GitHub Actions Uptime Prober...`);

  const dataDir = resolve(__dirname, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  let history = {};
  if (existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    } catch (e) {
      console.warn('Could not parse history.json, starting fresh:', e.message);
    }
  }

  // A probe failure (non-2xx, timeout, unreachable host) is a "down" DATA POINT we
  // want to record and publish — it must NEVER abort the workflow before history is
  // written/committed/deployed. Otherwise an outage would ironically prevent the
  // status page from ever SHOWING the outage. Only a real I/O failure (can't write
  // the file) is allowed to fail the job.
  try {
    await runProbes(history);
  } catch (e) {
    console.error(`[${ts()}] Unexpected error during probing (history will still be saved):`, e);
  } finally {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
    console.log(`[${ts()}] Probing completed. History saved to ${HISTORY_FILE}`);
  }
}

async function runProbes(history) {
  // 1. Probe global API health (no key needed — just the public catalog endpoint).
  console.log('Probing global API health...');
  const apiStart = Date.now();
  let apiUp = false;
  let apiPing = 0;
  let apiMsg = 'API /v1/models health check';
  let models = { text: [], image: [] };

  try {
    const res = await fetch(`${API_URL}/v1/models`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    apiPing = Date.now() - apiStart;
    if (res.ok) {
      apiUp = true;
      apiMsg = `Operational (HTTP ${res.status})`;
      const data = await res.json();
      if (data && Array.isArray(data.text)) models.text = data.text;
      if (data && Array.isArray(data.image)) models.image = data.image;
      console.log(`API is Up. Found ${models.text.length} text + ${models.image.length} image models.`);
    } else {
      apiMsg = `API Down — HTTP ${res.status}`;
      console.warn(`API returned HTTP status ${res.status} — marking as DOWN`);
    }
  } catch (e) {
    apiPing = Date.now() - apiStart;
    apiMsg = e.name === 'TimeoutError' ? 'API Down — Timeout (10s)' : `API Down — ${e.message}`;
    console.error('API probe failed:', e.message);
  }

  updateMonitorHistory(history, 'zylo-api-health', 'Zylo API Health', { up: apiUp, ping: apiPing, msg: apiMsg, verified: true });

  // 2. Probe EVERY model with a real request. The rule (matching the admin console):
  //    2xx => UP, anything else => DOWN. No model is ever "assumed active" — that's
  //    the whole point of a status page. Without a key we cannot verify, so models
  //    are recorded as UNVERIFIED (neutral/amber), never faked green.
  const apiKey = process.env.ZYLO_API_KEY;
  // A catalog id can carry stray whitespace/newlines (e.g. a bad paste when the
  // model was added). That both breaks upstream routing AND mangles into a phantom
  // monitor id, so normalize in place before the id is used for anything.
  for (const m of [...models.text, ...models.image]) {
    if (m && typeof m.id === 'string') m.id = m.id.trim();
  }
  const textIds = new Set(models.text.map((m) => m && m.id));
  const allModels = [...models.text, ...models.image];

  // Manual overrides keyed by (clean) model id. Missing file → no overrides.
  let overrides = {};
  if (existsSync(OVERRIDES_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf-8'));
      if (parsed && parsed.overrides && typeof parsed.overrides === 'object') overrides = parsed.overrides;
      const n = Object.keys(overrides).length;
      if (n) console.log(`Loaded ${n} manual override(s) from overrides.json.`);
    } catch (e) {
      console.warn('Could not parse overrides.json, ignoring:', e.message);
    }
  }

  if (!apiKey) {
    console.warn(`[${ts()}] WARNING: ZYLO_API_KEY secret is NOT set. Models cannot be live-checked and will show as UNVERIFIED. Set it (use a limitless key) to enable real 200/else checks.`);
  }

  // Plan tiers: the lowest tier present ("free"/BASIC) is live-probed; everything
  // above it ("paid"/GO) is asserted stable by policy (PAID_ALWAYS_STABLE) and not
  // probed — only an explicit admin override changes a paid model's state.
  const ranks = allModels.map((m) => planRank(m && m.min_plan)).filter((r) => r != null);
  const lowestRank = ranks.length ? Math.min(...ranks) : 0;
  const isPaid = (m) => { const r = planRank(m && m.min_plan); return r != null && r > lowestRank; };
  const paidCount = allModels.filter(isPaid).length;
  console.log(`Tiers: lowest rank=${lowestRank}; ${paidCount} paid model(s) ${PAID_ALWAYS_STABLE ? 'asserted STABLE (not probed)' : 'will be probed'}.`);

  if (apiUp && allModels.length > 0) {
    let i = 0;
    for (const m of allModels) {
      try {
        if (!m || !m.id) { console.warn('Skipping model with missing id:', JSON.stringify(m)); continue; }
        const monitorId = `model-${m.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
        const isText = textIds.has(m.id);

        const ov = overrides[m.id];
        let result;
        if (ov && (ov.state === 'stable' || ov.state === 'maintenance' || ov.state === 'down')) {
          // Admin override: skip the real probe entirely.
          const note = (ov.note == null ? '' : String(ov.note)).slice(0, 160);
          if (ov.state === 'stable') result = { up: true, ping: 0, verified: true, msg: 'Stable' + (note ? ' — ' + note : ' (set by admin)') };
          else if (ov.state === 'maintenance') result = { up: false, ping: 0, verified: false, maintenance: true, msg: 'Maintenance' + (note ? ' — ' + note : ' (set by admin)') };
          else result = { up: false, ping: 0, verified: true, msg: 'Flagged down by admin' + (note ? ' — ' + note : '') };
          console.log(`  ⚙ ${m.id} — override: ${ov.state}`);
        } else if (isPaid(m) && PAID_ALWAYS_STABLE) {
          // Paid model asserted stable by policy — not live-probed.
          result = { up: true, ping: 0, verified: true, msg: 'Stable — paid model (policy: not live-probed)' };
        } else if (!apiKey) {
          // Honest: we genuinely don't know. Neutral, not green, not red.
          result = { up: true, ping: 0, verified: false, msg: 'Unverified — ZYLO_API_KEY secret not set' };
        } else if (!isText && !PROBE_IMAGES) {
          result = { up: true, ping: 0, verified: false, msg: 'Unverified — image checks disabled (ZYLO_PROBE_IMAGES=0)' };
        } else {
          if (i > 0) await delay(PROBE_SPACING_MS);
          i++;
          console.log(`Probing ${isText ? 'text' : 'image'} model: ${m.id}...`);
          result = isText ? await probeTextModel(m.id, apiKey) : await probeImageModel(m.id, apiKey);
          const tag = result.verified === false ? '?' : (result.up ? '✔' : '✖');
          console.log(`  ${tag} ${m.id} — ${result.msg}`);
        }
        updateMonitorHistory(history, monitorId, m.name || m.id, result);
      } catch (modelErr) {
        console.error(`Error processing model ${m && m.id}:`, modelErr.message);
      }
    }
  } else if (!apiUp) {
    // API is down → every known model is down.
    console.warn('API is unreachable — marking every known model as DOWN...');
    for (const id in history) {
      if (id !== 'zylo-api-health') {
        updateMonitorHistory(history, id, history[id].name, { up: false, ping: 0, msg: apiMsg, verified: true });
      }
    }
  }

  // Prune monitors for models no longer in the live catalog, so deleting a model in
  // the admin actually removes it from the status page. Only prune when we trust the
  // catalog (API up AND it returned models) — never on an outage, or we'd wipe every
  // model the moment the API blips.
  if (apiUp && allModels.length > 0) {
    const liveIds = new Set(['zylo-api-health']);
    for (const m of allModels) {
      if (m && m.id) liveIds.add(`model-${m.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`);
    }
    let pruned = 0;
    for (const id of Object.keys(history)) {
      if (id.indexOf('model-') === 0 && !liveIds.has(id)) { delete history[id]; pruned++; }
    }
    if (pruned) console.log(`Pruned ${pruned} stale model monitor(s) no longer in the catalog.`);
  }
}

// Turn an HTTP response into a check result. 2xx => up (verified). 429/403 mean we
// couldn't actually verify (rate limited / probe key lacks access) — neutral, NOT a
// model failure, so we don't flap the page red because OUR key got throttled. Real
// failures (timeout, 4xx/5xx) => down (verified).
function classify(status, ms, bodyText) {
  if (status >= 200 && status < 300) return { up: true, ping: ms, verified: true, msg: `OK (HTTP ${status}, ${ms}ms)` };
  if (status === 429) return { up: true, ping: ms, verified: false, msg: 'Unverified — rate limited (HTTP 429)' };
  if (status === 403) return { up: true, ping: ms, verified: false, msg: 'Unverified — probe key has no access (HTTP 403)' };
  if (status === 0) return { up: false, ping: ms, verified: true, msg: bodyText || 'Down — no connection / timeout' };
  return { up: false, ping: ms, verified: true, msg: `Down — HTTP ${status}: ${String(bodyText || '').slice(0, 140)}`.trim() };
}

async function probeTextModel(modelId, apiKey) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(30000)
    });
    const ms = Date.now() - t0;
    if (res.status >= 200 && res.status < 300) {
      // 2xx but malformed body still counts as a failure to actually generate.
      const data = await res.json().catch(() => null);
      const hasChoice = data && Array.isArray(data.choices) && data.choices.length > 0;
      return hasChoice ? classify(res.status, ms) : { up: false, ping: ms, verified: true, msg: `Down — HTTP ${res.status} but no choices in response` };
    }
    const body = await res.text().catch(() => '');
    return classify(res.status, ms, body);
  } catch (e) {
    const ms = Date.now() - t0;
    return classify(0, ms, e.name === 'TimeoutError' ? 'Down — timeout (30s)' : `Down — ${e.message}`);
  }
}

async function probeImageModel(modelId, apiKey) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_URL}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, prompt: 'a simple solid red circle centered on a white background' }),
      signal: AbortSignal.timeout(90000)
    });
    const ms = Date.now() - t0;
    if (res.status >= 200 && res.status < 300) return classify(res.status, ms);
    const body = await res.text().catch(() => '');
    return classify(res.status, ms, body);
  } catch (e) {
    const ms = Date.now() - t0;
    return classify(0, ms, e.name === 'TimeoutError' ? 'Down — timeout (90s)' : `Down — ${e.message}`);
  }
}

// Append a check and recompute uptime. A check is { timestamp, up, ping, msg,
// verified }. `verified === false` means "couldn't determine" — it is shown amber
// and EXCLUDED from the uptime % (so we never report a fabricated 100%).
function updateMonitorHistory(history, id, name, result) {
  if (!history[id]) history[id] = { id, name, uptime: 100, checks: [] };
  history[id].name = name;

  history[id].checks.push({
    timestamp: new Date().toISOString(),
    up: !!result.up,
    ping: result.ping || 0,
    msg: result.msg || '',
    verified: result.verified !== false,
    maintenance: !!result.maintenance
  });
  if (history[id].checks.length > 30) history[id].checks.shift();

  // Uptime over VERIFIED checks only. If nothing was verified yet, uptime is null
  // (the page renders "—" instead of a fake percentage).
  const verified = history[id].checks.filter((c) => c.verified !== false);
  if (verified.length > 0) {
    const upCount = verified.filter((c) => c.up).length;
    history[id].uptime = Math.round((upCount / verified.length) * 10000) / 100;
  } else {
    history[id].uptime = null;
  }
}

main().catch((e) => {
  console.error('Fatal probe error:', e);
  process.exit(1);
});
