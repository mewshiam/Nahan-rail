# Nahan on Railway 🚂

**[Nahan](https://github.com/itsyebekhe/nahan)** (نهان — Persian for *Hidden*) is a VLESS/Trojan
proxy gateway with a beautiful multi-user dashboard, originally built for
**Cloudflare Workers**. This repository ports it — **without modifying a single
line of the upstream worker code** — so it runs on **[Railway](https://railway.com)**
(any Node.js 20+ host works too).

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/new/template?template=https://github.com/mewshiam/Nahan-rail)
[![Upstream](https://img.shields.io/badge/upstream-itsyebekhe%2Fnahan-222?style=flat-square&logo=github)](https://github.com/itsyebekhe/nahan)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

> ℹ️ The original Cloudflare Workers deployment guide is preserved in
> [README-CLOUDFLARE.md](./README-CLOUDFLARE.md) · راهنمای فارسی: [README_FA.md](./README_FA.md)

---

## ✨ What you get

Everything the Cloudflare version offers, on Railway:

| Feature | Notes |
|---|---|
| 🔐 VLESS & Trojan | both protocols over WebSocket, TLS provided by Railway's edge |
| 🖥️ Full dashboard | served from this repo (self-contained, no GitHub fetch needed) |
| 💾 Persistent config | SQLite (D1-compatible shim) — attach a Railway volume to survive redeploys |
| 🌍 Clean IP multiplexer, NAT64, ECH | all client-config features work |
| 👥 Multi-user profiles | per-user subscriptions, limits, nodes |
| 🤖 Telegram bot | full gateway management via bot |
| 🚨 Kill switch | pause all proxy traffic instantly |
| 📊 Usage tracking | per-user bandwidth/request accounting |

---

## 🚀 Deploy to Railway

The whole infrastructure is declared as code in **[`.railway/railway.ts`](./.railway/railway.ts)**
(Railway Infrastructure as Code) — service, volume, environment variables,
healthcheck — and **[`deploy.sh`](./deploy.sh)** provisions it with **one command**,
public domain included. No dashboard clicking required.

### One command (recommended)

```bash
git clone https://github.com/mewshiam/Nahan-rail
cd Nahan-rail
bash deploy.sh
```

`deploy.sh` is **idempotent** — safe to re-run — and creates all of this:

| Step | What is created | Detail |
|---|---|---|
| 1 | Railway CLI | installed globally via npm if missing |
| 2 | Login | `railway login` (or your `RAILWAY_TOKEN` in CI) |
| 3 | Project | created & linked (or pass `--project <name>` to reuse one) |
| 4 | Service `nahan` | via `railway config apply` — Dockerfile build, `start`, healthcheck `/_health` |
| 5 | Volume `nahan-data` | **512 MB mounted at `/data`** — the SQLite database survives redeploys |
| 6 | Port | `PORT` injected by Railway — the app binds `0.0.0.0:$PORT` automatically |
| 7 | Domain | **free `https://<name>.up.railway.app`** via `railway domain` |
| 8 | Deployment | builds from the GitHub source (see below) |

Useful flags:

```bash
bash deploy.sh --up                        # push local code with `railway up` instead of the GitHub source
bash deploy.sh --project my-existing-proj  # adopt an existing Railway project
bash deploy.sh --domain nahan.example.com  # custom domain instead of *.up.railway.app
RAILWAY_TOKEN=… bash deploy.sh             # CI / non-interactive (project token)
```

> **Private repo?** The `source` in `.railway/railway.ts` points at this
> private repository, so grant Railway's GitHub App access **once**:
> Railway → Account Settings → Integrations → GitHub → *Edit Scope*.
> Don't want that? Run `bash deploy.sh --up` — it uploads the code directly.

### From the dashboard (no CLI)

1. In Railway: **New Project → Deploy from GitHub repo** → pick *Nahan-rail*.
2. **Name the service `nahan`** when you add it (so `.railway/railway.ts`
   adopts it — or edit the service name in that file to match yours).
3. Railway detects the `Dockerfile` automatically; `PORT` is injected for you.
4. Finish the rest (volume + env + domain) in one command:
   ```bash
   bash deploy.sh --project <your-project-name>
   ```
   Or manually: **Settings → Volumes → New Volume** (mount `/data`), then
   **Settings → Networking → Generate Domain**.

### CI — apply the infra on merge

`.github/workflows/railway-config.yml` plans `.railway/` changes on PRs and
applies them on merge, once you add the `RAILWAY_TOKEN` repository secret
(project token scoped to production). After that, `git push` is your entire
deploy pipeline: infra changes **and** code both ship automatically.

### One-click button

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/new/template?template=https://github.com/mewshiam/Nahan-rail)

> The button creates a *template* deployment — it needs the repo to be public,
> and it does **not** attach the volume/domain automatically the way
> `deploy.sh` does. Prefer the one command above.

> Tip: Railway's free trial / hobby pricing covers this tiny service easily —
> the gateway idles at a few MB of RAM and no CPU.

---

## ⚙️ Environment variables

`NODE_ENV` and `DATA_DIR=/data` are preset by `.railway/railway.ts`; `PORT` is
injected by Railway itself. The rest is optional:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ✅ (auto-set by Railway) | `3000` | Listen port — injected by Railway, don't set it manually. |
| `RELAY_IP` | — | unset | Default relay/proxy IP (same as wrangler `[vars] RELAY_IP` on Cloudflare). Also configurable later from the dashboard. |
| `DASHBOARD_URL` | — | bundled `dashboard.html` | Override the dashboard HTML source. |
| `SUBSCRIPTION_URL` | — | bundled `subscription.html` | Override the subscription page HTML source. |
| `DATA_DIR` | — | Railway volume, else `./data` | Where `nahan.db` (SQLite) is stored. |
| `SCHEDULED_INTERVAL_MIN` | — | `60` | How often the Workers cron (auto-update check) is emulated. |
| `WORKER_FILE` | — | `_worker.js` | Use a different worker source file (e.g. a newer upstream drop). |
| `NAHAN_DEBUG` | — | unset | Set to `1` to log socket/ WebSocket lifecycle for troubleshooting. |

---

## 📖 First run (same as upstream)

1. Open **`https://<your-app>.up.railway.app/sync/dash`**
   (visiting `/` shows the Ubuntu/Docker camouflage page — that's intentional).
2. Log in with the default master key: **`admin`**.
3. Immediately in **System**:
   - change the **Master Key**,
   - change **API Route** to a secret path (bookmark the new URL!),
   - set or auto-generate the **Device UUID**.
4. Click **Update Config**.

Client connection URIs, QR codes and subscription links are shown in the
**Endpoints** tab — e.g. `vless://<uuid>@<your-app>.up.railway.app:443?...`.

Full usage documentation: [HELP.md](./HELP.md) · [README-CLOUDFLARE.md](./README-CLOUDFLARE.md)

---

## 🔧 How the port works

```
                ┌────────────────────────────────────────────────┐
 browser/       │  Node.js HTTP server (railway/server.js)       │  TCP
 vless client ──┤  • Request/Response bridging (WHATWG <-> Node)  ├─────────► upstream
     wss://     │  • WebSocket upgrades via `ws`                  │  (net)
                │  • /_health endpoint for Railway healthchecks   │
                ├────────────────────────────────────────────────┤
                │  runtime shims (railway/*.js)                   │
                │  • cloudflare:sockets  → node:net + WebStreams  │
                │  • WebSocketPair       → ws-backed pair shim    │
                │  • D1 (IOT_DB)         → better-sqlite3         │
                │  • Response{101,ws}    → patched global         │
                │  • cron trigger        → setInterval            │
                ├────────────────────────────────────────────────┤
                │  _worker.js  (UPSTREAM CODE — UNMODIFIED)       │
                │  imported as worker.mjs with one import rewrite │
                └────────────────────────────────────────────────┘
```

At startup `railway/server.js`:

1. patches the global `Response` and installs `WebSocketPair`,
2. generates `worker.mjs` from `_worker.js`, rewriting the single
   `import { connect } from "cloudflare:sockets"` to the Node shim
   (everything else in the 11k-line worker is standard Web API code that
   Node 20+ already implements),
3. binds `0.0.0.0:${PORT}` and forwards every HTTP request and WebSocket
   upgrade to the worker's `fetch()` handler,
4. serves `env.IOT_DB` from a D1-compatible shim over SQLite.

### Differences vs the Cloudflare deployment

- **Geo/colo metadata** (`request.cf`) doesn't exist off-Cloudflare — the
  dashboard shows `Unknown` for country/city/ASN/colo. Everything else works.
- **Auto-update** targets Cloudflare Workers via the CF API; on Railway, updates
  arrive by redeploying this repo (git push). The scheduled task still runs so
  linked-panel/telegram features keep working.
- **Persistence** uses SQLite via an attached volume instead of Cloudflare D1.
- **Outbound TCP** uses the Railway host's network directly (no Cloudflare egress).

### Updating from upstream

```bash
git remote add upstream https://github.com/itsyebekhe/nahan   # once
git fetch upstream && git merge upstream/main
git push
```

Railway redeploys automatically; the port layer only depends on the worker's
documented API surface (fetch handler, `cloudflare:sockets`, `WebSocketPair`,
D1 `prepare/bind/first/all/run`), which has been stable across releases.

---

## 🛠️ Local development

```bash
npm install        # installs ws + better-sqlite3
npm start          # serves on http://127.0.0.1:3000
# dashboard: http://127.0.0.1:3000/sync/dash  (default key: admin)

# with debug tracing of sockets/websockets:
NAHAN_DEBUG=1 npm start

# custom port:
PORT=8080 npm start
```

## 🐳 Docker (any host)

```bash
docker build -t nahan-rail .
docker run -p 3000:3000 -v nahan-data:/data nahan-rail
```

The container binds `0.0.0.0:${PORT}` (defaults to 3000) and stores its
database in `/data` when a volume is mounted there.

---

## 📄 License & credits

MIT — see [LICENSE](./LICENSE).

- **Original project:** [itsyebekhe/nahan](https://github.com/itsyebekhe/nahan) — all proxy logic,
  dashboard, and protocol handling are the upstream authors' work, kept untouched.
- **Railway port:** the `railway/` adapter in this repository.
