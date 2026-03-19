/**
 * PS99 RAP — Cloudflare Worker (optimised)
 *
 * All history stored as rolling buffers in single KV keys:
 *   price-buffer  → last PRICE_SNAPS snapshots of full RAP+exists data
 *   hatch-buffer  → last 7 days of Huge/Titanic exists data
 *   latest        → current RAP+exists (overwritten each cron)
 *
 * This means every endpoint is ONE KV read — no per-snapshot keys,
 * no listing, no batching. CPU stays well within free-tier limits.
 *
 * Endpoints:
 *   GET /latest        current RAP + exists
 *   GET /history       price-buffer snapshots
 *   GET /hatch-history hatch-buffer snapshots + petMeta
 *   GET /status        debug counts
 */

const API_RAP    = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS = 'https://ps99.biggamesapi.io/api/exists';

// Price buffer: 500 snapshots ≈ 1.7 days at 5-min intervals
// (enough for 1h/24h charts; increase once you have Workers Paid)
const PRICE_SNAPS = 500;

// Hatch buffer: 7 days
const HATCH_DAYS  = 7;

// ─── CORS — always returned, even on errors ────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function mergeKey(d) {
  const c = d.configData;
  return `${d.category}|${c.id}|${c.pt || 0}|${c.tn || 0}|${c.sh ? 1 : 0}`;
}

function isHatchPet(name) {
  const n = name.toLowerCase();
  return n.includes('huge') || n.includes('titanic');
}

// ─── CRON ─────────────────────────────────────────────────────────────────
async function handleCron(env) {
  const [rapRes, exRes] = await Promise.all([
    fetch(API_RAP).then(r => r.json()),
    fetch(API_EXISTS).then(r => r.json()),
  ]);

  if (rapRes.status !== 'ok' || exRes.status !== 'ok') {
    console.error('[cron] bad API response');
    return;
  }

  const ts = Date.now();

  // ── Build snapshot data ───────────────────────────────────────────────────
  const snapD = {};
  for (const item of rapRes.data)  snapD['r|' + mergeKey(item)] = item.value;
  for (const item of exRes.data)   snapD['e|' + mergeKey(item)] = item.value;

  // ── Build hatch data ──────────────────────────────────────────────────────
  const hatchD   = {};
  const petMeta  = {};
  for (const item of exRes.data) {
    if (item.category !== 'Pet') continue;
    if (!isHatchPet(item.configData.id)) continue;
    const k = mergeKey(item);
    hatchD[k]  = item.value;
    petMeta[k] = {
      id: item.configData.id,
      pt: item.configData.pt || 0,
      tn: item.configData.tn || 0,
      sh: !!item.configData.sh,
    };
  }

  // ── Load, append, trim, save all buffers in parallel ─────────────────────
  const [priceBufRaw, hatchBufRaw] = await Promise.all([
    env.PS99_KV.get('price-buffer'),
    env.PS99_KV.get('hatch-buffer'),
  ]);

  // Price buffer
  let priceBuf = [];
  try { if (priceBufRaw) priceBuf = JSON.parse(priceBufRaw); } catch (_) {}
  priceBuf.push({ ts, d: snapD });
  if (priceBuf.length > PRICE_SNAPS) priceBuf = priceBuf.slice(-PRICE_SNAPS);

  // Hatch buffer
  let hatchBuf = { petMeta: {}, snapshots: [] };
  try { if (hatchBufRaw) hatchBuf = JSON.parse(hatchBufRaw); } catch (_) {}
  Object.assign(hatchBuf.petMeta, petMeta);
  hatchBuf.snapshots.push({ ts, d: hatchD });
  const hatchCutoff = ts - HATCH_DAYS * 86400000;
  hatchBuf.snapshots = hatchBuf.snapshots.filter(s => s.ts >= hatchCutoff);

  await Promise.all([
    env.PS99_KV.put('price-buffer', JSON.stringify(priceBuf)),
    env.PS99_KV.put('hatch-buffer', JSON.stringify(hatchBuf)),
    env.PS99_KV.put('latest', JSON.stringify({
      ts, rap: rapRes.data, exists: exRes.data,
    })),
  ]);

  console.log(`[cron] ok — price: ${priceBuf.length} snaps, hatch: ${hatchBuf.snapshots.length} snaps`);
}

// ─── HTTP handler ──────────────────────────────────────────────────────────
async function handleFetch(request, env) {
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // /latest — one KV read
  if (pathname === '/latest') {
    let cached = await env.PS99_KV.get('latest', 'json');
    if (!cached) {
      // First run — fetch directly and return, cron will persist it
      const [rapRes, exRes] = await Promise.all([
        fetch(API_RAP).then(r => r.json()),
        fetch(API_EXISTS).then(r => r.json()),
      ]);
      cached = { ts: Date.now(), rap: rapRes.data, exists: exRes.data };
    }
    return respond({ status: 'ok', ...cached });
  }

  // /history — one KV read
  if (pathname === '/history') {
    const raw  = await env.PS99_KV.get('price-buffer');
    const data = raw ? JSON.parse(raw) : [];
    return respond({
      status: 'ok',
      count:  data.length,
      max_snapshots: PRICE_SNAPS,
      data,
    });
  }

  // /hatch-history — one KV read
  if (pathname === '/hatch-history') {
    const raw = await env.PS99_KV.get('hatch-buffer');
    if (!raw) return respond({ status: 'ok', petMeta: {}, snapshots: [], count: 0 });
    const buf = JSON.parse(raw);
    return respond({
      status:    'ok',
      count:     buf.snapshots.length,
      hatch_retention_days: HATCH_DAYS,
      petMeta:   buf.petMeta   || {},
      snapshots: buf.snapshots || [],
    });
  }

  // /status — three KV reads (debug only)
  if (pathname === '/status') {
    const [pRaw, hRaw, lRaw] = await Promise.all([
      env.PS99_KV.get('price-buffer'),
      env.PS99_KV.get('hatch-buffer'),
      env.PS99_KV.get('latest', 'json'),
    ]);
    const pBuf  = pRaw ? JSON.parse(pRaw) : [];
    const hBuf  = hRaw ? JSON.parse(hRaw) : { snapshots: [], petMeta: {} };
    return respond({
      status:               'ok',
      price_snapshots:      pBuf.length,
      price_max:            PRICE_SNAPS,
      hatch_snapshots:      hBuf.snapshots.length,
      hatch_pets_tracked:   Object.keys(hBuf.petMeta || {}).length,
      hatch_retention_days: HATCH_DAYS,
      latest_ts:            lRaw ? new Date(lRaw.ts).toISOString() : null,
    });
  }

  return respond({ error: 'Not found' }, 404);
}

// ─── Export ────────────────────────────────────────────────────────────────
export default {
  // Always wrap in try/catch so CORS headers are returned even on crashes
  fetch: async (req, env) => {
    try {
      return await handleFetch(req, env);
    } catch (e) {
      console.error('[fetch error]', e.message);
      return respond({ error: e.message }, 500);
    }
  },
  scheduled: async (_evt, env) => {
    try {
      await handleCron(env);
    } catch (e) {
      console.error('[cron error]', e.message);
    }
  },
};
