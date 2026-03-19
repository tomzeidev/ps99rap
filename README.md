# PS99 RAP — Deployment Guide

## Option A — Netlify Drop (fastest, no account needed)

1. Go to **https://app.netlify.com/drop**
2. Drag the entire `ps99rap-deploy/` folder onto the page
3. You get a live URL instantly (e.g. `https://random-name-123.netlify.app`)
4. Optional: claim a free account to rename it to something like `ps99rap.netlify.app`

That's it. No build step, no config. Netlify serves `index.html` automatically.

---

## Option B — GitHub Pages (free, custom domain possible)

```bash
# 1. Create a new repo on github.com, then:
git init
git add index.html netlify.toml
git commit -m "initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/ps99rap.git
git push -u origin main

# 2. In GitHub → repo Settings → Pages
#    Source: Deploy from branch → main → / (root)
#    Save → live at https://YOUR_USERNAME.github.io/ps99rap/
```

---

## Option C — Cloudflare Pages (fastest CDN globally)

1. Push to a GitHub repo (steps above)
2. Go to **https://pages.cloudflare.com** → Create a project → Connect to Git
3. Select your repo, leave build settings blank (no framework)
4. Deploy → live at `https://ps99rap.pages.dev`

Cloudflare also lets you attach a free custom domain.

---

## ⚠️ About history data points

Currently history is stored in **each visitor's `localStorage`**. This means:
- Every user starts with 0 history and accumulates their own
- Data is lost if they clear their browser storage
- You don't get a shared "global" history

### To get shared server-side history

You'd need a small backend that polls the API and stores snapshots. The simplest free option:

**Cloudflare Worker + KV (free tier: 100k reads/day, 1k writes/day)**

```js
// worker.js — runs on Cloudflare's edge, polls every 5 min via a Cron Trigger
export default {
  async scheduled(event, env, ctx) {
    const [rap, exists] = await Promise.all([
      fetch('https://ps99.biggamesapi.io/api/rap').then(r => r.json()),
      fetch('https://ps99.biggamesapi.io/api/exists').then(r => r.json()),
    ]);
    const snap = { ts: Date.now(), rap: rap.data, exists: exists.data };
    const key = `snap_${Date.now()}`;
    await env.PS99_KV.put(key, JSON.stringify(snap));
  },

  async fetch(request, env) {
    // Return last N snapshots to the frontend
    const list = await env.PS99_KV.list({ limit: 72 });
    const snaps = await Promise.all(
      list.keys.map(k => env.PS99_KV.get(k.name, 'json'))
    );
    return new Response(JSON.stringify(snaps.filter(Boolean)), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};
```

Then in `index.html`, replace the localStorage history load with a fetch to your worker URL.

---

## Current snapshot interval

The site is set to **30 seconds** for testing (`MIN_INT = 30 * 1000`).

Change line in `index.html` before going to production:
```js
const MIN_INT = 20 * 60 * 1000; // 20 minutes
```
