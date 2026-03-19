/**
 * PS99 RAP — Cloudflare Worker
 *
 * Cron:  every 5 minutes
 *   → snap:<ts>       full RAP + exists snapshot (RETENTION_DAYS TTL)
 *   → hatch-buffer    rolling compact buffer of Huge/Titanic exists only (HATCH_RETENTION_DAYS)
 *   → latest          current RAP + exists (overwritten each run)
 *
 * GET /latest         current RAP + exists data
 * GET /history        all price snapshots within retention window
 * GET /hatch-history  compact Huge/Titanic exists history (from hatch-buffer)
 * GET /status         debug info
 */

const API_RAP              = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS           = 'https://ps99.biggamesapi.io/api/exists';
const RETENTION_DAYS       = 30;
const HATCH_RETENTION_DAYS = 7;    // keep 7 days of hatch data (~2016 snapshots)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

const ok  = data    => new Response(JSON.stringify(data),           { headers: CORS });
const err = (msg,s) => new Response(JSON.stringify({ error: msg }), { status: s ?? 500, headers: CORS });

// Same merge key format as the frontend
function mergeKey(d) {
  const c = d.configData;
  return `${d.category}|${c.id}|${c.pt || 0}|${c.tn || 0}|${c.sh ? 1 : 0}`;
}

// Returns true if this pet name should be tracked in the hatch feed
function isTrackedPet(name) {
  const n = name.toLowerCase();
  return n.includes('huge') || n.includes('titanic');
}

// ─────────────────────────────────────────────────────────────
//  CRON
// ─────────────────────────────────────────────────────────────
async function handleCron(env) {
  const [rapRes, exRes] = await Promise.all([
    fetch(API_RAP).then(r => r.json()),
    fetch(API_EXISTS).then(r => r.json()),
  ]);

  if (rapRes.status !== 'ok' || exRes.status !== 'ok') {
    console.error('[cron] Bad API response');
    return;
  }

  const ts = Date.now();

  // ── 1. Full snapshot ──────────────────────────────────────
  const d = {};
  for (const item of rapRes.data)  d['r|' + mergeKey(item)] = item.value;
  for (const item of exRes.data)   d['e|' + mergeKey(item)] = item.value;

  // ── 2. Hatch buffer (Huge + Titanic pets only) ────────────
  // Build compact snapshot: mergeKey → exists value
  // Also store petMeta so the frontend knows id/pt/sh for each key
  const hatchD    = {};
  const petMeta   = {};
  for (const item of exRes.data) {
    if (item.category !== 'Pet') continue;
    if (!isTrackedPet(item.configData.id)) continue;
    const k = mergeKey(item);
    hatchD[k]   = item.value;
    petMeta[k]  = {
      id: item.configData.id,
      pt: item.configData.pt || 0,
      tn: item.configData.tn || 0,
      sh: !!item.configData.sh,
    };
  }

  // Load existing hatch buffer, append, trim, save
  let hatchBuf = { petMeta: {}, snapshots: [] };
  try {
    const raw = await env.PS99_KV.get('hatch-buffer');
    if (raw) hatchBuf = JSON.parse(raw);
  } catch (_) {}

  // Merge petMeta (new pets may appear over time)
  Object.assign(hatchBuf.petMeta, petMeta);

  hatchBuf.snapshots.push({ ts, d: hatchD });

  // Trim to retention window
  const cutoff = ts - HATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  hatchBuf.snapshots = hatchBuf.snapshots.filter(s => s.ts >= cutoff);

  // ── 3. Write all three KV entries in parallel ─────────────
  const ttlSeconds = RETENTION_DAYS * 24 * 60 * 60;
  await Promise.all([
    env.PS99_KV.put(`snap:${ts}`, JSON.stringify({ ts, d }), { expirationTtl: ttlSeconds }),
    env.PS99_KV.put('latest',       JSON.stringify({ ts, rap: rapRes.data, exists: exRes.data })),
    env.PS99_KV.put('hatch-buffer', JSON.stringify(hatchBuf)),
  ]);

  console.log(`[cron] saved — snaps: hatch buffer has ${hatchBuf.snapshots.length} entries`);
}

// ─────────────────────────────────────────────────────────────
//  Fetch all price snapshots within retention window
// ─────────────────────────────────────────────────────────────
async function getHistory(env) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const listed = await env.PS99_KV.list({ prefix: 'snap:' });
  const keys   = listed.keys
    .map(k => ({ name: k.name, ts: parseInt(k.name.split(':')[1]) }))
    .filter(k => k.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);

  const BATCH = 50;
  const snaps = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const vals = await Promise.all(keys.slice(i, i + BATCH).map(k => env.PS99_KV.get(k.name, 'json')));
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

  // /latest
  if (url.pathname === '/latest') {
    const cached = await env.PS99_KV.get('latest', 'json');
    if (cached) return ok({ status: 'ok', ...cached });
    const [rapRes, exRes] = await Promise.all([
      fetch(API_RAP).then(r => r.json()),
      fetch(API_EXISTS).then(r => r.json()),
    ]);
    return ok({ status: 'ok', ts: Date.now(), rap: rapRes.data, exists: exRes.data });
  }

  // /history
  if (url.pathname === '/history') {
    const snaps = await getHistory(env);
    return ok({ status: 'ok', count: snaps.length, retention_days: RETENTION_DAYS, data: snaps });
  }

  // /hatch-history  ← NEW
  if (url.pathname === '/hatch-history') {
    const raw = await env.PS99_KV.get('hatch-buffer');
    if (!raw) return ok({ status: 'ok', petMeta: {}, snapshots: [], count: 0 });
    const buf = JSON.parse(raw);
    return ok({
      status:    'ok',
      count:     buf.snapshots.length,
      petMeta:   buf.petMeta   || {},
      snapshots: buf.snapshots || [],
    });
  }

  // /status
  if (url.pathname === '/status') {
    const listed  = await env.PS99_KV.list({ prefix: 'snap:' });
    const latest  = await env.PS99_KV.get('latest', 'json');
    const hatch   = await env.PS99_KV.get('hatch-buffer');
    const hatchBuf = hatch ? JSON.parse(hatch) : { snapshots: [] };
    const oldest  = listed.keys.length
      ? parseInt(listed.keys.sort((a,b) => a.name.localeCompare(b.name))[0].name.split(':')[1])
      : null;
    return ok({
      status:               'ok',
      price_snapshots:      listed.keys.length,
      hatch_snapshots:      hatchBuf.snapshots.length,
      hatch_pets_tracked:   Object.keys(hatchBuf.petMeta || {}).length,
      retention_days:       RETENTION_DAYS,
      hatch_retention_days: HATCH_RETENTION_DAYS,
      oldest_snapshot:      oldest ? new Date(oldest).toISOString() : null,
      latest_snapshot:      latest ? new Date(latest.ts).toISOString() : null,
    });
  }

  return err('Not found', 404);
}

export default {
  fetch:     (req, env) => handleFetch(req, env).catch(e => err(e.message)),
  scheduled: (_evt, env) => handleCron(env).catch(e => console.error('[cron error]', e.message)),
};
