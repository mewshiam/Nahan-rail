/**
 * `cloudflare:sockets` shim for Node.js (Railway port).
 *
 * Nahan's `_worker.js` imports:
 *
 *   import { connect } from "cloudflare:sockets";
 *
 * and uses exactly this surface:
 *   - const sock = connect({ hostname, port })   // synchronous
 *   - await sock.opened                           // resolves on TCP connect
 *   - sock.readable                              // ReadableStream<Uint8Array>
 *   - sock.writable                              // WritableStream<Uint8Array>
 *   - sock.close()                               // hard close
 *
 * This shim implements that contract on top of `node:net` + the Web Streams
 * implementations that ship with Node.js >= 20. Backpressure is applied by
 * pausing the Node socket whenever the ReadableStream queue is full and
 * resuming it from `pull()`.
 *
 * `startTls()` is not implemented (nahan never uses it — relay ports carry
 * plain TCP for the TLS-in-TLS flow). Calling it throws immediately instead
 * of failing silently.
 */

import net from "node:net";

function parseAddressForm(address, portArg) {
    // connect("host:port") / connect({ hostname, port }) / connect("host", port)
    if (typeof address === "string") {
        if (address.includes(":") && /^\[?[^\]]+\]?:\d+$/.test(address)) {
            const lastColon = address.lastIndexOf(":");
            return {
                host: address.slice(0, lastColon),
                port: Number(address.slice(lastColon + 1)),
            };
        }
        return { host: address, port: portArg != null ? Number(portArg) : 443 };
    }
    const opts = address || {};
    return {
        host: opts.hostname || opts.host,
        port: Number(opts.port != null ? opts.port : 443),
    };
}

export function connect(address, portArg) {
    const { host, port } = parseAddressForm(address, portArg);

    const DEBUG = !!process.env.NAHAN_DEBUG;
    if (DEBUG) console.error(`[nahan-rail][sock] connect ${host}:${port}`);

    const socket = net.connect({ host, port });

    // Never let a socket error become an uncaughtException: the streams and
    // the `opened` promise surface errors to the worker code, which has its
    // own retry/timeout machinery.
    socket.on("error", () => {});

    let openedResolve, openedReject;
    const opened = new Promise((resolve, reject) => {
        openedResolve = resolve;
        openedReject = reject;
    });
    socket.once("connect", () => {
        if (DEBUG) console.error(`[nahan-rail][sock] opened ${host}:${port}`);
        openedResolve();
    });
    socket.once("error", (err) => {
        if (DEBUG)
            console.error(
                `[nahan-rail][sock] error ${host}:${port} ->`,
                err && err.message,
            );
        openedReject(err);
    });

    let closedSettled = false;
    let closedResolve, closedReject;
    const closed = new Promise((resolve, reject) => {
        closedResolve = resolve;
        closedReject = reject;
    });
    const settleClosed = (err) => {
        if (closedSettled) return;
        closedSettled = true;
        if (err) closedReject(err);
        else closedResolve();
    };

    const readable = new ReadableStream(
        {
            start(controller) {
                socket.on("data", (chunk) => {
                    try {
                        controller.enqueue(chunk);
                        // Backpressure: stop reading off the kernel buffer
                        // when the consumer is falling behind.
                        if (
                            controller.desiredSize !== null &&
                            controller.desiredSize <= 0
                        ) {
                            socket.pause();
                        }
                    } catch (e) {
                        /* stream already closed/cancelled */
                    }
                });
                socket.on("end", () => {
                    try {
                        controller.close();
                    } catch (e) {}
                });
                socket.on("close", () => {
                    try {
                        controller.close();
                    } catch (e) {}
                    settleClosed();
                });
                socket.on("error", (err) => {
                    try {
                        controller.error(err);
                    } catch (e) {}
                    settleClosed(err);
                });
            },
            pull() {
                if (!socket.destroyed) socket.resume();
            },
            cancel() {
                try {
                    socket.destroy();
                } catch (e) {}
            },
        },
        // Small chunk count keeps memory tight while staying off the slow
        // path; TCP segments usually arrive far larger than this.
        { highWaterMark: 16 },
    );

    const writable = new WritableStream({
        write(chunk) {
            return new Promise((resolve, reject) => {
                if (socket.destroyed) {
                    reject(new Error("socket is closed"));
                    return;
                }
                // Cloudflare sockets accept plain ArrayBuffers; Node does
                // not — normalise the chunk before handing it to net.
                let data = chunk;
                if (data instanceof ArrayBuffer) {
                    data = Buffer.from(data);
                } else if (ArrayBuffer.isView(data)) {
                    data = Buffer.from(
                        data.buffer,
                        data.byteOffset,
                        data.byteLength,
                    );
                }
                socket.write(data, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        },
        close() {
            return new Promise((resolve) => {
                if (socket.destroyed) {
                    resolve();
                    return;
                }
                try {
                    socket.end(() => resolve());
                } catch (e) {
                    resolve();
                }
            });
        },
        abort() {
            try {
                socket.destroy();
            } catch (e) {}
        },
    });

    return {
        get opened() {
            return opened;
        },
        get closed() {
            return closed;
        },
        get readable() {
            return readable;
        },
        get writable() {
            return writable;
        },
        close() {
            try {
                socket.destroy();
            } catch (e) {}
        },
        startTls() {
            throw new Error(
                "startTls() is not supported by the nahan Railway port",
            );
        },
    };
}

export default { connect };
