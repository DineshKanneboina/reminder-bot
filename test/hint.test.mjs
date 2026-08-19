/**
 * Phase 2: nag-time hints.
 *
 * The hint is a garnish on the send path. Almost every test here is about it
 * failing — the only behaviour that really matters is that a nag goes out
 * unchanged whenever the model is slow, broken, absent, or says something
 * strange.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import { runTick } from "../build/tick.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { parseKeyword } from "../build/parser.js";
import { firstStepHint, sanitize } from "../build/hint.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const T0 = localToUtc(2026, 8, 11, 9, 0, TZ);
const iso = (ms) => new Date(ms).toISOString();

let d1, env, sent;

/** A Workers AI stand-in. `reply` may throw, hang, or return anything. */
const fakeAI = (reply) => ({
  calls: [],
  async run(model, inputs) {
    this.calls.push({ model, inputs });
    return typeof reply === "function" ? reply(inputs) : reply;
  },
});

beforeEach(() => {
  d1 = new FakeD1(["schema.sql", "seed.sql"]);
  env = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "fake",
    MATERIALIZE_HORIZON_HOURS: "48",
    STALE_FLOOR_HOURS: "2",
    BOARD_ENABLED: "0",
  };
  sent = installFetchCapture();
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
    INSERT INTO escalation_policies
      (id,user_id,name,ladder_minutes,channel_ladder,give_up_after_minutes,quiet_start,quiet_end,max_concurrent,tier)
    VALUES ('pol_push',NULL,'push','[10,20]','["primary"]',180,NULL,NULL,4,'urgent');
  `);
});

function seedTask(opts = {}) {
  const dtstart = iso(Date.parse("2026-08-10T00:00:00Z"));
  d1.exec(`
    INSERT INTO tasks VALUES (
      '${opts.id ?? "t1"}','u1','${opts.title ?? "Build shelf"}',
      ${opts.notes ? `'${opts.notes}'` : "NULL"},
      'FREQ=DAILY','${dtstart}','09:00','${TZ}',
      '${opts.policy ?? "pol_push"}','supersede',1,'${dtstart}','${dtstart}');
  `);
}

const nags = () => sent.filter((s) => s.kind === "telegram").map((s) => s.text);

// ------------------------------------------------------------------ sanitize

test("model output is reduced to one plain line, or dropped", () => {
  assert.equal(sanitize("  Clear one shelf of books.  "), "Clear one shelf of books.");
  assert.equal(sanitize("Find\nthe\ndrill"), "Find the drill", "newlines collapse");
  assert.equal(sanitize('"Open the toolbox"'), "Open the toolbox", "quotes stripped");

  // Dropped: markup would break an HTML message, and a link is never a step.
  assert.equal(sanitize("Go <b>now</b>"), null);
  assert.equal(sanitize("See https://example.com for parts"), null);
  // Dropped: the model talking about itself instead of answering.
  assert.equal(sanitize("As an AI, I cannot help with that"), null);
  assert.equal(sanitize("Sure! Here's a first step: open the box"), null);
  assert.equal(sanitize("   "), null);
  assert.equal(sanitize("ok"), null, "too short to be a step");

  const long = sanitize("Take " + "a very deliberate step ".repeat(20));
  assert.ok(long.length <= 91, "capped");
  assert.ok(long.endsWith("…"), "and marked as truncated");
});

// ------------------------------------------------------------------ the call

test("a hint reaches the nag when the model behaves", async () => {
  seedTask({ notes: "the brackets are already in the hallway" });
  env.AI = fakeAI({ response: "Put the brackets by the wall." });

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1);
  assert.match(nags()[0], /Put the brackets by the wall\./);
  assert.match(nags()[0], /💡/);

  // The task's notes are what make the hint specific, so they must be sent.
  const [call] = env.AI.calls;
  assert.match(JSON.stringify(call.inputs), /brackets are already in the hallway/);
  assert.match(JSON.stringify(call.inputs), /Build shelf/);
});

test("a slow model does not hold up the nag", async () => {
  seedTask();
  // Far longer than the 1200ms timeout; the nag must not wait for it. unref so
  // the abandoned generation doesn't hold node's event loop open for 30s after
  // the assertions pass — the real runtime tears it down with the request.
  env.AI = fakeAI(
    () =>
      new Promise((res) => {
        setTimeout(() => res({ response: "too late" }), 30_000).unref?.();
      }),
  );

  const started = Date.now();
  const r = await runTick(env, T0);
  const elapsed = Date.now() - started;

  assert.equal(r.sent, 1, "the nag went out");
  assert.ok(elapsed < 5000, `sent in ${elapsed}ms rather than waiting on the model`);
  assert.doesNotMatch(nags()[0], /too late/);
  assert.doesNotMatch(nags()[0], /💡/);
  assert.match(nags()[0], /Build shelf/, "and it is the normal nag");
});

test("a broken model is indistinguishable from no model at all", async () => {
  for (const broken of [
    () => { throw new Error("model unavailable"); },
    () => Promise.reject(new Error("out of neurons")),
    { response: "" },
    { response: "Visit https://spam.example" },
    { nonsense: true },
    null,
  ]) {
    d1.exec(`DELETE FROM reminder_instances; DELETE FROM tasks;`);
    sent.length = 0;
    seedTask();
    env.AI = fakeAI(broken);

    const r = await runTick(env, T0);
    assert.equal(r.sent, 1, `sent despite ${JSON.stringify(broken)}`);
    assert.doesNotMatch(nags()[0], /💡/);
  }
});

test("no AI binding means the nag is exactly what it was before hints", async () => {
  seedTask();
  const r = await runTick(env, T0);
  assert.equal(r.sent, 1);
  assert.doesNotMatch(nags()[0], /💡/);
  assert.match(nags()[0], /⏰ <b>Build shelf<\/b>/);
});

test("HINTS_ENABLED=0 turns them off without touching the model", async () => {
  seedTask();
  env.AI = fakeAI({ response: "Should never appear." });
  env.HINTS_ENABLED = "0";

  await runTick(env, T0);
  assert.equal(env.AI.calls.length, 0, "not even called");
  assert.doesNotMatch(nags()[0], /💡/);
});

test("hints are budgeted per tick so a busy tick still sends promptly", async () => {
  for (let i = 1; i <= 4; i++) seedTask({ id: `t${i}`, title: `task ${i}` });
  env.AI = fakeAI({ response: "Start with the smallest piece." });
  env.HINT_BUDGET_PER_TICK = "2";

  const r = await runTick(env, T0);
  assert.equal(r.sent, 4, "all four nags went out");
  assert.equal(env.AI.calls.length, 2, "but only two hints were generated");
  assert.equal(nags().filter((t) => /💡/.test(t)).length, 2);
});

test("a batched message gets no hint", async () => {
  // max_concurrent is 4, so five due reminders collapse into one message. One
  // suggestion attached to five tasks would be worse than none.
  for (let i = 1; i <= 5; i++) seedTask({ id: `t${i}`, title: `task ${i}` });
  env.AI = fakeAI({ response: "Start somewhere." });

  await runTick(env, T0);
  assert.equal(nags().length, 1);
  assert.match(nags()[0], /5 open/);
  assert.equal(env.AI.calls.length, 0);
  assert.doesNotMatch(nags()[0], /💡/);
});

// ------------------------------------------------------------------- capture

test("'note for <task>: ...' is a keyword path, and feeds the hint", async () => {
  seedTask();
  const p = parseKeyword("note for shelf: the wood is already cut", []);
  assert.equal(p.intent, "set_notes");
  assert.equal(p.source, "keyword", "capturing context must not cost a model call");
  assert.equal(p.target.task_query, "shelf");
  assert.equal(p.task.notes, "the wood is already cut");

  const db = new Db(d1);
  const reply = await applyIntent(p, await db.user("u1"), db, env, [], T0);
  assert.match(reply.text, /Noted on <b>Build shelf<\/b>/);
  assert.equal((await db.tasksForUser("u1"))[0].notes, "the wood is already cut");

  env.AI = fakeAI({ response: "Measure the first bracket." });
  await runTick(env, T0);
  assert.match(JSON.stringify(env.AI.calls[0].inputs), /wood is already cut/);
});

test("a bare 'note: ...' attaches to what was just created", async () => {
  const db = new Db(d1);
  const user = await db.user("u1");
  const create = {
    intent: "create", confidence: 1,
    target: { instance_number: null, instance_id: null, task_query: null },
    task: { title: "renew passport", notes: null, rrule: "FREQ=DAILY;COUNT=1",
            local_time: "09:00", start_date: "2026-08-20", policy: null, overlap: null },
    snooze_minutes: null, timezone: null, quiet_hours: null, pause_minutes: null,
    clarifying_question: null, source: "llm",
  };
  const made = await applyIntent(create, user, db, env, [], T0);
  assert.match(made.text, /note: why this matters/, "and it invites the note");

  const reply = await applyIntent(parseKeyword("note: the office closes at 4", []), user, db, env, [], T0);
  assert.match(reply.text, /Noted on <b>renew passport<\/b>/);
  assert.equal((await db.tasksForUser("u1"))[0].notes, "the office closes at 4");
});

test("a bare note with nothing recent asks rather than guessing", async () => {
  seedTask(); // created 2026-08-10, well outside the window
  const db = new Db(d1);
  const reply = await applyIntent(
    parseKeyword("note: something", []), await db.user("u1"), db, env, [], T0,
  );
  assert.match(reply.text, /Which one\?/);
  assert.equal((await db.tasksForUser("u1"))[0].notes, null, "nothing was written");
});
