/**
 * Minimal D1 shim over node:sqlite, so the tick and command handlers can be
 * exercised in-process without spinning up workerd. Covers exactly the surface
 * src/db.ts uses: prepare/bind/first/all/run/batch, including RETURNING.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/**
 * Rewrite `?1`-style numbered placeholders to plain `?`, reordering the params
 * to match their order of appearance.
 *
 * D1 supports `?N` natively, but node:sqlite's handling of it varies across
 * Node releases (22.16 reports the wrong parameter count and rejects the bind
 * with SQLITE_RANGE). Plain `?` works everywhere, so the shim normalizes here
 * rather than the source having to avoid a syntax D1 actually supports.
 *
 * A placeholder may repeat (`?11` twice in one INSERT); each occurrence gets
 * its own slot pointing at the same source value.
 */
function normalizeSql(sql, params) {
  if (!/\?\d/.test(sql)) return [sql, params];
  const order = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => {
    order.push(Number(n) - 1);
    return "?";
  });
  return [out, order.map((i) => params[i])];
}

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Stmt(this.db, this.sql, params);
  }
  #prepared() {
    const [sql, params] = normalizeSql(this.sql, this.params);
    // node:sqlite rejects undefined; D1 treats it as NULL.
    return [this.db.prepare(sql), params.map((p) => (p === undefined ? null : p))];
  }
  async first() {
    const [stmt, params] = this.#prepared();
    const rows = stmt.all(...params);
    return rows.length ? rows[0] : null;
  }
  async all() {
    const [stmt, params] = this.#prepared();
    // RETURNING clauses must be read with .all(), not .run().
    const results = stmt.all(...params);
    return { results, success: true, meta: { changes: results.length } };
  }
  async run() {
    const [stmt, params] = this.#prepared();
    if (/returning/i.test(this.sql)) {
      const results = stmt.all(...params);
      return { results, success: true, meta: { changes: results.length } };
    }
    const r = stmt.run(...params);
    return { success: true, meta: { changes: Number(r.changes ?? 0) } };
  }
}

export class FakeD1 {
  constructor(schemaPaths = []) {
    this.db = new DatabaseSync(":memory:");
    for (const p of schemaPaths) this.db.exec(readFileSync(p, "utf8"));
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
  exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
  /** Test helper. */
  q(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
}

/** Captures outbound sends and returns plausible provider responses. */
export function installFetchCapture() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("api.telegram.org")) {
      // The board rides the same host as nags — sendMessage for a new board,
      // editMessageText to mutate it, pin/unpinChatMessage around the handover.
      // Capturing the method is what lets a test tell those apart.
      sent.push({
        kind: "telegram",
        method: u.slice(u.lastIndexOf("/") + 1),
        to: body.chat_id,
        text: body.text,
        markup: body.reply_markup,
        messageId: body.message_id,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("api.anthropic.com")) {
      sent.push({ kind: "llm", body });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Heartbeat and anything else.
    sent.push({ kind: "other", url: u });
    return new Response("ok");
  };
  return sent;
}

/** Simulates a channel that returns an HTML error page instead of JSON. */
export function installBrokenFetch() {
  globalThis.fetch = async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
}
