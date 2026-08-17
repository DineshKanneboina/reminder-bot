import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture, installBrokenFetch } from "./d1-shim.mjs";
import { runTick } from "../build/tick.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { parseKeyword, parseButton } from "../build/parser.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const SCHEMA = ["schema.sql", "seed.sql"];

let d1, env, sent;

const iso = (ms) => new Date(ms).toISOString();

function setup() {
  d1 = new FakeD1(SCHEMA);
  env = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "fake",
    MATERIALIZE_HORIZON_HOURS: "48",
    STALE_FLOOR_HOURS: "2",
    // This file pins the escalation machine: claim, ladder, lease, supersede.
    // The board is a second message on the same channel and would muddy every
    // send count here — it gets its own file, board.test.mjs.
    BOARD_ENABLED: "0",
  };
  sent = installFetchCapture();
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
    -- 'default' is quiet-tier now: it waits on the board before it nags. These
    -- tests are about what happens once something IS pushing, so they use a
    -- policy identical to the old default in every way except that it pushes
    -- on time. Quiet routing itself is covered in board.test.mjs.
    INSERT INTO escalation_policies
      (id,user_id,name,ladder_minutes,channel_ladder,give_up_after_minutes,quiet_start,quiet_end,max_concurrent,tier)
    VALUES
      ('pol_push',NULL,'push','[10,20,40,60]','["primary","primary","primary","email"]',180,'22:00','07:00',4,'urgent');
  `);
}

/** A daily task at a fixed local time, created "yesterday". */
function seedTask(localTime, opts = {}) {
  const dtstart = iso(Date.parse("2026-08-10T00:00:00Z"));
  d1.exec(`
    INSERT INTO tasks VALUES (
      '${opts.id ?? "t1"}','u1','${opts.title ?? "take out trash"}',NULL,
      '${opts.rrule ?? "FREQ=DAILY"}','${dtstart}','${localTime}','${TZ}',
      '${opts.policy ?? "pol_push"}','${opts.overlap ?? "supersede"}',1,
      '${dtstart}','${dtstart}');
  `);
}

/** A policy whose give-up window outlives a 24h gap, so overlap is observable. */
function longGiveUp() {
  d1.exec(`INSERT INTO escalation_policies
    (id,user_id,name,ladder_minutes,channel_ladder,give_up_after_minutes,quiet_start,quiet_end,max_concurrent,tier)
    VALUES ('pol_long',NULL,'long','[10,20,40,60]','["primary"]',4320,NULL,NULL,4,'urgent');`);
}

const instances = () =>
  d1.q(`SELECT id, scheduled_for, state, attempt_count, escalation_step,
               next_nag_at, give_up_at
          FROM reminder_instances ORDER BY scheduled_for`);

/** A Tuesday in August 2026, 09:00 local Chicago. */
const T0 = localToUtc(2026, 8, 11, 9, 0, TZ);

beforeEach(setup);

test("materializes the 48h horizon and claims only what is due", async () => {
  seedTask("09:00");
  const r = await runTick(env, T0);

  assert.equal(r.materialized, 2); // today 09:00 and +1d; +2d is the exclusive edge
  assert.equal(r.claimed, 1);
  assert.equal(r.sent, 1);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 1);
  assert.match(sent[0].text, /take out trash/);

  const rows = instances();
  assert.equal(rows[0].state, "notified");
  assert.equal(rows[0].attempt_count, 1);
  // 'default' ladder is [10,20,40,60]; step 1 means the next nag is +20m.
  assert.equal(Date.parse(rows[0].next_nag_at), T0 + 20 * 60_000);
  // Future occurrences stay pending and untouched.
  assert.deepEqual(rows.slice(1).map((x) => x.state), ["pending"]);
});

test("a second tick at the same instant is a no-op", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const before = instances();
  const r = await runTick(env, T0);

  assert.equal(r.materialized, 0);
  assert.equal(r.claimed, 0);
  assert.deepEqual(instances(), before);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 1);
});

test("nags escalate through the ladder, then expire", async () => {
  seedTask("09:00");
  await runTick(env, T0); // fire 1
  await runTick(env, T0 + 20 * 60_000); // fire 2
  await runTick(env, T0 + 60 * 60_000); // fire 3
  await runTick(env, T0 + 120 * 60_000); // fire 4 — ladder exhausted

  const row = instances()[0];
  assert.equal(row.attempt_count, 4);
  assert.equal(row.next_nag_at, null, "ladder exhausted must null next_nag_at");
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 4);
  assert.match(sent[3].text, /4th nudge/);

  // Nulled next_nag_at means it is never picked up again.
  await runTick(env, T0 + 200 * 60_000);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 4);
});

test("give_up_at expires a chain whose next nag falls past the window", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  // Force a nag scheduled beyond give_up_at, as a stale snooze would.
  d1.exec(`UPDATE reminder_instances
              SET next_nag_at = '${iso(T0 + 100 * 60_000)}',
                  give_up_at  = '${iso(T0 + 50 * 60_000)}'
            WHERE state = 'notified';`);

  const r = await runTick(env, T0 + 60 * 60_000);
  assert.equal(r.expired, 1);
  const row = instances().find((x) => x.state === "expired");
  assert.equal(row.next_nag_at, null);
});

test("snoozing past the give-up window extends it instead of killing the chain", async () => {
  seedTask("09:00");
  await runTick(env, T0); // pol_push gives up after 180m
  const db = new Db(d1);
  const user = await db.user("u1");
  const live = await db.liveForUser("u1", iso(T0));

  await applyIntent(parseKeyword("snooze 4h", live), user, db, env, live, T0);

  const row = instances()[0];
  assert.ok(
    Date.parse(row.give_up_at) > Date.parse(row.next_nag_at),
    "give_up_at must outlive an explicit snooze",
  );

  // And it really does come back rather than being swept.
  sent.length = 0;
  await runTick(env, Date.parse(row.next_nag_at) + 1000);
  assert.equal(sent.filter((x) => x.kind === "telegram").length, 1);
});

test("acknowledging stops the nagging immediately", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const db = new Db(d1);
  const user = await db.user("u1");
  const live = await db.liveForUser("u1", iso(T0));
  assert.equal(live.length, 1);

  const parsed = parseKeyword("done", live);
  assert.equal(parsed.intent, "complete");
  const reply = await applyIntent(parsed, user, db, env, live, T0);
  assert.match(reply.text, /Done/);

  const row = instances()[0];
  assert.equal(row.state, "acknowledged");
  assert.equal(row.next_nag_at, null);

  const before = sent.filter((s) => s.kind === "telegram").length;
  await runTick(env, T0 + 60 * 60_000);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, before, "no nag after ack");
});

test("bare 'done' refuses to guess when several chains are live", async () => {
  seedTask("09:00", { id: "t1", title: "trash" });
  seedTask("09:00", { id: "t2", title: "vitamins" });
  await runTick(env, T0);

  const db = new Db(d1);
  const live = await db.liveForUser("u1", iso(T0));
  assert.equal(live.length, 2);

  const vague = parseKeyword("done", live);
  assert.equal(vague.intent, "unknown");
  assert.match(vague.clarifying_question, /number/i);

  const precise = parseKeyword("done 2", live);
  assert.equal(precise.intent, "complete");
  assert.equal(precise.target.instance_id, live[1].id);
});

test("button payloads resolve to an exact instance, never an index", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const db = new Db(d1);
  const live = await db.liveForUser("u1", iso(T0));
  const payload = sent[0].markup.inline_keyboard.flat()[0].callback_data;

  const parsed = parseButton(payload);
  assert.equal(parsed.intent, "complete");
  assert.equal(parsed.target.instance_id, live[0].id);
  assert.equal(parsed.source, "button");
});

test("snooze pushes the chain out and resets escalation", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const db = new Db(d1);
  const user = await db.user("u1");
  const live = await db.liveForUser("u1", iso(T0));

  const parsed = parseKeyword("snooze 45m", live);
  assert.equal(parsed.snooze_minutes, 45);
  await applyIntent(parsed, user, db, env, live, T0);

  const row = instances()[0];
  assert.equal(row.escalation_step, 0);
  assert.equal(Date.parse(row.next_nag_at), T0 + 45 * 60_000);
});

test("supersede collapses an older live chain when a newer one comes due", async () => {
  longGiveUp();
  seedTask("09:00", { policy: "pol_long" });
  // Two live chains 30 minutes apart, both already due.
  d1.exec(`
    INSERT INTO reminder_instances VALUES
      ('i_old','t1','u1','${iso(T0 - 30 * 60_000)}','notified',1,1,'${iso(T0)}','${iso(T0 + 72 * 3600_000)}',NULL,NULL),
      ('i_new','t1','u1','${iso(T0)}','pending',0,0,'${iso(T0)}','${iso(T0 + 72 * 3600_000)}',NULL,NULL);
  `);

  const r = await runTick(env, T0);
  assert.equal(r.superseded, 1);

  const byId = Object.fromEntries(instances().map((x) => [x.id, x]));
  assert.equal(byId.i_old.state, "superseded");
  assert.equal(byId.i_old.next_nag_at, null, "superseded chains must stop nagging");
  assert.equal(byId.i_new.state, "notified", "the newest chain is the live one");

  // Exactly one message, about the newest occurrence.
  assert.equal(sent.filter((x) => x.kind === "telegram").length, 1);
});

test("stack keeps both chains alive and nags for both", async () => {
  longGiveUp();
  seedTask("09:00", { policy: "pol_long", overlap: "stack" });
  d1.exec(`
    INSERT INTO reminder_instances VALUES
      ('i_old','t1','u1','${iso(T0 - 30 * 60_000)}','notified',1,1,'${iso(T0)}','${iso(T0 + 72 * 3600_000)}',NULL,NULL),
      ('i_new','t1','u1','${iso(T0)}','pending',0,0,'${iso(T0)}','${iso(T0 + 72 * 3600_000)}',NULL,NULL);
  `);

  const r = await runTick(env, T0);
  assert.equal(r.superseded, 0);

  const states = instances().map((x) => x.state);
  assert.equal(states.filter((x) => x === "notified").length, 2);
  assert.equal(states.includes("superseded"), false);
});

test("a failing channel leaves a retry lease and does not abort the tick", async () => {
  seedTask("09:00");
  installBrokenFetch(); // returns an HTML error page, not JSON

  const r = await runTick(env, T0);
  assert.equal(r.claimed, 1);
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);

  const row = instances()[0];
  // Lease, not NULL — the next tick retries rather than stranding the row.
  assert.notEqual(row.next_nag_at, null);
  assert.equal(Date.parse(row.next_nag_at), T0 + 120_000);

  // And the retry actually lands once the channel recovers.
  sent = installFetchCapture();
  await runTick(env, T0 + 130_000);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, 1);
});

test("one broken user's channel does not block another user", async () => {
  seedTask("09:00");
  d1.exec(`
    INSERT INTO users VALUES ('u2','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c2','u2','telegram','8888',0,1);
    INSERT INTO tasks VALUES ('t2','u2','stretch',NULL,'FREQ=DAILY',
      '2026-08-10T00:00:00.000Z','09:00','${TZ}','pol_push','supersede',1,
      '2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z');
  `);

  let calls = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    if (body.chat_id === "9999") throw new Error("socket hang up");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { "content-type": "application/json" },
    });
  };

  const r = await runTick(env, T0);
  assert.equal(r.claimed, 2);
  assert.equal(r.sent, 1, "the healthy user still got their reminder");
  assert.equal(r.failed, 1);
  assert.equal(calls, 2);
});

test("quiet hours defer the first nag instead of dropping it", async () => {
  seedTask("23:30"); // inside the 22:00-07:00 default quiet window
  const lateNight = localToUtc(2026, 8, 11, 23, 30, TZ);
  const r = await runTick(env, lateNight);

  assert.equal(r.claimed, 0, "nothing fires during quiet hours");
  const row = instances()[0];
  assert.equal(row.state, "pending");
  // Deferred to 07:00 the next morning, not dropped.
  assert.equal(Date.parse(row.next_nag_at), localToUtc(2026, 8, 12, 7, 0, TZ));
});

test("downtime produces one digest, not a flood", async () => {
  seedTask("09:00", { id: "t1", title: "trash" });
  seedTask("09:15", { id: "t2", title: "vitamins" });
  seedTask("09:30", { id: "t3", title: "standup" });

  // Materialize normally before the outage, then go dark for six hours.
  await runTick(env, T0 - 30 * 60_000);
  sent.length = 0;
  const r = await runTick(env, T0 + 6 * 3600_000);

  const messages = sent.filter((s) => s.kind === "telegram");
  assert.equal(messages.length, 1, "one digest, not three nags");
  assert.match(messages[0].text, /offline/i);
  assert.match(messages[0].text, /trash/);
  assert.match(messages[0].text, /standup/);
  assert.equal(r.caughtUp, 3);

  // All of them are closed out so they never nag retroactively.
  const stale = instances().filter((x) => Date.parse(x.scheduled_for) < T0 + 6 * 3600_000);
  assert.ok(stale.every((x) => x.next_nag_at === null));
});

test("pause holds the chain without losing it", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const db = new Db(d1);
  const user = await db.user("u1");
  await db.setPaused("u1", T0 + 3 * 3600_000);

  const before = sent.filter((s) => s.kind === "telegram").length;
  await runTick(env, T0 + 25 * 60_000);
  assert.equal(sent.filter((s) => s.kind === "telegram").length, before, "silent while paused");

  const row = instances()[0];
  assert.notEqual(row.next_nag_at, null, "chain survives the pause");
});

test("over max_concurrent, nags are consolidated into one message", async () => {
  for (let i = 1; i <= 6; i++) seedTask("09:00", { id: `t${i}`, title: `task ${i}` });
  await runTick(env, T0);

  const messages = sent.filter((s) => s.kind === "telegram");
  assert.equal(messages.length, 1, "6 chains > max_concurrent 4 -> one batched message");
  assert.match(messages[0].text, /6 open/);
  for (let i = 1; i <= 6; i++) assert.match(messages[0].text, new RegExp(`task ${i}`));
});

test("inbound dedupe: the same provider message id applies once", async () => {
  seedTask("09:00");
  await runTick(env, T0);
  const db = new Db(d1);
  assert.equal(await db.claimInbound({ providerMessageId: "m1", channelKind: "telegram", senderId: "9999", text: "done" }), true);
  assert.equal(await db.claimInbound({ providerMessageId: "m1", channelKind: "telegram", senderId: "9999", text: "done" }), false);
});

test("unknown senders are not resolvable to a user", async () => {
  const db = new Db(d1);
  assert.equal(await db.userBySender("telegram", "9999") !== null, true);
  assert.equal(await db.userBySender("telegram", "1234"), null);
});
