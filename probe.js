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

  // 1. Probe global API health
  console.log('Probing global API health...');
  const apiStart = Date.now();
  let apiUp = false;
  let apiPing = 0;
  let models = { text: [], image: [] };

  try {
    const res = await fetch(`${API_URL}/v1/models`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    apiPing = Date.now() - apiStart;
    if (res.ok) {
      apiUp = true;
      const data = await res.json();
      if (data && Array.isArray(data.text)) models.text = data.text;
      if (data && Array.isArray(data.image)) models.image = data.image;
      console.log(`API is Up. Found ${models.text.length} text models.`);
    } else {
      console.warn(`API returned HTTP status ${res.status}`);
    }
  } catch (e) {
    apiPing = Date.now() - apiStart;
    console.error('API probe failed:', e.message);
  }

  // Update history for global API monitor
  updateMonitorHistory(history, 'zylo-api-health', 'Zylo API Health', apiUp, apiPing, 'API /v1/models health check');

  // 2. Update status for all models
  // If the API is up, we mark models as up (paid models are mapped dynamically, free ones are verified)
  const allModels = [...models.text, ...models.image];
  const apiKey = process.env.ZYLO_API_KEY;
  
  if (!apiKey) {
    console.warn(`[${ts()}] WARNING: ZYLO_API_KEY is not defined. Free models will be assumed active without live requests.`);
  }

  if (allModels.length > 0) {
    for (const m of allModels) {
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
          // Free text models
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
            // Add a small 200ms delay between consecutive model checks to prevent aggressive hammering
            await new Promise(resolve => setTimeout(resolve, 200));
          } else {
            modelUp = true;
            modelPing = apiPing;
            modelMsg = 'Free model (assumed active, ZYLO_API_KEY missing)';
          }
        } else {
          // Free image models (assumed active as prober does not have image-specific checker)
          modelUp = true;
          modelPing = apiPing;
          modelMsg = 'Free Image model (assumed active)';
        }
      } else {
        modelUp = false;
        modelPing = 0;
        modelMsg = 'API Down';
      }
      
      updateMonitorHistory(history, monitorId, m.name || m.id, modelUp, modelPing, modelMsg);
    }
  } else {
    // If we couldn't load models, mark existing models in history as down
    console.warn('No models found, marking existing models as DOWN (since API is down)...');
    for (const id in history) {
      if (id !== 'zylo-api-health') {
        updateMonitorHistory(history, id, history[id].name, false, 0, 'Catalog unreachable');
      }
    }
  }

  // Write history back to file
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  console.log(`[${ts()}] Probing completed. History saved to ${HISTORY_FILE}`);
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 402) {
        console.warn(`[WARN] ${modelId}: HTTP ${res.status} — prober account issue, not model fault. ${body.slice(0, 150)}`);
        return { up: true, ms: elapsed, msg: `Auth/Billing issue (${res.status}), model assumed up` };
      }
      return { up: false, ms: elapsed, msg: `HTTP ${res.status}: ${body.slice(0, 150)}` };
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
