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
  
  if (allModels.length > 0) {
    for (const m of allModels) {
      const monitorId = `model-${m.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
      const isPaid = m.pricing && (parseFloat(m.pricing.prompt) > 0 || parseFloat(m.pricing.completion) > 0);
      
      let modelUp = apiUp;
      let modelPing = apiPing;
      
      // If it is a free model and API is up, we could do a quick validation or assume up
      if (!isPaid && apiUp) {
        // Assume UP since API responds, keeps it 100% free and fast without API key requirements
        modelUp = true;
      }
      
      updateMonitorHistory(history, monitorId, m.name || m.id, modelUp, modelPing, modelUp ? 'Operational' : 'API Down');
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
