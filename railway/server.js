#!/usr/bin/env node
/**
 * Nahan on Railway — Node.js runtime adapter
 * ==========================================
 *
 * Runs the unmodified Cloudflare Workers code (`_worker.js` from
 * https://github.com/itsyebekhe/nahan) on a plain Node.js HTTP server so it
 * can be deployed to Railway.com (or any Node 20+ host).
 *
 * How it works
 * ------------
 * 1. Patch the web globals the worker expects (`Response` with
 *    `status: 101 + webSocket`, `WebSocketPair`) — see ./response-patch.js.
 * 2. Generate `worker.mjs` from `_worker.js`, rewriting the single
 *    `import { connect } from "cloudflare:sockets"` to point at the Node
 *    `net`-based shim in ./cf-sockets.js.
 * 3. Serve HTTP: translate Node's IncomingMessage/ServerResponse into Web
 *    Request/Response and call the worker's `fetch(request, env, ctx)`.
 * 4. Serve WebSocket upgrades: when the worker answers a request with
 *    `Response { status: 101, webSocket }`, complete the handshake with the
 *    `ws` library and attach the real connection to the shim's pair.
 * 5. Provide `env.IOT_DB` — a D1-compatible API over better-sqlite3
 *    (./d1.js) — so all nahan settings/users/usage persist exactly like on
 *    Cloudflare D1.
 * 6. Emulate the Workers cron trigger by invoking `worker.scheduled()`
 *    every SCHEDULED_INTERVAL_MIN minutes.
 *
 * Environment variables
 * ---------------------
 *   PORT                        set by Railway (fallback 3000)
 *   DATA_DIR                    where nahan.db lives (default ./data, or the
 *                               Railway volume when one is attached)
 *   RELAY_IP                    optional default relay/proxy IP (same as the
 *                               wrangler [vars] RELAY_IP on Cloudflare)
 *   DASHBOARD_URL / SUBSCRIPTION_URL
 *                               override the bundled dashboard/subscription
 *                               HTML sources (defaults: files in this repo)
 *   WORKER_FILE                 alternative worker source (default _worker.js)
 *   SCHEDULED_INTERVAL_MIN      cron emulation interval (default 60)
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";

import { patchWebGlobals } from "./response-patch.js";
import { createD1Binding } from "./d1.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT) || 3000;
const LOG = "[nahan-rail]";
const log = (...args) => console.log(LOG, ...args);
const logError = (...args) => console.error(LOG, ...args);

/** Hop-by-hop / transport headers that must not be copied between layers. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    // undici decodes content-encoding and re-chunks bodies; forwarding the
    // origin's encoding/length headers would corrupt the response.
    "content-encoding",
    "content-length",
]);

const STATIC_FILES = new Set(["dashboard.html", "subscription.html"]);

const STATUS_TEXT = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
};

/* -------------------------------------------------------------------------- */
/* Worker module generation (_worker.js -> worker.mjs)                        */
/* -------------------------------------------------------------------------- */

function ensureWorkerModule() {
    const custom = process.env.WORKER_FILE;
    const src = custom
        ? path.resolve(ROOT, custom)
        : path.join(ROOT, "_worker.js");
    if (!fs.existsSync(src)) {
        throw new Error(`Worker source not found: ${src}`);
    }
    const shimUrl = pathToFileURL(
        path.join(__dirname, "cf-sockets.js"),
    ).href;
    const code = fs.readFileSync(src, "utf8");
    // Rewrite the one Cloudflare-only import onto the Node shim.
    const patched = code.replace(
        /(["'])cloudflare:sockets\1/g,
        JSON.stringify(shimUrl),
    );
    if (patched === code && code.includes("cloudflare:sockets")) {
        // e.g. import without quotes variants — refuse to run a broken port.
        throw new Error(
            "Failed to rewrite the cloudflare:sockets import — worker source format changed",
        );
    }
    const outPath = path.join(ROOT, "worker.mjs");
    fs.writeFileSync(outPath, patched);
    return pathToFileURL(outPath).href;
}

/* -------------------------------------------------------------------------- */
/* Node <-> Web bridge helpers                                                */
/* -------------------------------------------------------------------------- */

function nodeToWebRequest(req) {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    let proto = "http";
    const xfp = req.headers["x-forwarded-proto"];
    if (typeof xfp === "string" && xfp.split(",")[0].trim() === "https") {
        proto = "https";
    }
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const v of value) headers.append(name, String(v));
        } else {
            headers.append(name, String(value));
        }
    }

    const method = (req.method || "GET").toUpperCase();
    const init = { method, headers, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(req);
        init.duplex = "half";
    }
    return new Request(url, init);
}

