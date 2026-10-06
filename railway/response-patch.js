/**
 * Global web API patches required to run nahan's `_worker.js` on Node.js.
 *
 * 1. `Response` — the worker returns WebSocket upgrades as:
 *
 *        new Response(null, { status: 101, webSocket: client })
 *
 *    but WHATWG `Response` (undici) rejects status codes outside 200..599
 *    and silently drops the custom `webSocket` init field. The patched class
 *    constructs with a safe status, then exposes the real status and the
 *    `webSocket` handle on the instance so the upgrade bridge can act on it.
 *
 * 2. `WebSocketPair` — not a global in Node. Installed from
 *    ./websocket-pair.js so `Object.values(new WebSocketPair())` inside the
 *    worker resolves against the shim.
 *
 * Both patches must be applied BEFORE the worker module is imported,
 * because workerd globals are resolved dynamically at call time — which is
 * exactly what makes this strategy work.
 */

import { WebSocketPair } from "./websocket-pair.js";

const NativeResponse = globalThis.Response;

class PatchedResponse extends NativeResponse {
    constructor(body, init) {
        if (init && init.webSocket !== undefined) {
            const { webSocket, status, ...rest } = init;
            // undici enforces 200..599 — build with a legal status, then
            // shadow it with the real one on the instance.
            super(null, { ...rest, status: 200 });
            this._webSocket = webSocket;
            const realStatus = typeof status === "number" ? status : 101;
            Object.defineProperty(this, "status", {
                value: realStatus,
                configurable: true,
                enumerable: true,
                writable: false,
            });
        } else {
            super(body, init);
        }
    }

    get webSocket() {
        return this._webSocket;
    }
}

export function patchWebGlobals() {
    if (globalThis.Response === PatchedResponse) return;
    globalThis.Response = PatchedResponse;
    globalThis.WebSocketPair = WebSocketPair;
}
