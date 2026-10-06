/**
 * Nahan on Railway — Infrastructure as Code
 * ==========================================
 *
 * This single file describes the *whole* Railway project for nahan:
 * the service, its persistent volume, environment variables and build/deploy
 * settings. `bash deploy.sh` (or `railway config apply`) provisions all of it —
 * domain included — so there is nothing to click through in the dashboard.
 *
 * What gets created / managed here:
 *   • service "nahan"            — built from this repo's Dockerfile
 *   • volume  "nahan-data"       — 512 MB, mounted at /data (SQLite DB persists
 *                                  across redeploys; Railway sets
 *                                  RAILWAY_VOLUME_MOUNT_PATH=/data for you)
 *   • PORT                        — injected by Railway, the app binds it
 *                                  automatically (never set it yourself)
 *   • env vars                    — NODE_ENV, DATA_DIR
 *   • healthcheck                 — GET /_health
 *
 * The free https://<name>.up.railway.app domain cannot be expressed in this
 * file (Railway manages it), so `deploy.sh` generates it with
 * `railway domain` right after applying this config.
 *
 * Requirements:
 *   npm install          # installs the `railway` SDK (dev dependency) used to
 *                        # evaluate this file
 *   railway login        # once
 *   railway config plan  # preview what this file would change
 *   railway config apply # create/update the resources
 *
 * Docs: https://docs.railway.com/infrastructure-as-code
 */

import { defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
    // ── Persistent storage ────────────────────────────────────────────────
    // nahan keeps users, settings and usage in a SQLite database. Attach it
    // to a volume so the data survives redeploys and restarts.
    // Grow it later by increasing sizeMB (a grow is non-destructive) and
    // re-running `railway config apply`.
    const data = volume("nahan-data", {
        sizeMB: 512,
    });

    // ── The gateway service ───────────────────────────────────────────────
    const app = service("nahan", {
        // Deploy straight from this GitHub repository: every `git push`
        // redeploys automatically.
        //
        // • This repo is private → grant Railway's GitHub App access once:
        //   Account Settings → Integrations → GitHub → Edit Scope.
        // • Prefer pushing code manually from your machine? Delete the
        //   `source` line (or run `bash deploy.sh --up`); `railway up`
        //   uploads the local directory and builds it with the Dockerfile.
        source: github("mewshiam/Nahan-rail", { branch: "main" }),

        // The Dockerfile at the repo root is picked up automatically; the
        // start command is spelled out for clarity (it matches Dockerfile CMD).
        start: "node railway/server.js",

        // Liveness probe served by the Node adapter — never touches the
        // worker, the database or the network.
        healthcheck: "/_health",
        healthcheckTimeout: 300,

        // Volume mount — the key is the in-container path. Railway injects
        // RAILWAY_VOLUME_MOUNT_PATH=/data, which railway/server.js prefers
        // automatically; DATA_DIR below is belt-and-braces.
        volumeMounts: {
            "/data": data,
        },

        // ── Environment variables ────────────────────────────────────────
        // NOTE: PORT is injected by Railway itself (config-as-code never
        // sets it) and the app binds 0.0.0.0:$PORT automatically.
        env: {
            NODE_ENV: "production",
            DATA_DIR: "/data",

            // Optional nahan settings — uncomment what you need, or set them
            // later from the dashboard / `railway variables set`:
            // RELAY_IP: "1.2.3.4",              // default relay/proxy IP
            // SCHEDULED_INTERVAL_MIN: "60",      // cron emulation interval
            // NAHAN_DEBUG: "1",                  // socket/ws lifecycle logs
        },
    });

    // ── The project ───────────────────────────────────────────────────────
    // Every resource that appears here is managed by this file; a resource
    // removed from this list is removed from Railway on the next apply.
    return project("nahan", {
        resources: [app, data],
    });
});
