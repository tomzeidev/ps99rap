/**
 * PS99 RAP Worker
 *
 * Goals:
 * - Keep data fresh with a 30-second revalidation window.
 * - Persist compact history in KV.
 * - Prebuild the full /all payload during cron and revalidate on demand when stale.
 * - Keep request handlers as close to O(1) as possible.
 */

const API_RAP = 'https://ps99.biggamesapi.io/api/rap';
const API_EXISTS = 'https://ps99.biggamesapi.io/api/exists';
const API_PETS = 'https://ps99.biggamesapi.io/api/collection/Pets';

const PRICE_SNAPS = 288;
const HATCH_SNAPS = 2016;
const CACHE_TTL = 30;
const STATE_VER = 8;
const MAX_DATA_AGE_MS = 30 * 1000;

const KV_KEYS = {
  priceState: 'price-state',
  hatchState: 'hatch-state',
  latest: 'latest',
  all: 'payload:all',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

let refreshInFlight = null;

const jsonHeaders = (cache = true) => ({
  ...CORS,
  'Cache-Control': cache
    ? `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`
    : 'no-store',
});

function jsonResponse(data, cache = true, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders(cache),
  });
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mergeKey(d) {
  const c = d.configData || {};
  return `${d.category}|${c.id}|${c.pt || 0}|${c.tn || 0}|${c.sh ? 1 : 0}`;
}

function parseState(raw, kind) {
  const fallback = kind === 'price'
    ? { ver: STATE_VER, keys: [], snaps: [] }
    : { ver: STATE_VER, keys: [], meta: [], snaps: [] };

  const state = safeParse(raw, fallback);
  const keyLimit = kind === 'price' ? 3000 : 1000;

  if (!state || state.ver !== STATE_VER || !Array.isArray(state.keys) || state.keys.length > keyLimit) {
    return fallback;
  }

  if (!Array.isArray(state.snaps)) state.snaps = [];
  if (kind === 'price') {
    if (!Array.isArray(state.meta)) state.meta = [];
  } else {
    if (!Array.isArray(state.meta)) state.meta = [];
  }

  return state;
}

function getOrAddKey(state, key, map) {
  let idx = map.get(key);
  if (idx === undefined) {
    idx = state.keys.length;
    state.keys.push(key);
    map.set(key, idx);
  }
  return idx;
}

