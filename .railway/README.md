# `.railway/` — Railway Infrastructure as Code

This folder holds the Railway project definition for **Nahan on Railway**.

| File | Purpose |
|---|---|
| `railway.ts` | The whole project as code: the `nahan` service, the `nahan-data` volume mounted at `/data`, environment variables, start command and healthcheck. |
| *(link files)* | `railway link` / `railway init` write the local project link into this folder as well — they are gitignored on purpose (machine-specific). |

## Quick start

```bash
bash deploy.sh        # does everything below (plus the public domain)
```

## Manually

```bash
npm install           # pulls the `railway` SDK used to evaluate railway.ts
railway login         # once
railway init --name nahan   # or: railway link --project <existing>
railway config plan   # preview: "+ Create service nahan", "+ Create volume nahan-data"
railway config apply  # provision it
railway domain        # generate the free https://<name>.up.railway.app URL
railway up            # (only if you removed `source` from railway.ts) push local code
```

## What is *not* in `railway.ts`

- **`PORT`** — injected by Railway on every deploy; the app binds `0.0.0.0:$PORT` automatically.
- **The generated `*.up.railway.app` domain** — Railway-owned, created with `railway domain` (deploy.sh does this). Custom domains *can* be declared: add `domains: ["proxy.example.com"]` to the service.
- **Secrets you change in the dashboard later** — e.g. `RELAY_IP` — set them with `railway variables set RELAY_IP=…` or add them to `env` in `railway.ts`.

## Notes

- The old `railway.json` (Config-as-Code) was removed — it is deprecated and a service cannot be managed by both systems. Everything it configured now lives in `railway.ts`.
- Re-running `railway config apply` is safe: it diffs the file against the live environment and only applies the difference (growing the volume is non-destructive).
- CI: `.github/workflows/railway-config.yml` plans on PRs and applies on merge once the `RAILWAY_TOKEN` repository secret is set.

Docs: <https://docs.railway.com/infrastructure-as-code>
