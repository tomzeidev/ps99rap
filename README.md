# PS99 RAP — Deploy Guide

## What you need
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) (LTS) installed
- Your existing GitHub repo with `index.html` already live on GitHub Pages

---

## Part 1 — Deploy the Cloudflare Worker (≈5 min)

### 1. Open a terminal in this folder

```bash
cd ps99rap-repo
```

### 2. Install Wrangler

```bash
npm install
```

### 3. Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens → click **Allow**. Come back to the terminal.

### 4. Create the KV namespace

```bash
npx wrangler kv namespace create PS99_KV
```

The output will look like this:

```
Add the following to your configuration file in your kv_namespaces array:
{ binding = "PS99_KV", id = "abc123def456abc123def456abc123de" }
```

Copy **only the id value** (the long hex string).

Open `wrangler.toml` and paste it in:

```toml
[[kv_namespaces]]
binding = "PS99_KV"
id      = "abc123def456abc123def456abc123de"   ← your id here
```

### 5. Deploy the worker

```bash
npx wrangler deploy
```

Output will include your worker URL:

```
Published ps99rap-worker (0.09 sec)
https://ps99rap-worker.YOUR_SUBDOMAIN.workers.dev
```

Copy that URL.

### 6. Verify it works

Open this in your browser (replace with your URL):

```
https://ps99rap-worker.YOUR_SUBDOMAIN.workers.dev/status
```

You should see JSON like:
```json
{ "status": "ok", "snapshots_total": 0, "retention_days": 30, ... }
```

`snapshots_total: 0` is fine — the cron hasn't run yet. If you see JSON, the worker is working.

---

## Part 2 — Wire the worker URL into the frontend (1 min)

Open `index.html` and find this line near the top of the `<script>` block:

```js
const WORKER_URL = 'REPLACE_WITH_YOUR_WORKER_URL';
```

Replace it:

```js
const WORKER_URL = 'https://ps99rap-worker.YOUR_SUBDOMAIN.workers.dev';
```

Save, commit, and push:

```bash
git add index.html
git commit -m "connect worker"
git push
```

GitHub Pages will update within ~30 seconds.

---

## Part 3 — Force the first snapshot (optional)

The cron runs every 5 minutes automatically. If you want data immediately, trigger it manually:

```bash
npx wrangler dev
```

Then open: `http://localhost:8787/latest` — this wakes the worker and loads the first snapshot.

---

## Changing history retention

Open `worker/index.js` and change this line:

```js
const RETENTION_DAYS = 30;  // ← set to 7, 30, 90, etc.
```

Then redeploy:

```bash
npx wrangler deploy
```

**Cloudflare KV free tier limits:**
| Limit | Free |
|-------|------|
| Reads/day | 100,000 |
| Writes/day | 1,000 |
| Storage | 1 GB |

At 5-min intervals that's 288 writes/day + 288 reads/day per user — well within free limits.

---

## Troubleshooting

**`wrangler: command not found`**
→ Use `npx wrangler` instead of `wrangler` throughout

**`Error: id is required` when deploying**
→ You haven't pasted the KV namespace id into `wrangler.toml` yet (step 4)

**Worker URL returns an error page**
→ Run `npx wrangler tail` in your terminal, then refresh the URL — it prints live error logs

**Site loads but shows "history unavailable"**
→ Your `WORKER_URL` in `index.html` is still the placeholder — check Part 2

**CORS error in browser console**
→ The worker already sets `Access-Control-Allow-Origin: *` so this shouldn't happen.
  If it does, make sure you deployed *after* the latest code (re-run `npx wrangler deploy`)

**`/status` returns `snapshots_total: 0` after a few minutes**
→ The cron may not have fired yet in development. Run `npx wrangler dev` and hit `/latest`
  to trigger a manual snapshot, or just wait — it runs every 5 min in production.
