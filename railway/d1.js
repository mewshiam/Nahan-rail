/**
 * Cloudflare D1 shim for Node.js (Railway port).
 *
 * Nahan persists all of its state through a single D1 binding (`IOT_DB`) and
 * only touches one table:
 *
 *   CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)
 *
 * The complete statement surface used by `_worker.js`:
 *   prepare(sql).bind(...).all()    -> { results: [...] }
 *   prepare(sql).bind(...).first()  -> row | null
 *   prepare(sql).bind(...).run()    -> { success, meta: { changes, ... } }
 *
 * This shim implements the D1 API over `better-sqlite3` (synchronous driver,
 * wrapped in async methods to match D1's promise-based contract). The exact
 * SQL used by the worker — `CAST(value AS INTEGER)`, `ON CONFLICT(key) DO
 * UPDATE SET value=excluded.value`, `INSERT OR IGNORE` — is genuine SQLite
 * and runs unmodified, which is why a real embedded SQLite engine is used
 * instead of a hand-rolled parser.
 */

import Database from "better-sqlite3";

function toSQLiteParam(p) {
    if (p == null) return null;
    if (
        typeof p === "number" ||
        typeof p === "string" ||
        typeof p === "bigint"
    ) {
        return p;
    }
    if (p instanceof ArrayBuffer) return Buffer.from(p);
    if (ArrayBuffer.isView(p)) {
        return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    }
    if (p instanceof Date) return p.toISOString();
    return p;
}

class D1Statement {
    constructor(db, sql) {
        this._db = db;
        this._sql = sql;
        this._params = [];
    }

    bind(...params) {
        const next = new D1Statement(this._db, this._sql);
        next._params = params.map(toSQLiteParam);
        return next;
    }

    _prepare() {
        return this._db.prepare(this._sql);
    }

    async run() {
        const info = this._prepare().run(...this._params);
        return {
            success: true,
            meta: {
                changes: info.changes,
                last_row_id:
                    typeof info.lastInsertRowid === "bigint"
                        ? Number(info.lastInsertRowid)
                        : info.lastInsertRowid,
                duration: 0.01,
                rows_read: info.changes,
                rows_written: info.changes,
                served_by_region: "railway",
                served_by_primary: true,
            },
        };
    }

    async all() {
        const results = this._prepare().all(...this._params);
        return {
            results,
            success: true,
            meta: {
                changes: results.length,
                last_row_id: 0,
                duration: 0.01,
                served_by_region: "railway",
                served_by_primary: true,
            },
        };
    }

    async first() {
        const row = this._prepare().get(...this._params);
        return row === undefined ? null : row;
    }

    async raw() {
        const rows = this._prepare().raw().all(...this._params);
        return {
            results: rows,
            success: true,
            meta: { duration: 0.01 },
        };
    }
}

/**
 * Create a D1-compatible binding backed by a local SQLite database.
 *
 * @param {string} dbPath absolute path of the sqlite file
 */
export function createD1Binding(dbPath) {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");

    const binding = {
        prepare(sql) {
            return new D1Statement(db, String(sql));
        },
        async batch(statements) {
            const results = [];
            const runOne = (stmt) => {
                if (stmt instanceof D1Statement) {
                    const info = stmt._prepare().run(...stmt._params);
                    return {
                        success: true,
                        meta: {
                            changes: info.changes,
                            last_row_id:
                                typeof info.lastInsertRowid === "bigint"
                                    ? Number(info.lastInsertRowid)
                                    : info.lastInsertRowid,
                        },
                    };
                }
                return { success: true, meta: { changes: 0 } };
            };
            const tx = db.transaction(() => {
                for (const stmt of statements) results.push(runOne(stmt));
            });
            tx();
            return results;
        },
        async exec(sql) {
            db.exec(String(sql));
            return { success: true, count: 0, duration: 0.01 };
        },
        withSession() {
            // Nahan never uses sessions; return the binding itself.
            return binding;
        },
        _close() {
            try {
                db.close();
            } catch (e) {}
        },
    };

    return binding;
}
