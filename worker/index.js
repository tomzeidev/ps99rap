/**
 * PS99 RAP — Worker (minimal, correct)
 *
 * Lessons learned:
 * - Only track NORMAL (pt=0, sh=false) Huges/Titanics for hatch feed
 * - Only track RAP items for price history (no exists history — too many keys)
 * - Keep each snapshot to ONE number per item: the RAP value only
 * - Exists values come from /latest on every request, not from history
 *
 * This keeps state tiny regardless of how many items the API returns.
 *
 * State sizes at 288 snaps:
 *   price-state: ~1500 items × 288 snaps × ~8 bytes = ~3.5 MB  ✓
 *   hatch-state: ~200 pets  × 2016 snaps × ~8 bytes = ~3.2 MB  ✓
 */

const API_RAP    = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS = 'https://ps99.biggamesapi.io/api/exists';
const API_PETS   = 'https://ps99.biggamesapi.io/api/collection/Pets';
const PRICE_SNAPS = 288;
const HATCH_SNAPS = 2016;
const CACHE_TTL   = 240;
const STATE_VER   = 7;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const ok = (data, cache = true) => new Response(JSON.stringify(data), {
  headers: {
    ...CORS,
    'Cache-Control': cache
      ? `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`
      : 'no-store',
  },
});

function mergeKey(d) {
  const c = d.configData;
  return `${d.category}|${c.id}|${c.pt||0}|${c.tn||0}|${c.sh?1:0}`;
}

// ─── CRON ─────────────────────────────────────────────────────────────────────
async function handleCron(env) {
  const [rapRes, exRes, petsRes] = await Promise.all([
    fetch(API_RAP).then(r => r.json()),
    fetch(API_EXISTS).then(r => r.json()),
    fetch(API_PETS).then(r => r.json()),
  ]);
  if (rapRes.status !== 'ok' || exRes.status !== 'ok') {
    console.error('[cron] bad API'); return;
  }

  // Build set of exclusive pet names (RarityNumber === 999)
  const exclusiveNames = new Set();
  for (const p of (petsRes.data || [])) {
    if (p.configData?.rarity?.RarityNumber === 999) {
      exclusiveNames.add(p.configName);
    }
  }
  console.log(`[cron] exclusive pets: ${exclusiveNames.size}`);
  const ts = Date.now();

  // ── Price state ──────────────────────────────────────────────────────────
  // ONLY tracks RAP items. Each snapshot = {ki: rapValue} sparse object.
  // No exists history — exists comes from /latest only.
  const [psRaw, hsRaw] = await Promise.all([
    env.PS99_KV.get('price-state'),
    env.PS99_KV.get('hatch-state'),
  ]);

  let ps = { ver: STATE_VER, keys: [], snaps: [] };
  if (psRaw) {
    try {
      const loaded = JSON.parse(psRaw);
      // Accept only if correct version and sane key count
      if (loaded.ver === STATE_VER && Array.isArray(loaded.keys) && loaded.keys.length < 3000) {
        ps = loaded;
      } else {
        console.log(`[cron] price-state discarded (ver=${loaded.ver} keys=${(loaded.keys||[]).length})`);
      }
    } catch (_) {}
  }

  // Build key map from existing keys (O(1) lookups)
  const psKm = new Map(ps.keys.map((k, i) => [k, i]));

  function psKey(k) {
    let i = psKm.get(k);
    if (i === undefined) { i = ps.keys.length; ps.keys.push(k); psKm.set(k, i); }
    return i;
  }

  // Build sparse RAP snapshot — exclusive pets only (RarityNumber 999), all variants
  const snap = { ts, d: {} };
  for (const d of rapRes.data) {
    if (!d.value) continue;
    if (!exclusiveNames.has(d.configData.id)) continue;
    snap.d[psKey(mergeKey(d))] = d.value;
  }
  ps.snaps.push(snap);
  if (ps.snaps.length > PRICE_SNAPS) ps.snaps = ps.snaps.slice(-PRICE_SNAPS);

  // ── Hatch state ──────────────────────────────────────────────────────────
  // ONLY normal (pt=0, sh=false) Huge + Titanic pets.
  // Each snapshot = {ki: existsValue} sparse object.
  let hs = { ver: STATE_VER, keys: [], meta: [], snaps: [] };
  if (hsRaw) {
    try {
      const loaded = JSON.parse(hsRaw);
      if (loaded.ver === STATE_VER && Array.isArray(loaded.keys) && loaded.keys.length < 1000) {
        hs = loaded;
      } else {
        console.log(`[cron] hatch-state discarded (ver=${loaded.ver} keys=${(loaded.keys||[]).length})`);
      }
    } catch (_) {}
  }

  const hsKm    = new Map(hs.keys.map((k, i) => [k, i]));
  const hsKiSet = new Set(hs.keys.map((_, i) => i));

  function hsKey(k) {
    let i = hsKm.get(k);
    if (i === undefined) { i = hs.keys.length; hs.keys.push(k); hsKm.set(k, i); }
    return i;
  }

  const hSnap = { ts, d: {} };
  for (const d of exRes.data) {
    if (d.category !== 'Pet') continue;
    const c = d.configData;
    if (!d.value) continue;
    // Exclusive pets only, normal variants only for hatch counting
    if (!exclusiveNames.has(c.id)) continue;
    if (c.pt || c.sh || c.tn) continue;
    const k  = mergeKey(d);
    const ki = hsKey(k);
    if (!hsKiSet.has(ki)) {
      hsKiSet.add(ki);
      hs.meta.push({ id: c.id, pt: 0, tn: 0, sh: false });
    }
    hSnap.d[ki] = d.value;
  }
  hs.snaps.push(hSnap);
  if (hs.snaps.length > HATCH_SNAPS) hs.snaps = hs.snaps.slice(-HATCH_SNAPS);

  // ── Write 3 KV keys ──────────────────────────────────────────────────────
  const psStr = JSON.stringify(ps);
  const hsStr = JSON.stringify(hs);

  await Promise.all([
    env.PS99_KV.put('price-state', psStr),
    env.PS99_KV.put('hatch-state', hsStr),
    env.PS99_KV.put('latest', JSON.stringify({ ts, rap: rapRes.data, exists: exRes.data })),
  ]);

  try { await caches.default.delete(new Request('https://ps99-edge.internal/all')); } catch (_) {}

  console.log(`[cron] price: ${ps.snaps.length} snaps, ${ps.keys.length} keys, ${Math.round(psStr.length/1024)}KB`);
  console.log(`[cron] hatch: ${hs.snaps.length} snaps, ${hs.keys.length} pets, ${Math.round(hsStr.length/1024)}KB`);
}

