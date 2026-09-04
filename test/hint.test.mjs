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

const nags = () => sent.filter((s) => s.kind === "telegram" && s.method === "sendMessage").map((s) => s.text);
/** Hints arrive by EDIT after the nag is already delivered — the send path
 *  never waits on the model. These are the enhancement passes. */
const hintEdits = () => sent.filter((s) => s.kind === "telegram" && s.method === "editMessageText").map((s) => s.text);
/** The per-task half of the prompt. The system half mentions "About them" in
 *  its rules, so asserting against the whole payload matches spuriously. */
const askedAbout = (call) => call.inputs.messages.at(-1).content;

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
  // Small models copy the arrow format used by the examples in the prompt.
  assert.equal(sanitize("→ Open the toolbox"), "Open the toolbox");
  assert.equal(sanitize("Reply: Open the toolbox"), "Open the toolbox");

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
  assert.equal(r.hinted, 1, "and the tick reports it, so a broken model is visible");
  // The nag itself goes out PLAIN and instantly; the hint is edited in after.
  // A platform kill during the model wait now costs the hint, never the nag.
  assert.doesNotMatch(nags()[0], /💡/, "delivery never waits for the model");
  assert.match(hintEdits()[0], /Put the brackets by the wall\./);
  assert.match(hintEdits()[0], /💡/);

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
  let nagsOutWhenModelFirstAsked = -1;
  env.AI = fakeAI(() => {
    if (nagsOutWhenModelFirstAsked < 0) nagsOutWhenModelFirstAsked = nags().length;
    return new Promise((res) => {
      setTimeout(() => res({ response: "too late" }), 30_000).unref?.();
    });
  });

  const started = Date.now();
  const r = await runTick(env, T0);
  const elapsed = Date.now() - started;

  assert.equal(r.sent, 1, "the nag went out");
  // The structural property: the notification was already delivered before
  // the model was consulted at all. The timeout then bounds the tick.
  assert.equal(nagsOutWhenModelFirstAsked, 1, "sent before the model was ever asked");
  assert.ok(elapsed < 8000, `tick bounded by the timeout, took ${elapsed}ms`);
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
  assert.equal(hintEdits().length, 2, "two nags were enhanced after delivery");
  assert.equal(nags().filter((t) => /💡/.test(t)).length, 0, "none inline");
});

