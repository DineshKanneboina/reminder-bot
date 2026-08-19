/**
 * One-off events: "set up a doctor's appointment on September 3rd at 2pm".
 *
 * These are encoded as FREQ=DAILY;COUNT=1 anchored to an explicit dtstart. The
 * anchor is the whole game — the rule itself carries no date, so a one-off
 * whose dtstart is wrong fires on the wrong day, and COUNT=1 means it gets
 * exactly one chance to be wrong.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import { runTick } from "../build/tick.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { parseKeyword } from "../build/parser.js";
import { localToUtc } from "../build/time.js";
import { installFetchCapture as _cap } from "./d1-shim.mjs";

const TZ = "America/Chicago";
/** Wednesday 19 August 2026, 10:00 local — mid-morning, so "today at 09:00" is past. */
const NOW = localToUtc(2026, 8, 19, 10, 0, TZ);

let d1, env, sent;

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
  `);
});

/** What the model emits for "remind me to X on <date> at <time>". */
const intent = (overrides = {}) => {
  const { task = {}, ...rest } = overrides;
  return {
    intent: "create",
    confidence: 1,
    target: { instance_number: null, instance_id: null, task_query: null, ...(rest.target ?? {}) },
    task: {
      title: null, rrule: null, local_time: null, start_date: null,
      policy: null, overlap: null, ...task,
    },
    snooze_minutes: null, timezone: null, quiet_hours: null, pause_minutes: null,
    clarifying_question: null, source: "llm",
    ...rest,
  };
};

const apply = async (p, now = NOW) => {
  const db = new Db(d1);
  return applyIntent(p, await db.user("u1"), db, env, [], now);
};

const scheduled = () =>
  d1.q(`SELECT scheduled_for FROM reminder_instances ORDER BY scheduled_for`)
    .map((r) => Date.parse(r.scheduled_for));

// ---------------------------------------------------------------------------

test("a dated one-off lands on its date, not the day it was asked for", async () => {
  const reply = await apply(intent({
    task: {
      title: "doctor's appointment",
      rrule: "FREQ=DAILY;COUNT=1",
      local_time: "14:00",
      start_date: "2026-09-03",
    },
  }));
  assert.match(reply.text, /once, Thu 3 Sep at 2:00 pm/);

  const [task] = await new Db(d1).tasksForUser("u1");
  assert.equal(
    Date.parse(task.dtstart),
    localToUtc(2026, 9, 3, 0, 0, TZ),
    "dtstart is anchored to the named day, not to creation time",
  );

  // Two weeks out, so today's tick must not invent anything.
  await runTick(env, NOW);
  assert.deepEqual(scheduled(), [], "nothing materialized two weeks ahead");

  // And on the day it is exactly one occurrence, at the right hour.
  const appointment = localToUtc(2026, 9, 3, 14, 0, TZ);
  await runTick(env, appointment - 3600_000);
  assert.deepEqual(scheduled(), [appointment]);
});

test("a one-off never repeats, however many ticks run", async () => {
  await apply(intent({
    task: {
      title: "register for class",
      rrule: "FREQ=DAILY;COUNT=1",
      local_time: "09:00",
      start_date: "2026-08-20",
    },
  }));
  const at = localToUtc(2026, 8, 20, 9, 0, TZ);

  await runTick(env, at - 3600_000);
  await runTick(env, at);
  for (const day of [1, 2, 3, 7]) await runTick(env, at + day * 86400_000);

  assert.deepEqual(scheduled(), [at], "one occurrence, ever");
});

test("a one-off whose date has gone is refused, not stored dead", async () => {
  // Storing it would leave something in the tasks list that looks scheduled
  // and can never fire, which is exactly the state that made the list
  // untrustworthy in the first place.
  const reply = await apply(intent({
    task: {
      title: "call the bank",
      rrule: "FREQ=DAILY;COUNT=1",
      local_time: "09:00",
      start_date: "2026-08-10",
    },
  }));

  assert.match(reply.text, /already passed/);
  assert.match(reply.text, /Mon 10 Aug at 9:00 am/, "and says exactly when it would have been");
  assert.equal((await new Db(d1).tasksForUser("u1")).length, 0, "nothing was stored");
});

test("moving a one-off to a new date re-anchors it", async () => {
  await apply(intent({
    task: {
      title: "doctor's appointment",
      rrule: "FREQ=DAILY;COUNT=1",
      local_time: "14:00",
      start_date: "2026-09-03",
    },
  }));

  const reply = await apply(intent({
    intent: "update",
    target: { task_query: "doctor" },
    task: { start_date: "2026-09-10" },
  }));
  assert.match(reply.text, /once, Thu 10 Sep at 2:00 pm/);

  const [task] = await new Db(d1).tasksForUser("u1");
  assert.equal(Date.parse(task.dtstart), localToUtc(2026, 9, 10, 0, 0, TZ));

  const moved = localToUtc(2026, 9, 10, 14, 0, TZ);
  await runTick(env, moved - 3600_000);
  assert.deepEqual(scheduled(), [moved], "and it fires on the new date only");
});

test("a recurring task with no date still anchors to now", async () => {
  // The old behaviour, which the dated path must not disturb: created at 10:00
  // with an 06:30 rule, it starts tomorrow rather than nagging about a time
  // that has already gone today.
  const reply = await apply(intent({
    task: { title: "stretch", rrule: "FREQ=DAILY", local_time: "06:30" },
  }));
  assert.match(reply.text, /daily at 6:30 am/);

  const [task] = await new Db(d1).tasksForUser("u1");
  assert.equal(Date.parse(task.dtstart), NOW);

  await runTick(env, NOW);
  assert.equal(scheduled()[0], localToUtc(2026, 8, 20, 6, 30, TZ), "first one is tomorrow");
});

test("converting a long-running daily task to a one-off re-anchors it", async () => {
  // This is the repair path for a task that should never have recurred. Its
  // dtstart is weeks old, so keeping it would make the single occurrence
  // COUNT=1 allows land in the past — spent before it ever fires.
  d1.exec(`
    INSERT INTO tasks VALUES ('t1','u1','book Thailand flight',NULL,'FREQ=DAILY',
      '${new Date(localToUtc(2026, 7, 20, 9, 0, TZ)).toISOString()}','21:00','${TZ}',
      'pol_default','supersede',1,'2026-07-20T00:00:00Z','2026-07-20T00:00:00Z');
  `);

  const p = parseKeyword("make book thailand flight a one-off", []);
  assert.equal(p.intent, "update");
  assert.equal(p.source, "keyword", "the repair must not cost a model call");
  assert.equal(p.task.rrule, "FREQ=DAILY;COUNT=1");

  // A schedule change is confirmed first, and the prompt must state the real
  // time (21:00) rather than falling back to a default the task never had.
  const ask = await apply(p);
  assert.match(ask.text, /Change <b>book Thailand flight<\/b> to once, Wed 19 Aug at 9:00 pm\?/);
  assert.doesNotMatch(ask.text, /9:00 am/);
  assert.equal(
    (await new Db(d1).tasksForUser("u1"))[0].rrule,
    "FREQ=DAILY",
    "nothing changes before confirmation",
  );

  const reply = await apply(parseKeyword("y", []));
  assert.match(reply.text, /once, Wed 19 Aug at 9:00 pm/);

  const [task] = await new Db(d1).tasksForUser("u1");
  assert.equal(task.rrule, "FREQ=DAILY;COUNT=1");
  assert.equal(Date.parse(task.dtstart), NOW, "re-anchored to now, not left in July");

  // And it really does fire — once — tonight.
  const tonight = localToUtc(2026, 8, 19, 21, 0, TZ);
  await runTick(env, tonight);
  assert.deepEqual(scheduled(), [tonight]);
  for (const day of [1, 2, 5]) await runTick(env, tonight + day * 86400_000);
  assert.deepEqual(scheduled(), [tonight], "and never again");
});

const nags = () => sent.filter((s) => s.kind === "telegram").map((s) => s.text);

test("a one-off pushes at the time it was asked for, not four hours later", async () => {
  // The reason this is not just "quiet tier behaviour": "remind me at 10:27" is
  // a moment the user picked. Parking it until 14:27 answers a question nobody
  // asked. Standing habits still wait — that is covered in board.test.mjs.
  await apply(intent({
    task: {
      title: "brush my teeth",
      rrule: "FREQ=DAILY;COUNT=1",
      local_time: "10:30",
      start_date: "2026-08-19",
    },
  }));
  const at = localToUtc(2026, 8, 19, 10, 30, TZ);

  const early = await runTick(env, at - 60_000);
  assert.equal(early.sent, 0, "nothing before its time");

  const r = await runTick(env, at);
  assert.equal(r.parked, 0, "a chosen moment is never parked");
  assert.equal(r.sent, 1);
  assert.match(nags()[0], /brush my teeth/);
});

test("a recurring task at the same hour still waits on the board", async () => {
  // Same policy, same clock time, different rule — the one-off exemption must
  // not quietly turn quiet-by-default off for everything.
  await apply(intent({
    task: { title: "stretch", rrule: "FREQ=DAILY", local_time: "10:30" },
  }));
  const at = localToUtc(2026, 8, 20, 10, 30, TZ);

  const r = await runTick(env, at);
  assert.equal(r.sent, 0, "habits still go to the board first");
  assert.equal(r.parked, 1);
  assert.equal(nags().length, 0);
});
