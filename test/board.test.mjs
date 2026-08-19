/**
 * Phase 1: the daily board and quiet-by-default routing.
 *
 * The other tick tests deliberately run with BOARD_ENABLED=0 and a pushing
 * policy, because they pin the escalation machine. This file is the opposite:
 * the board is on, policies are the real seeded ones, and what's under test is
 * whether an ordinary reminder stays quiet and whether the board tells the
 * truth about the day.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import worker from "../build/index.js";
import { runTick } from "../build/tick.js";
import { BOARD_MARKER, syncBoard } from "../build/board.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { parseButton, parseKeyword } from "../build/parser.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const SECRET = "hook-secret";
const iso = (ms) => new Date(ms).toISOString();

/** A Tuesday in August 2026, 09:00 local Chicago. */
const T0 = localToUtc(2026, 8, 11, 9, 0, TZ);
const HOUR = 3600_000;

let d1, env, sent, ctx, pending;

beforeEach(() => {
  d1 = new FakeD1(["schema.sql", "seed.sql"]);
  env = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "fake",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    MATERIALIZE_HORIZON_HOURS: "48",
    STALE_FLOOR_HOURS: "2",
    QUIET_AGING_HOURS: "4",
    BOARD_HOUR: "07:00",
  };
  sent = installFetchCapture();
  pending = [];
  ctx = { waitUntil: (p) => (pending.push(p), p), passThroughOnException() {} };
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
  `);
});

async function settle() {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

/** A daily task at a fixed local time, created "yesterday". */
function seedTask(localTime, opts = {}) {
  const dtstart = iso(Date.parse("2026-08-10T00:00:00Z"));
  d1.exec(`
    INSERT INTO tasks VALUES (
      '${opts.id ?? "t1"}','u1','${opts.title ?? "take out trash"}',NULL,
      '${opts.rrule ?? "FREQ=DAILY"}','${dtstart}','${localTime}','${TZ}',
      '${opts.policy ?? "pol_default"}','${opts.overlap ?? "supersede"}',1,
      '${dtstart}','${dtstart}');
  `);
}

const telegram = (m) => sent.filter((s) => s.kind === "telegram" && s.method === m);
/** A newly posted board, as opposed to a nag: same method, distinctive text. */
const boards = () => telegram("sendMessage").filter((s) => s.text?.startsWith(BOARD_MARKER));
const nags = () => telegram("sendMessage").filter((s) => !s.text?.startsWith(BOARD_MARKER));
const edits = () => telegram("editMessageText");
const pins = () => telegram("pinChatMessage");
const unpins = () => telegram("unpinChatMessage");

const instances = () =>
  d1.q(`SELECT id, scheduled_for, state, attempt_count, escalation_step,
               next_nag_at, give_up_at
          FROM reminder_instances ORDER BY scheduled_for`);

// ------------------------------------------------------------------ routing

test("a quiet reminder lands on the board instead of pushing", async () => {
  seedTask("09:00");
  const r = await runTick(env, T0);

  assert.equal(r.claimed, 1);
  assert.equal(r.parked, 1);
  assert.equal(r.sent, 0);
  assert.equal(nags().length, 0, "nothing was pushed");

  const [board] = boards();
  assert.ok(board, "but it is on the board");
  assert.match(board.text, /take out trash/);

  // Parked with its ladder untouched: waiting is not an attempt, and the first
  // real nag must arrive with all four rungs still ahead of it.
  const row = instances()[0];
  assert.equal(row.state, "pending");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.escalation_step, 0);
  assert.equal(Date.parse(row.next_nag_at), T0 + 4 * HOUR);
});

test("a quiet reminder starts nagging once it ages past the window", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  sent.length = 0;

  const r = await runTick(env, T0 + 4 * HOUR);
  assert.equal(r.sent, 1);

  const [nag] = nags();
  assert.match(nag.text, /take out trash/);
  assert.doesNotMatch(nag.text, /nudge/, "the quiet wait must not read as a nudge");

  // None of the ladder was spent waiting: this is indistinguishable from an
  // ordinary first nag, so the follow-up comes at the ladder's first rung.
  const row = instances()[0];
  assert.equal(row.attempt_count, 1);
  assert.equal(row.escalation_step, 1);
  assert.equal(Date.parse(row.next_nag_at), T0 + 4 * HOUR + 10 * 60_000);
});

test("the give-up window is stretched past the quiet wait, not consumed by it", async () => {
  // pol_default gives up after 180m but the quiet wait is 240m. Without the
  // extension the item would expire an hour before it was ever allowed to speak.
  seedTask("09:00");
  await runTick(env, T0);
  assert.ok(Date.parse(instances()[0].give_up_at) > T0 + 4 * HOUR);

  const r = await runTick(env, T0 + 4 * HOUR);
  assert.equal(r.expired, 0, "it must not be swept before its first nag");
  assert.equal(r.sent, 1);
});

test("the quiet wait is pushed past quiet hours rather than through them", async () => {
  // Due 21:00; four hours later is 01:00, inside the 22:00-07:00 quiet window.
  const due = localToUtc(2026, 8, 11, 21, 0, TZ);
  seedTask("21:00");
  await runTick(env, due);

  assert.equal(nags().length, 0);
  assert.equal(
    Date.parse(instances()[0].next_nag_at),
    localToUtc(2026, 8, 12, 7, 0, TZ),
    "a 21:00 item must not come alive at 01:00",
  );
});

test("an urgent reminder still pushes the moment it comes due", async () => {
  seedTask("09:00", { policy: "pol_urgent" });
  const r = await runTick(env, T0);

  assert.equal(r.parked, 0);
  assert.equal(r.sent, 1);
  assert.equal(nags().length, 1);
});

test("notify sends exactly one message and never follows up", async () => {
  seedTask("09:00", { policy: "pol_notify" });
  const r = await runTick(env, T0);
  assert.equal(r.sent, 1);

  const row = instances()[0];
  assert.equal(row.next_nag_at, null, "an empty ladder ends the chain after one send");

  for (const m of [30, 60, 120]) await runTick(env, T0 + m * 60_000);
  assert.equal(nags().length, 1, "still exactly one message hours later");
});

test("an unanswered notify item expires off the board", async () => {
  // Its next_nag_at is already NULL, so the expiry sweep must not key off that
  // column or the item sits on the board forever.
  seedTask("09:00", { policy: "pol_notify" }); // gives up after 180m
  await runTick(env, T0);
  assert.equal(instances()[0].next_nag_at, null);

  const r = await runTick(env, T0 + 181 * 60_000);
  assert.equal(r.expired, 1);
  assert.equal(instances()[0].state, "expired");
});

// -------------------------------------------------------------------- board

test("the board shows what is due, what is still coming, and what is done", async () => {
  seedTask("09:00", { id: "t1", title: "trash" });
  seedTask("14:00", { id: "t2", title: "standup" });
  await runTick(env, T0);

  const [board] = boards();
  assert.match(board.text, /<b>Due<\/b>/);
  assert.match(board.text, /1\. <b>trash<\/b>/);
  assert.match(board.text, /<b>Later today<\/b>/);
  assert.match(board.text, /standup/);
  assert.doesNotMatch(board.text, /<b>Done<\/b>/, "nothing is done yet");
});

test("board numbering and buttons both resolve to the exact instance", async () => {
  seedTask("09:00", { id: "t1", title: "trash" });
  seedTask("09:30", { id: "t2", title: "vitamins" });
  const now = T0 + HOUR;
  await runTick(env, now);

  const [board] = boards();
  assert.match(board.text, /1\. <b>trash<\/b>/);
  assert.match(board.text, /2\. <b>vitamins<\/b>/);

  const live = await new Db(d1).liveForUser("u1", iso(now));
  const buttons = board.markup.inline_keyboard.flat();
  assert.equal(buttons.length, 2);
  assert.equal(parseButton(buttons[0].callback_data).target.instance_id, live[0].id);
  assert.equal(parseButton(buttons[1].callback_data).target.instance_id, live[1].id);
});

test("the board says what was missed today, not just what was done", async () => {
  seedTask("09:00", { policy: "pol_urgent" }); // pushes on time, gives up after 120m
  await runTick(env, T0);
  assert.match(boards()[0].text, /<b>Due<\/b>/);
  sent.length = 0;

  const r = await runTick(env, T0 + 121 * 60_000);
  assert.equal(r.expired, 1);

  const [edit] = edits();
  assert.ok(edit, "the board was updated when it ran out of road");
  assert.match(edit.text, /<b>Missed<\/b>/);
  assert.match(edit.text, /take out trash · was 9:00 am/);
  assert.doesNotMatch(edit.text, /<b>Due<\/b>/, "it is no longer open");
  assert.doesNotMatch(edit.text, /<b>Done<\/b>/, "and it was certainly not done");
});

test("a carried-over item is dated, so it cannot read as today", async () => {
  // The real confusion this fixes: an 18:00 item left open overnight sat in
  // Due as "18:00" on a board headed with today's date, while today's fresh
  // 18:00 occurrence sat in Later today. Same title, same clock time, one of
  // them a day old, and nothing on the board said which.
  seedTask("18:00", { id: "t1", title: "plan Thailand" });
  const morning = localToUtc(2026, 8, 12, 8, 40, TZ);
  const lastNight = localToUtc(2026, 8, 11, 18, 0, TZ);
  const threeNights = localToUtc(2026, 8, 9, 18, 0, TZ);
  const tonight = localToUtc(2026, 8, 12, 18, 0, TZ);

  d1.exec(`
    INSERT INTO reminder_instances VALUES
      ('i_old','t1','u1','${iso(threeNights)}','notified',3,4,NULL,'${iso(morning + HOUR)}',NULL,NULL),
      ('i_last','t1','u1','${iso(lastNight)}','notified',11,4,NULL,'${iso(morning + HOUR)}',NULL,NULL),
      ('i_tonight','t1','u1','${iso(tonight)}','pending',0,0,'${iso(tonight)}','${iso(tonight + 3 * HOUR)}',NULL,NULL);
  `);

  const db = new Db(d1);
  await syncBoard(env, db, await db.user("u1"), morning);

  const [board] = boards();
  assert.match(board.text, /Wednesday, 12 Aug/);
  // Carried over: dated, and still numbered for `done 1` / `done 2`.
  assert.match(board.text, /1\. <b>plan Thailand<\/b> · Sun 9 Aug 6:00 pm/);
  assert.match(board.text, /2\. <b>plan Thailand<\/b> · yesterday 6:00 pm · 11×/);
  // Tonight's is today, so it stays a bare time under Later today.
  assert.match(board.text, /<b>Later today<\/b>\n• plan Thailand · 6:00 pm/);
});

test("an unchanged board is not re-edited on every tick", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  sent.length = 0;

  await runTick(env, T0 + 60_000);
  assert.equal(edits().length, 0, "identical content must not cost an API call");
  assert.equal(boards().length, 0);
});

test("tapping the board edits it in place rather than posting another", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const [board] = boards();
  const [row] = d1.q(`SELECT message_id FROM boards`);
  const payload = board.markup.inline_keyboard.flat()[0].callback_data;
  sent.length = 0;

  // The board's own button, through the same path a tap takes.
  const db = new Db(d1);
  const user = await db.user("u1");
  const live = await db.liveForUser("u1", iso(T0));
  await applyIntent(parseButton(payload), user, db, env, live, T0);
  await syncBoard(env, db, user, T0);

  assert.equal(boards().length, 0, "no second board message");
  const [edit] = edits();
  assert.ok(edit, "the board was edited");
  assert.equal(String(edit.messageId), String(row.message_id), "and it was THE board");
  assert.match(edit.text, /<b>Done<\/b>/);
  assert.match(edit.text, /<s>take out trash<\/s>/);
  assert.doesNotMatch(edit.text, /<b>Due<\/b>/, "nothing is open any more");
});

test("an inbound message brings the board up to date", async () => {
  // The webhook is the real-time entry point — it reads its own clock rather
  // than a simulated one — so this covers the wiring, not the content. Posting
  // from midnight keeps it independent of what time the suite actually runs.
  env.BOARD_HOUR = "00:00";

  await worker.fetch(
    new Request("https://bot.example.com/webhook/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, chat: { id: "9999" }, text: "help" },
      }),
    }),
    env,
    ctx,
  );
  await settle();

  assert.equal(nags().length, 1, "the reply went out");
  assert.equal(boards().length, 1, "and the inbound path synced the board");
});

test("a new day gets a fresh board and yesterday's is unpinned", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  assert.equal(pins().length, 1);
  sent.length = 0;

  await runTick(env, T0 + 24 * HOUR);

  assert.equal(boards().length, 1, "a separate message, not an edit of yesterday's");
  assert.equal(pins().length, 1, "today's is pinned");
  assert.equal(unpins().length, 1, "yesterday's is not");

  // Only the live day is tracked; yesterday's stays in the chat as history.
  assert.deepEqual(
    d1.q(`SELECT local_date FROM boards`).map((r) => r.local_date),
    ["2026-08-12"],
  );
});

test("an empty day gets its board only once the day has started", async () => {
  await runTick(env, localToUtc(2026, 8, 11, 6, 0, TZ));
  assert.equal(boards().length, 0, "no board in the small hours of an empty day");

  await runTick(env, localToUtc(2026, 8, 11, 8, 0, TZ));
  const [board] = boards();
  assert.ok(board);
  assert.match(board.text, /Nothing scheduled today/);
});

test("a board that fails to post never costs a reminder", async () => {
  seedTask("09:00", { policy: "pol_urgent" });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (String(body.text ?? "").startsWith(BOARD_MARKER)) {
      return new Response(JSON.stringify({ ok: false, description: "boom" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(url, init);
  };

  const r = await runTick(env, T0);
  assert.equal(r.sent, 1, "the nag went out regardless");
  assert.equal(nags().length, 1);
  assert.equal(d1.q(`SELECT * FROM boards`).length, 0, "and no phantom board was recorded");
});

// --------------------------------------------------------- speakable policy

test("'make gym urgent' is a keyword path, not an API call", async () => {
  seedTask("09:00", { title: "gym" });
  const p = parseKeyword("make gym urgent", []);

  assert.equal(p.intent, "update");
  assert.equal(p.source, "keyword", "changing insistence must never cost a model call");
  assert.equal(p.target.task_query, "gym");
  assert.equal(p.task.policy, "urgent");
  assert.equal(p.task.rrule, null, "and must not touch the schedule");

  const db = new Db(d1);
  const reply = await applyIntent(p, await db.user("u1"), db, env, [], T0);
  assert.match(reply.text, /urgent/);
  assert.equal((await db.tasksForUser("u1"))[0].policy_id, "pol_urgent");
});

test("changing how loudly a task nags does not drop what is already open", async () => {
  seedTask("09:00", { title: "gym" });
  await runTick(env, T0); // one instance, parked and sitting on the board
  const db = new Db(d1);
  const before = await db.liveForUser("u1", iso(T0));
  assert.equal(before.length, 1);

  await applyIntent(parseKeyword("make gym urgent", []), await db.user("u1"), db, env, [], T0);

  const after = await db.liveForUser("u1", iso(T0));
  assert.equal(after.length, 1, "the open instance survives a policy change");
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].tier, "urgent", "and picks the new tier up immediately");
});

test("'just notify me' style words map onto the notify policy", async () => {
  seedTask("09:00", { title: "dishes" });
  const db = new Db(d1);
  const p = parseKeyword("make dishes notify", []);
  await applyIntent(p, await db.user("u1"), db, env, [], T0);

  const [task] = await db.tasksForUser("u1");
  assert.equal(task.policy_id, "pol_notify");

  // And it behaves like notify: one message, no ladder.
  await runTick(env, T0);
  assert.equal(nags().length, 1);
  assert.equal(instances()[0].next_nag_at, null);
});
