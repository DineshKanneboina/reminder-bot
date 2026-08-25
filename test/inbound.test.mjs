import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import worker from "../build/index.js";
import { Db } from "../build/db.js";
import { signAck, verifyAck } from "../build/ack.js";
import { runTick } from "../build/tick.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const SECRET = "hook-secret";
const SIGNING = "signing-key";
const T0 = localToUtc(2026, 8, 11, 9, 0, TZ);
const iso = (ms) => new Date(ms).toISOString();

let d1, env, sent, ctx, pending;

/**
 * The Worker acks webhooks fast and finishes the work in waitUntil, so a test
 * that only awaits fetch() asserts against a half-finished handler. Drain the
 * background promises before asserting.
 */
async function settle() {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

beforeEach(() => {
  d1 = new FakeD1(["schema.sql", "seed.sql"]);
  env = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "fake",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ACK_SIGNING_KEY: SIGNING,
    BOOTSTRAP_TOKEN: "let-me-in",
    PUBLIC_URL: "https://bot.example.com",
    STALE_FLOOR_HOURS: "2",
    MATERIALIZE_HORIZON_HOURS: "48",
    // This file is about the webhook: allowlist, dedupe, parse, reply. The
    // board posts a second message on the same channel after every reply,
    // which would make `replies()` ambiguous here. It has its own file.
    BOARD_ENABLED: "0",
  };
  // Webhook hits now revive a stale scheduler; an empty tick_log reads as
  // "stale forever" and would run real ticks inside unrelated tests. Seed a
  // fresh row so revive stays a no-op unless a test clears it deliberately.
  d1.exec(`INSERT INTO tick_log VALUES ('${new Date().toISOString()}',1,'{}',NULL)`);
  sent = installFetchCapture();
  pending = [];
  ctx = {
    waitUntil: (p) => {
      pending.push(p);
      return p;
    },
    passThroughOnException() {},
  };
});

/** Deliver a Telegram text message through the real webhook route. */
async function telegram(text, opts = {}) {
  const { chatId = "9999", id = Math.floor(Math.random() * 1e9), secret = SECRET } = opts;
  const res = await worker.fetch(
    new Request("https://bot.example.com/webhook/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
      body: JSON.stringify({
        update_id: id,
        message: { message_id: id, chat: { id: chatId }, text, date: Math.floor(T0 / 1000) },
      }),
    }),
    env,
    ctx,
  );
  await settle();
  return res;
}

/** Deliver a Telegram inline-button tap. */
async function tap(data, opts = {}) {
  const { chatId = "9999", id = Math.floor(Math.random() * 1e9) } = opts;
  const res = await worker.fetch(
    new Request("https://bot.example.com/webhook/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" },
      body: JSON.stringify({
        update_id: id,
        callback_query: {
          id: String(id),
          data,
          from: { id: chatId },
          message: { chat: { id: chatId } },
        },
      }),
    }),
    env,
    ctx,
  );
  await settle();
  return res;
}