async function fetchJson(url, label, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${label} HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.status !== 'ok' || !Array.isArray(data.data)) {
      throw new Error(`${label} returned unexpected payload`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function buildExclusivePetSet(petsData) {
  const exclusiveNames = new Set();
  for (const pet of petsData || []) {
    if (pet?.configData?.rarity?.RarityNumber === 999) {
      exclusiveNames.add(pet.configName);
    }
  }
  return exclusiveNames;
}

function buildExpandedPayload(ps, hs, latest) {
  const historyData = ps.snaps.map((snap) => {
    const d = {};
    for (const [ki, v] of Object.entries(snap.d || {})) {
      d['r|' + ps.keys[ki]] = v;
    }
    return { ts: snap.ts, d };
  });

  const petMeta = {};
  for (let i = 0; i < hs.keys.length; i++) {
    const meta = hs.meta[i];
    if (meta) petMeta[hs.keys[i]] = meta;
  }

  const hatchSnapshots = hs.snaps.map((snap) => {
    const d = {};
    for (const [ki, v] of Object.entries(snap.d || {})) {
      d[hs.keys[ki]] = v;
    }
    return { ts: snap.ts, d };
  });

  return {
    status: 'ok',
    ts: latest.ts,
    rap: latest.rap,
    exists: latest.exists,
    history: {
      count: historyData.length,
      retention_days: Math.round((PRICE_SNAPS * 5 / 1440) * 10) / 10,
      data: historyData,
    },
    hatch: {
      count: hatchSnapshots.length,
      petMeta,
      snapshots: hatchSnapshots,
    },
  };
}

async function loadStates(env) {
  const [psRaw, hsRaw, latestRaw, allRaw] = await Promise.all([
    env.PS99_KV.get(KV_KEYS.priceState),
    env.PS99_KV.get(KV_KEYS.hatchState),
    env.PS99_KV.get(KV_KEYS.latest),
    env.PS99_KV.get(KV_KEYS.all),
  ]);

  return {
    ps: parseState(psRaw, 'price'),
    hs: parseState(hsRaw, 'hatch'),
    latest: safeParse(latestRaw, null),
    allRaw,
  };
}

async function persistStates(env, ps, hs, latest, allPayload) {
  await Promise.all([
    env.PS99_KV.put(KV_KEYS.priceState, JSON.stringify(ps)),
    env.PS99_KV.put(KV_KEYS.hatchState, JSON.stringify(hs)),
    env.PS99_KV.put(KV_KEYS.latest, JSON.stringify(latest)),
    env.PS99_KV.put(KV_KEYS.all, allPayload),
  ]);
}

function isPayloadStale(latestRaw, maxAgeMs = MAX_DATA_AGE_MS) {
  const latest = safeParse(latestRaw, null);
  if (!latest?.ts) return true;
  return (Date.now() - latest.ts) > maxAgeMs;
}

async function refreshOnce(env) {
  if (!refreshInFlight) {
    refreshInFlight = refreshFromApis(env).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refreshFromApis(env) {
  const [rapRes, exRes, petsRes] = await Promise.all([
    fetchJson(API_RAP, 'rap'),
    fetchJson(API_EXISTS, 'exists'),
    fetchJson(API_PETS, 'pets'),
  ]);

  const exclusiveNames = buildExclusivePetSet(petsRes.data);
  const ts = Date.now();

  const { ps, hs } = await loadStates(env);
  const psMap = new Map(ps.keys.map((k, i) => [k, i]));
  const hsMap = new Map(hs.keys.map((k, i) => [k, i]));
  const hsSeen = new Set(hs.keys.map((_, i) => i));

  const priceSnap = { ts, d: {} };
  for (const item of rapRes.data) {
    if (item?.value == null) continue;
    if (!exclusiveNames.has(item?.configData?.id)) continue;
    priceSnap.d[getOrAddKey(ps, mergeKey(item), psMap)] = item.value;
  }
  ps.snaps.push(priceSnap);
  if (ps.snaps.length > PRICE_SNAPS) ps.snaps = ps.snaps.slice(-PRICE_SNAPS);

  const hatchSnap = { ts, d: {} };
  for (const item of exRes.data) {
    if (item?.category !== 'Pet') continue;
    if (item?.value == null) continue;

    const c = item.configData || {};
    if (!exclusiveNames.has(c.id)) continue;
    if (c.pt || c.sh || c.tn) continue;

    const key = mergeKey(item);
    const idx = getOrAddKey(hs, key, hsMap);
    if (!hsSeen.has(idx)) {
      hsSeen.add(idx);
      hs.meta.push({ id: c.id, pt: 0, tn: 0, sh: false });
    }
    hatchSnap.d[idx] = item.value;
  }
  hs.snaps.push(hatchSnap);
  if (hs.snaps.length > HATCH_SNAPS) hs.snaps = hs.snaps.slice(-HATCH_SNAPS);

  const latest = {
    status: 'ok',
    ts,
    rap: rapRes.data,
    exists: exRes.data,
  };

  const allPayloadObj = buildExpandedPayload(ps, hs, latest);
  const allPayload = JSON.stringify(allPayloadObj);

  await persistStates(env, ps, hs, latest, allPayload);

  return {
    latest,
    allPayload,
    stats: {
      priceSnapshots: ps.snaps.length,
      priceKeys: ps.keys.length,
      hatchSnapshots: hs.snaps.length,
      hatchKeys: hs.keys.length,
      allKB: Math.round(allPayload.length / 1024),
    },
  };
}

async function getAllPayload(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://ps99-edge.internal/all');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [latestRaw, allRaw] = await Promise.all([
    env.PS99_KV.get(KV_KEYS.latest),
    env.PS99_KV.get(KV_KEYS.all),
  ]);

  if (!allRaw || isPayloadStale(latestRaw)) {
    await refreshOnce(env);
    const rebuilt = await env.PS99_KV.get(KV_KEYS.all);
    if (!rebuilt) throw new Error('Payload unavailable after refresh');
    const response = new Response(rebuilt, { headers: jsonHeaders(true) });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const response = new Response(allRaw, { headers: jsonHeaders(true) });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function responseFromLatest(latestRaw) {
  const latest = safeParse(latestRaw, null);
  return jsonResponse(latest || { status: 'ok', ts: null, rap: [], exists: [] });
}

async function handleCron(env) {
  const result = await refreshFromApis(env);
  console.log(`[cron] price: ${result.stats.priceSnapshots} snaps, ${result.stats.priceKeys} keys`);
  console.log(`[cron] hatch: ${result.stats.hatchSnapshots} snaps, ${result.stats.hatchKeys} keys`);
  console.log(`[cron] payload: ${result.stats.allKB}KB`);
}

async function handleFetch(req, env, ctx) {
  const path = new URL(req.url).pathname;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (path === '/status') {
    const [psRaw, hsRaw, latRaw] = await Promise.all([
      env.PS99_KV.get(KV_KEYS.priceState),
      env.PS99_KV.get(KV_KEYS.hatchState),
      env.PS99_KV.get(KV_KEYS.latest),
    ]);
    const ps = parseState(psRaw, 'price');
    const hs = parseState(hsRaw, 'hatch');
    const lat = safeParse(latRaw, {});
    const pSnaps = ps.snaps.length;

    return jsonResponse({
      status: 'ok',
      state_version: ps.ver,
      price_snapshots: pSnaps,
      hatch_snapshots: hs.snaps.length,
      price_keys: ps.keys.length,
      hatch_pets: hs.keys.length,
      price_state_kb: psRaw ? Math.round(psRaw.length / 1024) : 0,
      hatch_state_kb: hsRaw ? Math.round(hsRaw.length / 1024) : 0,
      projected_288snap_kb: pSnaps > 0
        ? Math.round((psRaw.length / 1024) - ((psRaw.length / 1024 / pSnaps) * pSnaps) + ((psRaw.length / 1024 / pSnaps) * PRICE_SNAPS))
        : 0,
      latest_ts: lat.ts ? new Date(lat.ts).toISOString() : null,
    }, false);
  }

  if (path === '/seed') {
    ctx.waitUntil(handleCron(env));
    return jsonResponse({ status: 'ok', message: 'Seeding…' }, false);
  }

  if (path === '/reset') {
    await Promise.all([
      env.PS99_KV.delete(KV_KEYS.priceState),
      env.PS99_KV.delete(KV_KEYS.hatchState),
      env.PS99_KV.delete(KV_KEYS.latest),
      env.PS99_KV.delete(KV_KEYS.all),
    ]);
    await handleCron(env);
    return jsonResponse({ status: 'ok', message: 'Reset complete.' }, false);
  }

  if (path === '/debug') {
    const [rapRes, exRes, petsRes] = await Promise.all([
      fetchJson(API_RAP, 'rap'),
      fetchJson(API_EXISTS, 'exists'),
      fetchJson(API_PETS, 'pets'),
    ]);
    const excl = buildExclusivePetSet(petsRes.data);
    const rapExcl = rapRes.data.filter((d) => excl.has(d?.configData?.id)).length;
    const hatchExcl = exRes.data.filter((d) => (
      d?.category === 'Pet' &&
      excl.has(d?.configData?.id) &&
      !d?.configData?.pt &&
      !d?.configData?.sh &&
      !d?.configData?.tn
    )).length;

    return jsonResponse({
      exclusive_pet_names: excl.size,
      rap_items_total: rapRes.data.length,
      rap_exclusive: rapExcl,
      hatch_exclusive_normal: hatchExcl,
      projected_price_kb: Math.round((rapExcl * 288 * 10) / 1024),
      projected_hatch_kb: Math.round((hatchExcl * HATCH_SNAPS * 8) / 1024),
    }, false);
  }

  if (path === '/all') {
    return await getAllPayload(env, ctx);
  }

  if (path === '/latest' || path === '/history' || path === '/hatch-history') {
    const [latestRaw, allRaw] = await Promise.all([
      env.PS99_KV.get(KV_KEYS.latest),
      env.PS99_KV.get(KV_KEYS.all),
    ]);

    if (!allRaw || isPayloadStale(latestRaw)) {
      await refreshOnce(env);
    }

    const freshLatestRaw = await env.PS99_KV.get(KV_KEYS.latest);
    const freshAllRaw = await env.PS99_KV.get(KV_KEYS.all);

    if (path === '/latest') {
      return responseFromLatest(freshLatestRaw);
    }

    if (!freshAllRaw) {
      throw new Error('Unable to rebuild payload');
    }

    const payload = safeParse(freshAllRaw, {});
    if (path === '/history') {
      return jsonResponse({ status: 'ok', ...(payload.history || { count: 0, data: [] }) });
    }
    return jsonResponse({
      status: 'ok',
      count: payload.hatch?.count || 0,
      petMeta: payload.hatch?.petMeta || {},
      snapshots: payload.hatch?.snapshots || [],
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: CORS,
  });
}

export default {
  fetch: async (req, env, ctx) => {
    try {
      return await handleFetch(req, env, ctx);
    } catch (e) {
      console.error('[fetch]', e);
      return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), {
        status: 500,
        headers: CORS,
      });
    }
  },
  scheduled: async (_event, env) => {
    try {
      await handleCron(env);
    } catch (e) {
      console.error('[cron]', e);
    }
  },
};
