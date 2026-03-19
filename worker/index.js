/**
 * PS99 RAP – Cloudflare Worker
 *
 * Cron trigger:  polls Big Games API every 5 min, stores snapshot in KV
 * Fetch handler: serves snapshot history to the frontend with CORS headers
 *
 * KV namespace:  PS99_KV
 *   - "snaps"        → JSON array of last MAX_SNAPS snapshots (rolling)
 *   - "latest"       → most recent raw merged data (for quick cold-load)
 */

const API_RAP    = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS = 'https://ps99.biggamesapi.io/api/exists';
const MAX_SNAPS  = 288; // 5-min intervals × 24 h = 1 full day of history

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── MERGE helper (same logic as frontend) ─────────────────────────────────────
function mergeKey(d) {
  const c = d.configData;
  return `${d.category}|${c.id}|${c.pt || 0}|${c.tn || 0}|${c.sh ? 1 : 0}`;
}

function buildSnapData(rapArr, existsArr) {
  const d = {};
  for (const item of rapArr)    d['r|' + mergeKey(item)] = item.value;
  for (const item of existsArr) d['e|' + mergeKey(item)] = item.value;
  return d;
}

// ── CRON: runs every 5 minutes ─────────────────────────────────────────────────
async function handleCron(env) {
  const [rapRes, exRes] = await Promise.all([
    fetch(API_RAP).then(r => r.json()),
    fetch(API_EXISTS).then(r => r.json()),
  ]);

  const snap = {
    ts: Date.now(),
    d:  buildSnapData(rapRes.data || [], exRes.data || []),
  };

  // Load existing snaps array, append, trim, save
  let snaps = [];
  try {
    const raw = await env.PS99_KV.get('snaps');
    if (raw) snaps = JSON.parse(raw);
  } catch (_) {}

  snaps.push(snap);
  if (snaps.length > MAX_SNAPS) snaps = snaps.slice(-MAX_SNAPS);

  await Promise.all([
    env.PS99_KV.put('snaps',  JSON.stringify(snaps)),
    env.PS99_KV.put('latest', JSON.stringify({ rap: rapRes.data, exists: exRes.data })),
  ]);

  console.log(`[cron] snapshot saved — total: ${snaps.length}`);
}

// ── FETCH: serves data to the browser ─────────────────────────────────────────
async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // GET /history — returns all saved snapshots
  if (url.pathname === '/history') {
    const raw = await env.PS99_KV.get('snaps');
    const snaps = raw ? JSON.parse(raw) : [];
    return json({ status: 'ok', count: snaps.length, data: snaps });
  }

  // GET /latest — returns current RAP + exists (for initial page load)
  if (url.pathname === '/latest') {
    const raw = await env.PS99_KV.get('latest');
    const latest = raw ? JSON.parse(raw) : null;
    if (!latest) {
      // KV is empty — proxy directly to Big Games so the first load still works
      const [rapRes, exRes] = await Promise.all([
        fetch(API_RAP).then(r => r.json()),
        fetch(API_EXISTS).then(r => r.json()),
      ]);
      return json({ status: 'ok', rap: rapRes.data, exists: exRes.data, cached: false });
    }
    return json({ status: 'ok', rap: latest.rap, exists: latest.exists, cached: true });
  }

  // GET /status
  if (url.pathname === '/status') {
    const raw = await env.PS99_KV.get('snaps');
    const snaps = raw ? JSON.parse(raw) : [];
    const last  = snaps[snaps.length - 1];
    return json({
      status:      'ok',
      snapshots:   snaps.length,
      last_update: last ? new Date(last.ts).toISOString() : null,
    });
  }

  return json({ status: 'error', message: 'Not found' }, 404);
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
export default {
  fetch:     (req, env) => handleFetch(req, env),
  scheduled: (_evt, env) => handleCron(env),
};