const registered = () =>
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
  `);

const replies = () => sent.filter((s) => s.kind === "telegram").map((s) => s.text);

// --------------------------------------------------------------------------

test("webhook rejects a bad secret without touching the database", async () => {
  registered();
  const res = await telegram("help", { secret: "wrong" });
  assert.equal(res.status, 403);
  assert.equal(replies().length, 0);
});

test("unknown senders are ignored entirely", async () => {
  registered();
  await telegram("help", { chatId: "1234" });
  assert.equal(replies().length, 0);
});

test("bootstrap token onboards the first user, then stops working", async () => {
  assert.equal(await new Db(d1).userCount(), 0);

  await telegram("let-me-in");
  assert.equal(await new Db(d1).userCount(), 1);
  assert.match(replies()[0], /set up/i);

  // A second sender presenting the same token gets nothing.
  sent.length = 0;
  await telegram("let-me-in", { chatId: "7777" });
  assert.equal(await new Db(d1).userCount(), 1);
  assert.equal(replies().length, 0);
});

test("help and empty list work end to end", async () => {
  registered();
  await telegram("help");
  assert.match(replies()[0], /every mon\/wed\/fri/);

  sent.length = 0;
  await telegram("list");
  assert.match(replies()[0], /Nothing open/);
});

test("duplicate provider message ids are applied once", async () => {
  registered();
  await telegram("help", { id: 555 });
  await telegram("help", { id: 555 });
  assert.equal(replies().length, 1, "a retried delivery must not double-apply");
});

test("a full round trip: create by text, get nagged, tap Done", async () => {
  registered();
  // Keyword path can't create, so stub the model response.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.anthropic.com")) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent: "create",
                confidence: 0.95,
                task: { title: "water plants", rrule: "FREQ=DAILY", local_time: "09:00" },
              }),
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(url, init);
  };
  env.ANTHROPIC_API_KEY = "fake";

  await telegram("water the plants every day at 9am");
  const tasks = await new Db(d1).tasksForUser("u1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "water plants");
  assert.match(replies().at(-1), /water plants/);

  // The task was created "now", so drive the tick from a later occurrence.
  const fireAt = localToUtc(2026, 8, 12, 9, 0, TZ);
  d1.exec(`UPDATE tasks SET dtstart = '${iso(fireAt - 86400_000)}'`);
  sent.length = 0;

  // A task created without saying anything about insistence gets the 'default'
  // policy, which is quiet-tier: at its due time it lands on the board and says
  // nothing out loud. The push only comes once it has aged out.
  const quiet = await runTick(env, fireAt);
  assert.equal(quiet.parked, 1);
  assert.equal(quiet.sent, 0, "a quiet reminder must not push at its due time");
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 0);

  const r = await runTick(env, fireAt + 4 * 3600_000); // QUIET_AGING_HOURS
  assert.equal(r.sent, 1);

  const nag = sent.find((s) => s.kind === "telegram");
  assert.match(nag.text, /water plants/);

  // A recurring nag carries no Done button any more — 🗑 Today closes just
  // today's occurrence, ❌ Forever would delete the series.
  const buttons = nag.markup.inline_keyboard.flat();
  assert.ok(!buttons.some((b) => b.text.includes("Done")), "no Done on a daily");
  const payload = buttons.find((b) => b.text.includes("Today")).callback_data;
  sent.length = 0;
  await tap(payload);

  const rows = d1.q(`SELECT state, next_nag_at FROM reminder_instances ORDER BY scheduled_for`);
  const closed = rows.find((x) => x.state === "skipped");
  assert.ok(closed, "the tapped instance is closed for today");
  assert.equal(closed.next_nag_at, null);
  const [task] = d1.q(`SELECT active FROM tasks`);
  assert.equal(task.active, 1, "and the series survives");
});

test("low-confidence parses go through a confirm handshake", async () => {
  registered();
  env.ANTHROPIC_API_KEY = "fake";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.anthropic.com")) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent: "create",
                confidence: 0.4,
                task: { title: "call mom", rrule: "FREQ=WEEKLY;BYDAY=SU", local_time: "18:00" },
              }),
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(url, init);
  };

  await telegram("uh maybe call mom sundays?");
  assert.match(replies().at(-1), /Reply .*y.* to confirm/);
  assert.equal((await new Db(d1).tasksForUser("u1")).length, 0, "nothing created before confirmation");

  sent.length = 0;
  await telegram("y");
  const tasks = await new Db(d1).tasksForUser("u1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "call mom");
});

test("signed ack links round-trip and reject tampering", async () => {
  const exp = Date.now() + 3600_000;
  const token = await signAck(SIGNING, "inst-1", "done", exp);

  assert.deepEqual(await verifyAck(SIGNING, token), { instanceId: "inst-1", action: "done" });
  assert.equal(await verifyAck("wrong-key", token), null, "wrong key rejected");
  assert.equal(await verifyAck(SIGNING, token.replace("inst-1", "inst-2")), null, "tampered id rejected");

  const stale = await signAck(SIGNING, "inst-1", "done", Date.now() - 1000);
  assert.equal(await verifyAck(SIGNING, stale), null, "expired token rejected");
});

test("/ack closes out a live instance", async () => {
  registered();
  d1.exec(`
    INSERT INTO tasks VALUES ('t1','u1','trash',NULL,'FREQ=DAILY',
      '${iso(T0 - 86400_000)}','09:00','${TZ}','pol_default','supersede',1,
      '${iso(T0 - 86400_000)}','${iso(T0 - 86400_000)}');
  `);
  await runTick(env, T0);
  const [inst] = d1.q(`SELECT id FROM reminder_instances ORDER BY scheduled_for`);

  const token = await signAck(SIGNING, inst.id, "done", Date.now() + 3600_000);
  const res = await worker.fetch(
    new Request(`https://bot.example.com/ack?t=${encodeURIComponent(token)}`),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Marked done/);

  const [row] = d1.q(`SELECT state, next_nag_at, ack_source FROM reminder_instances WHERE id = '${inst.id}'`);
  assert.equal(row.state, "acknowledged");
  assert.equal(row.next_nag_at, null);
  assert.equal(row.ack_source, "email-link");
});

test("/ack on an already-closed instance is a safe no-op", async () => {
  registered();
  d1.exec(`
    INSERT INTO tasks VALUES ('t1','u1','trash',NULL,'FREQ=DAILY',
      '${iso(T0 - 86400_000)}','09:00','${TZ}','pol_default','supersede',1,
      '${iso(T0 - 86400_000)}','${iso(T0 - 86400_000)}');
  `);
  await runTick(env, T0);
  const [inst] = d1.q(`SELECT id FROM reminder_instances ORDER BY scheduled_for`);
  await new Db(d1).terminate(inst.id, "acknowledged", "keyword");

  const token = await signAck(SIGNING, inst.id, "done", Date.now() + 3600_000);
  const res = await worker.fetch(
    new Request(`https://bot.example.com/ack?t=${encodeURIComponent(token)}`),
    env,
    ctx,
  );
  assert.match(await res.text(), /already closed/);
});

test("/health responds without auth", async () => {
  const res = await worker.fetch(new Request("https://bot.example.com/health"), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
