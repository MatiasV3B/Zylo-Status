import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = resolve(__dirname, 'data/history.json');
const API_URL = 'https://api.zyloai.net';

// Helper to get timestamp
const ts = () => new Date().toISOString();

async function main() {
  console.log(`[${ts()}] Starting GitHub Actions Uptime Prober...`);

  // Ensure data directory exists
  const dataDir = resolve(__dirname, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Load existing history
  let history = {};
  if (existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    } catch (e) {
      console.warn('Could not parse history.json, starting fresh:', e.message);
    }
  }

  // A probe failure (non-2xx response, timeout, unreachable host) is a "down"
  // DATA POINT we want to record and publish — it must NEVER abort the workflow
  // before the history is written/committed/deployed. Otherwise an outage would
  // ironically prevent the status page from ever SHOWING the outage. Only a real
  // I/O failure (can't write the file) is allowed to fail the job.
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
  // 1. Probe global API health
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
    // Anything other than a 2xx response means the API is NOT working.
    if (res.ok) {
      apiUp = true;
      apiMsg = `Operational (HTTP ${res.status})`;
      const data = await res.json();
      if (data && Array.isArray(data.text)) models.text = data.text;
      if (data && Array.isArray(data.image)) models.image = data.image;
      console.log(`API is Up. Found ${models.text.length} text models.`);
    } else {
      apiMsg = `API Down — HTTP ${res.status}`;
      console.warn(`API returned HTTP status ${res.status} — marking as DOWN`);
    }
  } catch (e) {
    apiPing = Date.now() - apiStart;
    apiMsg = e.name === 'TimeoutError' ? 'API Down — Timeout (10s)' : `API Down — ${e.message}`;
    console.error('API probe failed:', e.message);
  }

  // Update history for global API monitor
  updateMonitorHistory(history, 'zylo-api-health', 'Zylo API Health', apiUp, apiPing, apiMsg);

  // 2. Update status for all models
  // If the API is up, paid models are assumed active (to avoid spending credits)
  // and free text models are verified with a real request.
  const allModels = [...models.text, ...models.image];
  const apiKey = process.env.ZYLO_API_KEY;

  if (!apiKey) {
    console.warn(`[${ts()}] WARNING: ZYLO_API_KEY is not defined. Free models cannot be live-checked and are assumed active.`);
  }

  if (allModels.length > 0) {
    for (const m of allModels) {
      // A single malformed model entry must not abort the whole run.
      try {
        if (!m || !m.id) {
          console.warn('Skipping model with missing id:', JSON.stringify(m));
          continue;
        }

        const monitorId = `model-${m.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
        const isPaid = !isFreeModel(m);
        const isText = models.text.some(tm => tm.id === m.id);

        let modelUp = apiUp;
        let modelPing = apiPing;
        let modelMsg = 'Operational';

        if (apiUp) {
          if (isPaid) {
            // Paid models assumed active to prevent spending credits
            modelUp = true;
            modelPing = 0;
            modelMsg = 'Paid model (real check skipped, assumed active)';
          } else if (isText) {
            // Free text models — verified with a real request
            if (apiKey) {
              console.log(`Probing free model: ${m.id}...`);
              const probeResult = await probeTextModel(m.id, apiKey);
              modelUp = probeResult.up;
              modelPing = probeResult.ms;
              modelMsg = probeResult.msg;
              if (modelUp) {
                console.log(`  ✔ [FREE] ${m.id} — ${modelMsg}`);
              } else {
                console.error(`  ✖ [FREE] ${m.id} — ${modelMsg}`);
              }
              // Small delay between checks to avoid hammering the API
              await new Promise(r => setTimeout(r, 200));
            } else {
              modelUp = true;
              modelPing = apiPing;
              modelMsg = 'Free model (assumed active, ZYLO_API_KEY missing)';
            }
          } else {
            // Free image models (assumed active — no image-specific checker yet)
            modelUp = true;
            modelPing = apiPing;
            modelMsg = 'Free Image model (assumed active)';
          }
        } else {
          // API is down → every model is down
          modelUp = false;
          modelPing = 0;
          modelMsg = apiMsg;
        }

        updateMonitorHistory(history, monitorId, m.name || m.id, modelUp, modelPing, modelMsg);
      } catch (modelErr) {
        console.error(`Error processing model ${m && m.id}:`, modelErr.message);
      }
    }
  } else {
    // Couldn't load the catalog — mark every known model as down.
    console.warn('No models found, marking existing models as DOWN (API is unreachable)...');
    for (const id in history) {
      if (id !== 'zylo-api-health') {
        updateMonitorHistory(history, id, history[id].name, false, 0, apiMsg);
      }
    }
  }

  // Prune monitors for models that no longer exist in the live catalog, so that
  // deleting a model in the admin actually removes it from the status page
  // (instead of its old monitor lingering forever). Only prune when we trust the
  // catalog (API up AND it returned models) — never on an outage, or we'd wipe
  // every model the moment the API blips.
  if (apiUp && allModels.length > 0) {
    const liveIds = new Set(['zylo-api-health']);
    for (const m of allModels) {
      if (m && m.id) liveIds.add(`model-${m.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`);
    }
    let pruned = 0;
    for (const id of Object.keys(history)) {
      if (id.indexOf('model-') === 0 && !liveIds.has(id)) {
        delete history[id];
        pruned++;
      }
    }
    if (pruned) console.log(`Pruned ${pruned} stale model monitor(s) no longer in the catalog.`);
  }
}

function isFreeModel(m) {
  if (m.min_plan && m.min_plan.toLowerCase() === 'free') return true;
  if (m.pricing) {
    const prompt = parseFloat(m.pricing.prompt) || 0;
    const completion = parseFloat(m.pricing.completion) || 0;
    if (prompt === 0 && completion === 0) return true;
  }
  if (m.id && (m.id.toLowerCase().includes(':free') || m.id.toLowerCase().endsWith('-free') || m.id.toLowerCase().includes('/free'))) {
    return true;
  }
  return false;
}

async function probeTextModel(modelId, apiKey) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        temperature: 0,
        stream: false
      }),
      signal: AbortSignal.timeout(30000)
    });
    const elapsed = Date.now() - t0;
    // Any non-2xx response means the model is NOT working — report it as DOWN.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { up: false, ms: elapsed, msg: `HTTP ${res.status}: ${body.slice(0, 150)}`.trim() };
    }
    const data = await res.json();
    const hasChoice = data.choices && data.choices.length > 0;
    return {
      up: hasChoice,
      ms: elapsed,
      msg: hasChoice ? `OK (${elapsed}ms)` : `No choices in response`
    };
  } catch (e) {
    const elapsed = Date.now() - t0;
    return {
      up: false,
      ms: elapsed,
      msg: e.name === 'TimeoutError' ? `Timeout (30s)` : e.message
    };
  }
}

function updateMonitorHistory(history, id, name, up, ping, msg) {
  if (!history[id]) {
    history[id] = {
      id,
      name,
      uptime: 100,
      checks: []
    };
  }

  const newCheck = {
    timestamp: new Date().toISOString(),
    up,
    ping,
    msg
  };

  // Append new check and keep only last 30 entries
  history[id].checks.push(newCheck);
  if (history[id].checks.length > 30) {
    history[id].checks.shift();
  }

  // Re-calculate uptime percentage based on last 30 checks
  const upCount = history[id].checks.filter(c => c.up).length;
  history[id].uptime = Math.round((upCount / history[id].checks.length) * 10000) / 100;
}

main().catch(e => {
  console.error('Fatal probe error:', e);
  process.exit(1);
});