test("a batched message gets no hint", async () => {
  // max_concurrent is 4, so five due reminders collapse into one message. One
  // suggestion attached to five tasks would be worse than none.
  for (let i = 1; i <= 5; i++) seedTask({ id: `t${i}`, title: `task ${i}` });
  env.AI = fakeAI({ response: "Start somewhere." });

  await runTick(env, T0);
  assert.equal(nags().length, 1);
  assert.match(nags()[0], /5 due at once/);
  assert.doesNotMatch(nags()[0], /💡/);
  assert.equal(hintEdits().length, 0, "nothing edited into a batch either");
  // (Preparing hints for the items' LATER single nudges is fine and budgeted.)
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
  assert.match(askedAbout(env.AI.calls[0]), /wood is already cut/);
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

test("the default model is one this account actually has", async () => {
  // A wrong model id is the one failure mode with no symptom: every hint
  // returns null and the nags look exactly like a quiet model. The first
  // default shipped was @cf/meta/llama-3.1-8b-instruct, which does not exist —
  // check `npx wrangler ai models` before changing this.
  seedTask();
  let asked = null;
  env.AI = { async run(model) { asked = model; return { response: "Start there." }; } };

  await runTick(env, T0);
  assert.equal(asked, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
});

test("a tick that sends but never hints is visible in the report", async () => {
  seedTask();
  env.AI = fakeAI(() => { throw new Error("no such model"); });

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1);
  assert.equal(r.hinted, 0, "sent > 0 with hinted 0 is the broken-model signature");
});

test("a hint that only restates the task is dropped", () => {
  // The failure this kills: a "first step" that is the task again, at the same
  // altitude, telling you nothing the nag did not already say.
  assert.equal(sanitize("Build the shelf.", "Build shelf"), null);
  assert.equal(sanitize("Start building the shelf", "Build shelf"), null);
  assert.equal(sanitize("Update your resume.", "update resume"), null);

  // Anything that adds a real action survives.
  assert.equal(
    sanitize("Open last year's version and read the top.", "update resume"),
    "Open last year's version and read the top.",
  );
  assert.equal(
    sanitize("Check the cupboard for the old tub.", "Buy protein powder"),
    "Check the cupboard for the old tub.",
  );
  // With no title to compare against, nothing is dropped on this rule.
  assert.equal(sanitize("Build the shelf."), "Build the shelf.");
});

test("the restatement rule reaches the send path", async () => {
  seedTask({ title: "Build shelf" });
  env.AI = fakeAI({ response: "Build the shelf." });

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1, "the nag still goes out");
  assert.equal(r.hinted, 0, "but carries no hint");
  assert.doesNotMatch(nags()[0], /💡/);
});

// --------------------------------------------------------------- preferences

test("standing facts reach the hint prompt", async () => {
  seedTask({ title: "Buy protein powder" });
  const db = new Db(d1);
  await db.addPreference("u1", "I use Ryse protein", "2026-08-01T00:00:00Z");
  await db.addPreference("u1", "I shop at Costco", "2026-08-01T00:01:00Z");
  env.AI = fakeAI({ response: "Check if Ryse is in stock before leaving." });

  const r = await runTick(env, T0);
  assert.equal(r.hinted, 1);

  const prompt = askedAbout(env.AI.calls[0]);
  assert.match(prompt, /About them/);
  assert.match(prompt, /- I use Ryse protein/);
  assert.match(prompt, /- I shop at Costco/);
  assert.match(hintEdits()[0], /Check if Ryse is in stock/);
});

test("no facts means the prompt is exactly what it was", async () => {
  seedTask();
  env.AI = fakeAI({ response: "Clear one shelf." });
  await runTick(env, T0);
  assert.doesNotMatch(askedAbout(env.AI.calls[0]), /About them/);
});

test("remember and forget are keyword paths", async () => {
  const db = new Db(d1);
  const user = await db.user("u1");

  const p1 = parseKeyword("remember: I use Ryse protein", []);
  assert.equal(p1.intent, "remember");
  assert.equal(p1.source, "keyword", "must not cost a model call");
  assert.equal(p1.memory, "I use Ryse protein");
  await applyIntent(p1, user, db, env, [], T0);

  await applyIntent(parseKeyword("remember: I shop at Costco", []), user, db, env, [], T0);
  const listed = await applyIntent(parseKeyword("preferences", []), user, db, env, [], T0);
  assert.match(listed.text, /1\. I use Ryse protein/);
  assert.match(listed.text, /2\. I shop at Costco/);

  const dropped = await applyIntent(parseKeyword("forget 1", []), user, db, env, [], T0);
  assert.match(dropped.text, /Forgotten/);
  const left = await db.preferences("u1");
  assert.deepEqual(left.map((f) => f.text), ["I shop at Costco"]);
});

test("forgetting something that isn't there asks rather than guessing", async () => {
  const db = new Db(d1);
  const user = await db.user("u1");
  const empty = await applyIntent(parseKeyword("forget 3", []), user, db, env, [], T0);
  assert.match(empty.text, /not remembering anything/);

  await applyIntent(parseKeyword("remember: I use Ryse protein", []), user, db, env, [], T0);
  const outOfRange = await applyIntent(parseKeyword("forget 9", []), user, db, env, [], T0);
  assert.match(outOfRange.text, /Forget which\?/);
  assert.equal((await db.preferences("u1")).length, 1, "nothing was deleted");
});

test("every nudge carries a hint, and the model knows which nudge it is", async () => {
  // Owner's decision (24 Aug), reversing once-per-chain: each notification
  // gets its own suggestion, and the prompt escalates with attempt_count so
  // nudge three can say something different from nudge one.
  seedTask(); // pol_push, ladder [10,20]
  env.AI = fakeAI({ response: "Clear one shelf of books." });

  await runTick(env, T0);
  // The real cron ticks every minute; the one at +20 is what prepares the
  // +30 nudge's hint inside the 10-minute window.
  for (const m of [10, 20, 30]) await runTick(env, T0 + m * 60_000);

  assert.equal(nags().length, 3);
  assert.equal(env.AI.calls.length, 3, "one generation per notification");
  // Nudge one had nothing prepared (the task was due the moment it existed),
  // so its hint was edited in. Each later nudge's hint was prepared right
  // after the previous send and rode the notification itself.
  assert.equal(hintEdits().length, 1, "only the first needed the fallback edit");
  assert.doesNotMatch(nags()[0], /💡/);
  assert.match(nags()[1], /💡/, "nudge two: inline, no model wait");
  assert.match(nags()[2], /💡/, "nudge three: inline, no model wait");
  // Later nudges tell the model how long this has been ignored.
  assert.match(askedAbout(env.AI.calls[1]), /ignored this 2 times/);
  assert.match(askedAbout(env.AI.calls[2]), /ignored this 3 times/);
});

test("the hint timeout is configurable, and still bounds the send", async () => {
  seedTask();
  env.HINT_TIMEOUT_MS = "200";
  env.AI = fakeAI(
    () => new Promise((res) => { setTimeout(() => res({ response: "late" }), 9000).unref?.(); }),
  );

  const started = Date.now();
  const r = await runTick(env, T0);
  const elapsed = Date.now() - started;

  assert.equal(r.sent, 1);
  assert.ok(elapsed < 3000, `sent in ${elapsed}ms, honouring the shorter timeout`);
  assert.doesNotMatch(nags()[0], /💡/);
});

test("an unrecognized response shape is reported, not silently empty", async () => {
  // A model that returns { output } instead of { response } would otherwise
  // produce no hints forever, indistinguishable from a model with nothing to
  // say. This is the same silence that hid a wrong model id for an hour.
  seedTask();
  env.AI = fakeAI({ output: "Clear one shelf." });

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1, "the nag still goes out");
  assert.equal(r.hinted, 0);
  assert.doesNotMatch(nags()[0], /💡/);
});