async function webResponseToNode(res, response, nodeReq) {
    const headers = [];
    response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers.push([name, value]);
    });

    const status = response.status || 200;
    const statusText = response.statusText;
    if (typeof statusText === "string" && statusText) {
        res.writeHead(status, statusText, headers);
    } else {
        res.writeHead(status, headers);
    }

    const method = nodeReq ? nodeReq.method : "GET";
    if (
        method === "HEAD" ||
        status === 204 ||
        status === 304 ||
        !response.body
    ) {
        res.end();
        return;
    }

    const reader = response.body.getReader();
    let drainWaiter = null;
    try {
        res.on("close", () => {
            if (drainWaiter) drainWaiter();
        });
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
                if (!res.write(value) && !res.destroyed) {
                    await new Promise((resolve) => {
                        drainWaiter = resolve;
                        res.once("drain", () => {
                            drainWaiter = null;
                            resolve();
                        });
                    });
                }
            }
        }
    } catch (e) {
        // Client went away or the stream errored — tear the connection down.
        try {
            res.destroy();
        } catch (_) {}
        return;
    } finally {
        try {
            reader.releaseLock();
        } catch (_) {}
    }
    if (!res.destroyed) res.end();
}

async function respondOnRawSocket(socket, response) {
    const status = response.status || 200;
    const statusText =
        response.statusText || STATUS_TEXT[status] || "Unknown";
    const lines = [`HTTP/1.1 ${status} ${statusText}`];
    response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) {
            lines.push(`${name}: ${value}`);
        }
    });
    let body = "";
    try {
        body = await response.text();
    } catch (_) {}
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    lines.push("Connection: close");
    socket.write(lines.join("\r\n") + "\r\n\r\n" + body);
    socket.destroy();
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
    // 1. Patch workerd globals BEFORE the worker module is evaluated.
    patchWebGlobals();

    // 2. Build and import the worker.
    const workerUrl = ensureWorkerModule();
    const workerModule = await import(workerUrl);
    const worker = workerModule.default;
    if (!worker || typeof worker.fetch !== "function") {
        throw new Error(
            "Worker module does not export a default { fetch } handler",
        );
    }

    // 3. Storage: prefer an attached Railway volume, then DATA_DIR, then
    //    ./data relative to the repo. The filesystem is ephemeral without a
    //    volume — settings survive restarts but not redeploys in that case.
    const dataDir =
        process.env.RAILWAY_VOLUME_MOUNT_PATH ||
        (process.env.DATA_DIR && path.resolve(ROOT, process.env.DATA_DIR)) ||
        path.join(ROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "nahan.db");
    const iotDb = createD1Binding(dbPath);

    // 4. Worker env bindings. Keep parity with the Cloudflare deployment
    //    (D1 binding IOT_DB + optional vars from wrangler.toml).
    const localStatic = (file) =>
        fs.existsSync(path.join(ROOT, file))
            ? `http://127.0.0.1:${PORT}/__nahan_static/${file}`
            : null;
    const env = { IOT_DB: iotDb };
    if (process.env.RELAY_IP) env.RELAY_IP = process.env.RELAY_IP;
    const dashUrl =
        process.env.DASHBOARD_URL || localStatic("dashboard.html");
    if (dashUrl) env.DASHBOARD_URL = dashUrl;
    const subUrl =
        process.env.SUBSCRIPTION_URL ||
        localStatic("subscription.html");
    if (subUrl) env.SUBSCRIPTION_URL = subUrl;

    // 5. Execution context shim.
    const ctx = {
        waitUntil(promise) {
            Promise.resolve(promise).catch((e) =>
                logError(
                    "waitUntil task failed:",
                    e && e.stack ? e.stack : e,
                ),
            );
        },
        props: {},
    };

    /* ------------------------------ request path ------------------------ */

    async function handleRequest(req, res) {
        const pathname = (req.url || "/").split("?")[0];

        // Liveness probe that never touches the worker, the database or
        // outbound network — perfect for Railway healthchecks.
        if (pathname === "/_health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    ok: true,
                    uptime: Math.floor(process.uptime()),
                    pid: process.pid,
                }),
            );
            return;
        }

        // Locally bundled dashboard/subscription assets (keeps the service
        // self-contained; the worker fetch()s DASHBOARD_URL / SUBSCRIPTION_URL
        // like on Cloudflare, and these URLs loop back to this handler).
        if (pathname.startsWith("/__nahan_static/")) {
            const file = pathname.slice("/__nahan_static/".length);
            if (!STATIC_FILES.has(file)) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
                return;
            }
            try {
                const buf = await fsp.readFile(path.join(ROOT, file));
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-cache",
                });
                res.end(buf);
            } catch (_) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
            }
            return;
        }

        const request = nodeToWebRequest(req);
        const response = await worker.fetch(request, env, ctx);
        await webResponseToNode(res, response, req);
    }

    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
            logError(
                "request failed:",
                req.method,
                req.url,
                e && e.stack ? e.stack : e,
            );
            if (!res.headersSent) {
                try {
                    res.writeHead(502, { "Content-Type": "text/plain" });
                } catch (_) {}
            }
            try {
                res.end("Internal Server Error");
            } catch (_) {}
        });
    });

    /* ------------------------------ upgrade path ------------------------ */

    const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
    });

    server.on("upgrade", (req, socket, head) => {
        handleUpgrade(req, socket, head).catch((e) => {
            logError("upgrade failed:", e && e.stack ? e.stack : e);
            try {
                socket.write(
                    "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n",
                );
            } catch (_) {}
            try {
                socket.destroy();
            } catch (_) {}
        });
    });

    async function handleUpgrade(req, socket, head) {
        const request = nodeToWebRequest(req);
        const response = await worker.fetch(request, env, ctx);
        const clientHandle = response ? response.webSocket : undefined;

        if (!clientHandle || typeof clientHandle._attachReal !== "function") {
            // The worker declined the upgrade (kill switch, wrong route, …)
            // — deliver its HTTP answer on the raw socket.
            await respondOnRawSocket(
                socket,
                response ||
                    new Response("Bad Request", { status: 400 }),
            );
            return;
        }

        wss.handleUpgrade(req, socket, head, (realWs) => {
            clientHandle._attachReal(realWs);
        });
    }

    /* ------------------------------ cron emulation ---------------------- */

    if (typeof worker.scheduled === "function") {
        const intervalMin = Math.max(
            1,
            Number(process.env.SCHEDULED_INTERVAL_MIN) || 60,
        );
        setInterval(
            () => {
                Promise.resolve(
                    worker.scheduled(
                        { cron: `railway/${intervalMin}m`, scheduledTime: Date.now() },
                        env,
                        ctx,
                    ),
                ).catch((e) =>
                    logError(
                        "scheduled task failed:",
                        e && e.stack ? e.stack : e,
                    ),
                );
            },
            intervalMin * 60 * 1000,
        ).unref();
    }

    /* ------------------------------ lifecycle --------------------------- */

    process.on("uncaughtException", (err) => {
        logError("uncaughtException:", err && err.stack ? err.stack : err);
    });
    process.on("unhandledRejection", (err) => {
        logError(
            "unhandledRejection:",
            err && err.stack ? err.stack : err,
        );
    });

    const shutdown = (signal) => {
        log(`received ${signal}, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    server.keepAliveTimeout = 72_000;
    server.headersTimeout = 76_000;
    server.requestTimeout = 0; // WebSocket + long-lived tunnels live here.

    await new Promise((resolve) =>
        server.listen(PORT, "0.0.0.0", resolve),
    );

    log(`listening on 0.0.0.0:${PORT}`);
    log(`worker source : ${path.basename(
        process.env.WORKER_FILE || "_worker.js",
    )} -> worker.mjs`);
    log(`database      : ${dbPath}`);
    log(`dashboard     : http://127.0.0.1:${PORT}/sync/dash (default route/key: "admin")`);
}

main().catch((e) => {
    console.error(LOG, "fatal:", e && e.stack ? e.stack : e);
    process.exit(1);
});