// ─── Expand → /all payload ────────────────────────────────────────────────────
function expand(ps, hs, latest) {
  // Price history: sparse {ki: rapValue} → {mergeKey: value}
  const priceData = ps.snaps.map(snap => {
    const d = {};
    for (const [ki, v] of Object.entries(snap.d)) {
      d['r|' + ps.keys[ki]] = v;
    }
    // Also populate exists from latest for current snapshot richness
    return { ts: snap.ts, d };
  });

  // Hatch: build petMeta + expand snapshots
  const petMeta = {};
  for (let i = 0; i < hs.keys.length; i++) {
    const m = hs.meta[i];
    if (m) petMeta[hs.keys[i]] = m;
  }
  const hatchSnapshots = hs.snaps.map(snap => {
    const d = {};
    for (const [ki, v] of Object.entries(snap.d)) d[hs.keys[ki]] = v;
    return { ts: snap.ts, d };
  });

  return {
    status: 'ok', ts: latest.ts, rap: latest.rap, exists: latest.exists,
    history: {
      count: priceData.length,
      retention_days: Math.round(PRICE_SNAPS * 5 / 1440 * 10) / 10,
      data:  priceData,
    },
    hatch: { count: hatchSnapshots.length, petMeta, snapshots: hatchSnapshots },
  };
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────
async function handleFetch(req, env, ctx) {
  const path = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (path === '/status') {
    const [psRaw, hsRaw, latRaw] = await Promise.all([
      env.PS99_KV.get('price-state'),
      env.PS99_KV.get('hatch-state'),
      env.PS99_KV.get('latest'),
    ]);
    const ps  = psRaw  ? JSON.parse(psRaw)  : {};
    const hs  = hsRaw  ? JSON.parse(hsRaw)  : {};
    const lat = latRaw ? JSON.parse(latRaw) : {};
    const pSnaps = (ps.snaps||[]).length;
    return ok({
      status:              'ok',
      state_version:       ps.ver,
      price_snapshots:     pSnaps,
      hatch_snapshots:     (hs.snaps||[]).length,
      price_keys:          (ps.keys||[]).length,
      hatch_pets:          (hs.keys||[]).length,
      price_state_kb:      psRaw ? Math.round(psRaw.length/1024) : 0,
      hatch_state_kb:      hsRaw ? Math.round(hsRaw.length/1024) : 0,
      // Accurate projection: keys array is fixed overhead, each snap is incremental
      projected_288snap_kb: pSnaps > 0
        ? Math.round((
            psRaw.length/1024                          // current total
            - (psRaw.length/1024/pSnaps) * pSnaps      // minus snap portion
            + (psRaw.length/1024/pSnaps) * PRICE_SNAPS // plus 288 snaps worth
          ))
        : 0,
      latest_ts:           lat.ts ? new Date(lat.ts).toISOString() : null,
    }, false);
  }

  if (path === '/seed') {
    ctx.waitUntil(handleCron(env));
    return ok({ status:'ok', message:'Seeding…' }, false);
  }

  if (path === '/reset') {
    // Delete all known KV keys then run cron synchronously
    await Promise.all([
      env.PS99_KV.delete('price-state'),
      env.PS99_KV.delete('hatch-state'),
      env.PS99_KV.delete('latest'),
      env.PS99_KV.delete('state'),
      env.PS99_KV.delete('payload:all'),
      env.PS99_KV.delete('price-buffer'),
      env.PS99_KV.delete('hatch-buffer'),
    ]);
    await handleCron(env);
    return ok({ status:'ok', message:'Reset complete.' }, false);
  }

  // /debug — inspect raw API counts without storing anything
  if (path === '/debug') {
    const [rapRes, exRes, petsRes] = await Promise.all([
      fetch(API_RAP).then(r => r.json()),
      fetch(API_EXISTS).then(r => r.json()),
      fetch(API_PETS).then(r => r.json()),
    ]);
    const excl = new Set();
    for (const p of (petsRes.data||[])) {
      if (p.configData?.rarity?.RarityNumber === 999) excl.add(p.configName);
    }
    const rapExcl     = rapRes.data.filter(d => excl.has(d.configData.id)).length;
    const hatchExcl   = exRes.data.filter(d => d.category==='Pet' && excl.has(d.configData.id) && !d.configData.pt && !d.configData.sh && !d.configData.tn).length;
    return ok({
      exclusive_pet_names: excl.size,
      rap_items_total:     rapRes.data.length,
      rap_exclusive:       rapExcl,
      hatch_exclusive_normal: hatchExcl,
      projected_price_kb:  Math.round(rapExcl * 288 * 10 / 1024),
      projected_hatch_kb:  Math.round(hatchExcl * 2016 * 8 / 1024),
    }, false);
  }

  // Edge cache
  const cache    = caches.default;
  const cacheKey = new Request('https://ps99-edge.internal/all');
  let   cached   = await cache.match(cacheKey);

  if (!cached) {
    const [psRaw, hsRaw, latRaw] = await Promise.all([
      env.PS99_KV.get('price-state'),
      env.PS99_KV.get('hatch-state'),
      env.PS99_KV.get('latest'),
    ]);
    let payload;
    if (!latRaw) {
      ctx.waitUntil(handleCron(env));
      const [rr, er] = await Promise.all([
        fetch(API_RAP).then(r => r.json()),
        fetch(API_EXISTS).then(r => r.json()),
      ]);
      payload = { status:'ok', ts:Date.now(), rap:rr.data, exists:er.data,
        history:{ count:0, data:[] }, hatch:{ count:0, petMeta:{}, snapshots:[] } };
    } else {
      const ps = psRaw ? JSON.parse(psRaw) : { keys:[], snaps:[] };
      const hs = hsRaw ? JSON.parse(hsRaw) : { keys:[], meta:[], snaps:[] };
      payload = expand(ps, hs, JSON.parse(latRaw));
    }
    const body = JSON.stringify(payload);
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { ...CORS, 'Cache-Control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}` },
    })));
    cached = new Response(body, { headers: CORS });
  }

  if (path === '/all') return cached;
  const p = await cached.json();
  const h = { headers: { ...CORS, 'Cache-Control': `public, max-age=${CACHE_TTL}` } };
  if (path === '/latest')        return new Response(JSON.stringify({ status:'ok', ts:p.ts, rap:p.rap, exists:p.exists }), h);
  if (path === '/history')       return new Response(JSON.stringify({ status:'ok', ...p.history }), h);
  if (path === '/hatch-history') return new Response(JSON.stringify({ status:'ok', count:p.hatch.count, petMeta:p.hatch.petMeta, snapshots:p.hatch.snapshots }), h);
  return new Response(JSON.stringify({ error:'Not found' }), { status:404, headers:CORS });
}

export default {
  fetch: async (req, env, ctx) => {
    try { return await handleFetch(req, env, ctx); }
    catch (e) { return new Response(JSON.stringify({error:e.message}), {status:500, headers:CORS}); }
  },
  scheduled: async (_e, env) => {
    try { await handleCron(env); }
    catch (e) { console.error('[cron]', e.message); }
  },
};
