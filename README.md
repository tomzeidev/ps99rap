# PS99 RAP — Deploy Guide

Two things to deploy:
1. **Cloudflare Worker** — polls the API every 5 min, stores history server-side
2. **GitHub Pages** — hosts the frontend (free, static)

Total time: ~10 minutes.

---

## Prerequisites (install once)

```bash
# Node.js required — https://nodejs.org (LTS version)
node -v   # should print v18 or higher

# Install Wrangler (Cloudflare's CLI)
npm install -g wrangler
```

---

## Step 1 — Push the repo to GitHub

Go to **https://github.com/new** and create a repo called `ps99rap` (public, no README).

Then in your terminal, `cd` into this folder and run:

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ps99rap.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

---

## Step 2 — Deploy the Cloudflare Worker

### 2a. Log in to Cloudflare

```bash
wrangler login
```

This opens a browser window — just click Allow.

### 2b. Create the KV namespace

```bash
wrangler kv:namespace create PS99_KV
```

This prints something like:
```
{ binding = "PS99_KV", id = "abc123def456..." }
```

Copy that `id` value and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PS99_KV"
id      = "abc123def456..."   # ← paste here
```

### 2c. Deploy the worker

```bash
npm install
npm run deploy:worker
```

It will print your worker URL, something like:
```
https://ps99rap-worker.YOUR_SUBDOMAIN.workers.dev
```

**Copy this URL.**

---

## Step 3 — Wire the worker URL into the frontend

Open `index.html` and find line ~420:

```js
const WORKER_URL = 'REPLACE_WITH_YOUR_WORKER_URL';
```

Replace it with your actual worker URL:

```js
const WORKER_URL = 'https://ps99rap-worker.YOUR_SUBDOMAIN.workers.dev';
```

Save, then push the change:

```bash
git add index.html
git commit -m "add worker URL"
git push
```

---

## Step 4 — Enable GitHub Pages

1. Go to your repo on GitHub
2. **Settings → Pages**
3. Under *Source* → **Deploy from a branch**
4. Branch: `main`, folder: `/ (root)` → **Save**

After ~1 minute your site is live at:
```
https://YOUR_USERNAME.github.io/ps99rap/
```

---

## How it works

```
Browser  ──GET /latest──▶  Cloudflare Worker  ──▶  Big Games API
Browser  ──GET /history──▶  Cloudflare Worker  ──▶  KV Store

Cron (every 5 min):
  Cloudflare Worker  ──▶  Big Games API  ──▶  KV Store (appends snapshot)
```

- History is **shared and server-side** — every visitor sees the same data
- Up to **288 snapshots** (24 hours at 5-min intervals), then rolling
- The worker's free tier covers ~100k KV reads/day — more than enough

---

## Optional: Custom domain

In Cloudflare Pages or GitHub Pages settings you can attach your own domain (e.g. `ps99rap.com`) for free. Cloudflare handles SSL automatically.

---

## Changing the poll interval

In `wrangler.toml`:
```toml
crons = ["*/5 * * * *"]   # every 5 min — change to "*/1 * * * *" for every minute
```

Redeploy with `npm run deploy:worker` after changing.
