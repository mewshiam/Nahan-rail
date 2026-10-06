/**
 * Cloudflare `WebSocketPair` shim for Node.js (Railway port).
 *
 * Cloudflare Workers create server-side WebSockets through:
 *
 *   const [client, webSocket] = Object.values(new WebSocketPair());
 *   webSocket.accept();
 *   webSocket.binaryType = "arraybuffer";
 *   ...
 *   return new Response(null, { status: 101, webSocket: client });
 *
 * This shim reproduces that contract on top of plain Node.js:
 *
 *   - Index 0 ("client") is a lightweight handle. It is returned inside the
 *     patched Response (`.webSocket`). The HTTP upgrade bridge in server.js
 *     later attaches it to the REAL `ws` connection produced by
 *     `wss.handleUpgrade()`.
 *   - Index 1 ("webSocket"/"server") is the endpoint the worker code talks
 *     to. It exposes the Cloudflare WebSocket API surface used by nahan:
 *     accept(), binaryType, addEventListener/removeEventListener,
 *     send(string|ArrayBuffer|TypedArray), close(code, reason),
 *     readyState and "message"/"close"/"error" events.
 *
 * Messages sent by the worker before the real client connection is attached
 * are buffered and flushed on attach (mirrors workerd behaviour, e.g. the
 * early VLESS response `00 00` that races the 101 response).
 */

import { EventEmitter } from "node:events";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Stable per-listener identity so removeEventListener can undo addEventListener. */
const listenerIds = new WeakMap();
let nextListenerId = 1;
function listenerId(listener) {
    let id = listenerIds.get(listener);
    if (id === undefined) {
        id = nextListenerId++;
        listenerIds.set(listener, id);
    }
    return id;
}

/** Convert outgoing payloads into something `ws` accepts without surprises. */
function normalizeOutgoing(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return data;
}

class CFWebSocket extends EventEmitter {
    constructor() {
        super();
        this._binaryType = "arraybuffer";
        this._readyState = OPEN;
        this._real = null; // the live `ws` WebSocket once attached
        this._pending = []; // frames sent before attach
        this._closeAfterAttach = null;
        this._closeEmitted = false;
        this._wrapped = new Map(); // `${type}\0${listenerId}` -> wrapper
    }

    /* ------------------------------------------------------------------ */
    /* Cloudflare WebSocket API surface                                    */
    /* ------------------------------------------------------------------ */

    accept() {
        /* workerd requires accept(); nothing to do on Node. */
    }

    get binaryType() {
        return this._binaryType;
    }

    set binaryType(value) {
        this._binaryType = value;
    }

    get readyState() {
        return this._readyState;
    }

    send(data) {
        if (this._readyState !== OPEN) {
            throw new Error("WebSocket is already in CLOSING or CLOSED state");
        }
        const payload = normalizeOutgoing(data);
        if (this._real) {
            if (this._real.readyState === OPEN) {
                this._real.send(payload);
            }
            return;
        }
        this._pending.push(payload);
    }

    close(code = 1000, reason = "") {
        if (this._readyState === CLOSING || this._readyState === CLOSED) return;
        if (process.env.NAHAN_DEBUG) {
            const stack = new Error("trace");
            console.error(
                `[nahan-rail][ws] worker-side close(${code}) from:\n` +
                    (stack.stack || "")
                        .split("\n")
                        .slice(2, 7)
                        .join("\n"),
            );
        }
        this._readyState = CLOSING;
        if (this._real) {
            try {
                this._real.close(code, reason);
            } catch (e) {}
        } else {
            this._closeAfterAttach = { code, reason };
        }
        this._readyState = CLOSED;
        this._emitClose(code, reason);
    }

    addEventListener(type, listener, options) {
        if (typeof listener !== "function") return;
        const once = !!(options && options.once);
        const key = `${type}\u0000${listenerId(listener)}`;
        if (this._wrapped.has(key)) return;
        const wrapped = (event) => {
            if (once) {
                this._wrapped.delete(key);
                this.off(type, wrapped);
            }
            try {
                listener.call(this, event);
            } catch (err) {
                // A throwing listener must never take the whole proxy down.
                console.error(
                    "[nahan-rail] websocket listener error:",
                    err && err.stack ? err.stack : err,
                );
            }
        };
        this._wrapped.set(key, wrapped);
        if (once) this.once(type, wrapped);
        else this.on(type, wrapped);
    }

    removeEventListener(type, listener) {
        const key = `${type}\u0000${listenerId(listener)}`;
        const wrapped = this._wrapped.get(key);
        if (wrapped) {
            this._wrapped.delete(key);
            this.off(type, wrapped);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bridge internals (used by server.js)                                */
    /* ------------------------------------------------------------------ */

    /** Attach the real `ws` connection (client side of the pair). */
    _attachReal(real) {
        if (this._real) return;
        this._real = real;

        real.on("message", (data) => {
            this._emitMessage(data);
        });
        real.on("close", (code, reason) => {
            this._readyState = CLOSED;
            this._emitClose(
                code || 1005,
                reason ? reason.toString() : "",
            );
        });
        real.on("error", (err) => {
            this.emit("error", {
                type: "error",
                error: err,
                message: err && err.message,
            });
        });
        real.on("pong", () => {
            this.emit("pong", { type: "pong" });
        });

        // Flush frames the worker produced before the 101 went out.
        if (this._readyState === OPEN && real.readyState === OPEN) {
            for (const payload of this._pending) {
                try {
                    real.send(payload);
                } catch (e) {}
            }
        }
        this._pending = [];

        if (this._readyState !== OPEN || this._closeAfterAttach) {
            const c = this._closeAfterAttach || { code: 1000, reason: "" };
            try {
                real.close(c.code, c.reason);
            } catch (e) {}
        }
    }

    _emitMessage(raw) {
        let data = raw; // Buffer from `ws`
        if (this._binaryType === "arraybuffer") {
            data = raw.buffer.slice(
                raw.byteOffset,
                raw.byteOffset + raw.byteLength,
            );
        } else if (this._binaryType === "blob") {
            data = new Blob([raw]);
        }
        this.emit("message", { type: "message", data });
    }

    _emitClose(code, reason) {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this.emit("close", {
            type: "close",
            code,
            reason,
            wasClean: true,
        });
    }
}

/**
 * The "client" half of the pair. In workerd this is the endpoint handed back
 * to the browser inside the 101 response. Here it is just a handle the
 * upgrade bridge attaches the real `ws` connection to.
 */
class ClientWebSocketHandle {
    constructor(workerSide) {
        this._workerSide = workerSide;
    }

    get readyState() {
        return this._workerSide.readyState;
    }

    _attachReal(real) {
        this._workerSide._attachReal(real);
    }
}

/**
 * Cloudflare-compatible WebSocketPair.
 *
 * `Object.values(new WebSocketPair())` returns `[client, webSocket]` —
 * exactly like workerd — because numeric own-enum keys enumerate in
 * ascending order.
 */
class WebSocketPair {
    constructor() {
        const workerSide = new CFWebSocket();
        const client = new ClientWebSocketHandle(workerSide);
        return { 0: client, 1: workerSide };
    }
}

export { WebSocketPair, CFWebSocket };