test("asking what the bot knows about you is not answered with the manual", () => {
  // The help catch-all matches "what do you ...", so this used to return the
  // command list instead of the standing facts it was actually asking for.
  for (const phrase of ["preferences", "about me", "what do you know about me"]) {
    assert.equal(parseKeyword(phrase, []).intent, "preferences", phrase);
  }
  // and the general questions still reach help
  assert.equal(parseKeyword("what can you do", []).intent, "help");
  assert.equal(parseKeyword("how do i use this", []).intent, "help");
});

test("gpt-oss's OpenAI-style response shape is understood", async () => {
  // The real production failure of 22-24 Aug: gpt-oss returns
  // { choices: [{ message: { content } }] }, not { response }, despite the
  // model docs. Every hint died at extraction for three days.
  seedTask({ notes: "the tub is in the garage" });
  env.AI = fakeAI({
    choices: [{ message: { content: "Check the garage shelf for the old tub." } }],
    model: "gpt-oss-120b", object: "chat.completion",
  });

  const r = await runTick(env, T0);
  assert.equal(r.hinted, 1);
  assert.match(hintEdits()[0], /Check the garage shelf/);
});

test("a prepared hint rides the notification itself", async () => {
  // Edited-in hints reached the chat but never the lock screen: a push
  // notification is built from the first version of a message (owner, 2 Sep).
  // So the hint is generated minutes AHEAD, stored, and sent inline — with no
  // model call anywhere near the claim→send stretch.
  seedTask();
  env.AI = fakeAI({ response: "Put the brackets by the wall." });

  const early = await runTick(env, T0 - 5 * 60_000);
  assert.equal(early.sent, 0, "nothing is due yet");
  assert.equal(early.prepared, 1, "but the hint for the coming nag is ready");
  assert.equal(env.AI.calls.length, 1);

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1);
  assert.equal(r.hinted, 1);
  assert.match(nags()[0], /💡 <i>Put the brackets by the wall\.<\/i>/, "in the message that notifies");
  assert.equal(hintEdits().length, 0, "no edit needed");
  const row = await d1.prepare("SELECT last_hint, next_hint FROM reminder_instances").first();
  assert.equal(row.last_hint, "Put the brackets by the wall.", "recorded as shown");
});
