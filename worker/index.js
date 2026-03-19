/**
 * PS99 RAP — Cloudflare Worker
 *
 * Cron:  every 5 minutes → fetch Big Games API → store snapshot as snap:<ts>
 * GET /latest  → current RAP + exists data
 * GET /history → all snapshots within retention window
 * GET /status  → debug info
 *
 * Storage: one KV key per snapshot ("snap:<timestamp>")
 *   → no single-value size limit, supports months of history
 *
 * KV namespace binding: PS99_KV (set in wrangler.toml)
 */

const API_RAP        = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS     = 'https://ps99.biggamesapi.io/api/exists';
const RETENTION_DAYS = 30;   // ← change this to keep more/less history

// ─────────────────────────────────────────────────────────────
//  CORS headers — allow any origin (GitHub Pages, localhost, etc.)
// ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const ok  = (data)    => new Response(JSON.stringify(data),           { headers: CORS });
const err = (msg, s)  => new Response(JSON.stringify({ error: msg }), { status: s ?? 500, headers: CORS });

// ─────────────────────────────────────────────────────────────
//  Merge helper — same key format as the frontend
// ─────────────────────────────────────────────────────────────
function mergeKey(d) {
  const c = d.configData;
  return `${d.category}|${c.id}|${c.pt || 0}|${c.tn || 0}|${c.sh ? 1 : 0}`;
}

// ─────────────────────────────────────────────────────────────
//  CRON — called every 5 minutes by Cloudflare scheduler
// ─────────────────────────────────────────────────────────────
async function handleCron(env) {
  const [rapRes, exRes] = await Promise.all([
    fetch(API_RAP).then(r => r.json()),
    fetch(API_EXISTS).then(r => r.json()),
  ]);

  if (rapRes.status !== 'ok' || exRes.status !== 'ok') {
    console.error('[cron] Bad response from Big Games API');
    return;
  }

  const ts  = Date.now();
  const d   = {};
  for (const item of rapRes.data)  d['r|' + mergeKey(item)] = item.value;
  for (const item of exRes.data)   d['e|' + mergeKey(item)] = item.value;

  // Store snapshot under its own key with a TTL matching retention
  const ttlSeconds = RETENTION_DAYS * 24 * 60 * 60;
  await Promise.all([
    env.PS99_KV.put(`snap:${ts}`, JSON.stringify({ ts, d }), { expirationTtl: ttlSeconds }),
    env.PS99_KV.put('latest', JSON.stringify({ ts, rap: rapRes.data, exists: exRes.data })),
  ]);

  console.log(`[cron] snapshot saved at ${new Date(ts).toISOString()}`);
}

// ─────────────────────────────────────────────────────────────
//  Fetch all snapshots within retention window
// ─────────────────────────────────────────────────────────────
async function getHistory(env) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // List all keys with prefix "snap:"
  const listed = await env.PS99_KV.list({ prefix: 'snap:' });
  const keys   = listed.keys
    .map(k => ({ name: k.name, ts: parseInt(k.name.split(':')[1]) }))
    .filter(k => k.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);

  // Fetch values in parallel (batched to avoid hitting rate limits)
  const BATCH = 50;
  const snaps = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const vals  = await Promise.all(batch.map(k => env.PS99_KV.get(k.name, 'json')));
    for (const v of vals) if (v) snaps.push(v);
  }

  return snaps;
}

// ─────────────────────────────────────────────────────────────
//  HTTP handler
// ─────────────────────────────────────────────────────────────
async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // ── /latest ──────────────────────────────────────────────
  if (url.pathname === '/latest') {
    const cached = await env.PS99_KV.get('latest', 'json');
    if (cached) return ok({ status: 'ok', ...cached });

    // KV empty on first run — proxy directly
    const [rapRes, exRes] = await Promise.all([
      fetch(API_RAP).then(r => r.json()),
      fetch(API_EXISTS).then(r => r.json()),
    ]);
    return ok({ status: 'ok', ts: Date.now(), rap: rapRes.data, exists: exRes.data });
  }

  // ── /history ─────────────────────────────────────────────
  if (url.pathname === '/history') {
    const snaps = await getHistory(env);
    return ok({ status: 'ok', count: snaps.length, retention_days: RETENTION_DAYS, data: snaps });
  }

  // ── /status (debug) ──────────────────────────────────────
  if (url.pathname === '/status') {
    const listed  = await env.PS99_KV.list({ prefix: 'snap:' });
    const latest  = await env.PS99_KV.get('latest', 'json');
    const oldest  = listed.keys.length
      ? parseInt(listed.keys.sort((a,b) => a.name.localeCompare(b.name))[0].name.split(':')[1])
      : null;
    return ok({
      status:          'ok',
      snapshots_total: listed.keys.length,
      retention_days:  RETENTION_DAYS,
      oldest_snapshot: oldest ? new Date(oldest).toISOString() : null,
      latest_snapshot: latest ? new Date(latest.ts).toISOString() : null,
    });
  }

  return err('Not found', 404);
}

// ─────────────────────────────────────────────────────────────
//  Export
// ─────────────────────────────────────────────────────────────
export default {
  fetch:     (req, env) => handleFetch(req, env).catch(e => err(e.message)),
  scheduled: (_evt, env) => handleCron(env).catch(e => console.error('[cron error]', e.message)),
};
