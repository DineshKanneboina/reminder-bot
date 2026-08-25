/**
 * Regressions from the weekend of 22-24 Aug: a worker that dies mid-flight
 * must not lose messages, repeat digests, complete the wrong reminder, or
 * leave no trace of what killed it.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import worker from "../build/index.js";
import { runTick } from "../build/tick.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const SECRET = "hook-secret";
const T0 = localToUtc(2026, 8, 24, 9, 44, TZ);
const iso = (ms) => new Date(ms).toISOString();

let d1, env, sent, ctx, pending;

beforeEach(() => {
  d1 = new FakeD1(["schema.sql", "seed.sql"]);
  env = {
    DB: d1, TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_WEBHOOK_SECRET: SECRET,
    MATERIALIZE_HORIZON_HOURS: "48", STALE_FLOOR_HOURS: "2", BOARD_ENABLED: "0",
  };
  sent = installFetchCapture();
  pending = [];
  ctx = { waitUntil: (p) => (pending.push(p), p), passThroughOnException() {} };
  // Webhook hits now revive a stale scheduler; an empty tick_log reads as
  // "stale forever" and would run real ticks inside unrelated tests. Seed a
  // fresh row so revive stays a no-op unless a test clears it deliberately.
  d1.exec(`INSERT INTO tick_log VALUES ('${new Date().toISOString()}',1,'{}',NULL)`);
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
  `);
});

async function settle() {
  while (pending.length) { const b = pending; pending = []; await Promise.all(b); }
}

function seedTask(id, title, rrule, localTime, dtstartMs = Date.parse("2026-08-20T00:00:00Z")) {
  const dtstart = iso(dtstartMs);
  d1.exec(`INSERT INTO tasks VALUES ('${id}','u1','${title}',NULL,'${rrule}','${dtstart}',
    '${localTime}','${TZ}','pol_urgent','supersede',1,'${dtstart}','${dtstart}');`);
}

const intentFor = (patch) => ({
  intent: "complete", confidence: 0.9,
  target: { instance_number: null, instance_id: null, task_query: null },
  task: { title: null, notes: null, rrule: null, local_time: null, start_date: null, policy: null, overlap: null },
  snooze_minutes: null, timezone: null, quiet_hours: null, pause_minutes: null,
  clarifying_question: null, memory: null, source: "llm",
  ...patch,
});

// ------------------------------------------------- the wrong-target regression

test("naming a task that isn't open never completes whatever happens to be", async () => {
  // The real conversation: "Done with OMSCS" processed while only Buy protein
  // powder was live. The old resolver fell through to the single live item.
  seedTask("t_protein", "Buy protein powder", "FREQ=DAILY", "09:00");
  seedTask("t_omscs", "OMSCS class registration", "FREQ=DAILY;COUNT=1", "19:00",
    localToUtc(2026, 8, 24, 0, 0, TZ));
  await runTick(env, localToUtc(2026, 8, 24, 9, 0, TZ));

  const db = new Db(d1);
  const user = await db.user("u1");
  const live = await db.liveForUser("u1", iso(T0));
  assert.equal(live.length, 1, "only protein is open at 9:44");

  const reply = await applyIntent(
    intentFor({ target: { instance_number: null, instance_id: null, task_query: "OMSCS" } }),
    user, db, env, live, T0,
  );

  const [protein] = d1.q(`SELECT state FROM reminder_instances WHERE task_id='t_protein'`);
  assert.equal(protein.state, "notified", "protein is untouched");
  // And the named ONE-OFF is completed at task level: done means remove.
  assert.match(reply.text, /Done — <b>OMSCS class registration<\/b> removed/);
  const [omscs] = d1.q(`SELECT active FROM tasks WHERE id='t_omscs'`);
  assert.equal(omscs.active, 0);
});

test("even an LLM-guessed instance number loses to a non-matching name", async () => {
  seedTask("t_protein", "Buy protein powder", "FREQ=DAILY", "09:00");
  await runTick(env, localToUtc(2026, 8, 24, 9, 0, TZ));
  const db = new Db(d1);
  const live = await db.liveForUser("u1", iso(T0));

  const reply = await applyIntent(
    intentFor({ target: { instance_number: 1, instance_id: null, task_query: "the gym one" } }),
    await db.user("u1"), db, env, live, T0,
  );
  assert.equal(d1.q(`SELECT state FROM reminder_instances`)[0].state, "notified");
  assert.match(reply.text, /No reminder matching/);
});

test("completing a one-off retires the whole task, not just the occurrence", async () => {
  // Anchored today: a COUNT=1 anchored days ago has already spent its one
  // occurrence and materializes nothing.
  seedTask("t_once", "register for class", "FREQ=DAILY;COUNT=1", "09:00",
    localToUtc(2026, 8, 24, 0, 0, TZ));
  await runTick(env, localToUtc(2026, 8, 24, 9, 0, TZ));
  const db = new Db(d1);
  const live = await db.liveForUser("u1", iso(T0));

  await applyIntent(
    intentFor({ target: { instance_number: null, instance_id: live[0].id, task_query: null }, source: "button" }),
    await db.user("u1"), db, env, live, T0,
  );
  assert.equal(d1.q(`SELECT state FROM reminder_instances`)[0].state, "acknowledged");
  assert.equal(d1.q(`SELECT active FROM tasks`)[0].active, 0, "no 'Already happened' purgatory");
});

// --------------------------------------------------------- stale-message guard

test("a text command that arrives late is refused, not misapplied", async () => {
  seedTask("t_protein", "Buy protein powder", "FREQ=DAILY", "09:00");
  await runTick(env, localToUtc(2026, 8, 24, 9, 0, TZ));

  // handleInbound reads the REAL clock (it is the real-time entry point), so
  // this test must not depend on how many materialized occurrences have come
  // due by the wall-clock date the suite happens to run on. "done 1" pins the
  // target by number; a bare "done" would ask "which one?" on a two-live day.
  const sentAt = Math.floor((T0 - 74 * 60_000) / 1000);
  await worker.fetch(
    new Request("https://bot.example.com/webhook/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, chat: { id: "9999" }, text: "done 1", date: sentAt },
      }),
    }),
    env, ctx,
  );
  await settle();

  const states = d1.q(`SELECT state FROM reminder_instances ORDER BY scheduled_for`).map((r) => r.state);
  assert.ok(!states.includes("acknowledged") && !states.includes("skipped"), "nothing was closed");
  const reply = sent.filter((s) => s.kind === "telegram").at(-1);
  assert.match(reply.text, /took \d+ minutes to reach me/);
  assert.match(reply.text, /Buy protein powder/, "and it shows what IS open");
});

// ------------------------------------------------- catch-up close-before-send

test("catch-up closes items before announcing them, so a crash cannot repeat the digest", async () => {
  seedTask("t1", "ab workout", "FREQ=DAILY", "19:00");
  await runTick(env, localToUtc(2026, 8, 22, 18, 30, TZ)); // materialize
  // Simulate the weekend: everything went stale, and the digest SEND fails
  // (the worker dying mid-send is equivalent).
  const revival = localToUtc(2026, 8, 24, 3, 0, TZ);
  globalThis.fetch = async () => { throw new Error("worker died mid-send"); };

  const r = await runTick(env, revival);
  assert.ok(r.caughtUp >= 1);

  // The items are closed EVEN THOUGH the digest never went out — so the next
  // tick has nothing stale and cannot spam a second digest.
  sent = installFetchCapture();
  const again = await runTick(env, revival + 60_000);
  assert.equal(again.caughtUp, 0, "no re-digest");
  assert.equal(sent.filter((s) => s.kind === "telegram" && /offline/i.test(s.text)).length, 0);
});

// ------------------------------------------------------------------- tick_log

test("every tick leaves a row, and a dying tick leaves its error", async () => {
  d1.exec(`DELETE FROM tick_log`); // beforeEach seeds a freshness row; count from zero
  await runTick(env, T0);
  let rows = d1.q(`SELECT ok, error FROM tick_log`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 1);

  // Poison one phase: a task whose policy vanished mid-flight is harmless,
  // so instead break the DB out from under a later phase.
  const db = new Db(d1);
  const orig = db.constructor.prototype.expireOverdue;
  db.constructor.prototype.expireOverdue = async () => { throw new Error("phase C exploded"); };
  await runTick(env, T0 + 60_000);
  db.constructor.prototype.expireOverdue = orig;

  rows = d1.q(`SELECT ok, error FROM tick_log ORDER BY ran_at`);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ok, 0);
  assert.match(rows[1].error, /phase C exploded/);
});

// --------------------------------------------------- inbound takeover on death

test("a message the worker died on can be reprocessed by a retry", async () => {
  const db = new Db(d1);
  const msg = { providerMessageId: "m1", channelKind: "telegram", senderId: "9999", text: "done" };

  assert.equal(await db.claimInbound(msg, T0), true, "first delivery claims");
  // Worker dies here: handled_at never set. An immediate retry is still deduped…
  assert.equal(await db.claimInbound(msg, T0 + 30_000), false, "fast retry deduped");
  // …but after the grace period a retry takes over instead of being swallowed.
  assert.equal(await db.claimInbound(msg, T0 + 3 * 60_000), true, "late retry reprocesses");

  // Once HANDLED, no retry ever reprocesses it.
  await db.markInboundHandled("m1");
  assert.equal(await db.claimInbound(msg, T0 + 10 * 60_000), false);
});

test("a /health hit revives a dead scheduler, and is a no-op under a live one", async () => {
  // 25 Aug: the platform cron silently stopped for 80+ minutes while every
  // tick that DID run was healthy. Any monitoring ping is now a backup
  // scheduler: idempotent, lease-guarded, and inert when cron is fine.
  seedTask("t1", "morning thing", "FREQ=DAILY", "09:00");
  d1.exec(`DELETE FROM tick_log`); // simulate the dead scheduler
  const hit = () =>
    worker.fetch(new Request("https://bot.example.com/health"), env, ctx).then(settle);

  // No tick has ever run -> revive runs one.
  await hit();
  assert.equal(d1.q(`SELECT COUNT(*) n FROM tick_log`)[0].n, 1, "revived from cold");

  // Fresh tick_log -> the next hit does nothing.
  await hit();
  assert.equal(d1.q(`SELECT COUNT(*) n FROM tick_log`)[0].n, 1, "no-op while healthy");
});
