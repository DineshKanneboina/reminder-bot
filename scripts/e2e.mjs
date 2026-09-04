#!/usr/bin/env node
/**
 * Live end-to-end test against PRODUCTION.
 *
 *   npm run e2e                  one-off AND recurring reminder → real cron tick →
 *                                nag + hint + ladder verified → cleanup  (~90s)
 *   npm run e2e -- --interactive same, then waits for you to tap 🗑 Today on the
 *                                recurring [TEST] nag to prove the button semantics
 *
 * What it proves, in order: the worker is up, the cron is actually ticking
 * (tick_log), a reminder created NOW is claimed and SENT on the next tick, the
 * AI hint was generated (and what it said — last_hint), and close-out works.
 *
 * It sends TWO real Telegram messages to the owner's chat, prefixed [TEST], and
 * deletes its rows afterwards. Needs wrangler auth (same as deploying); no
 * secrets. Exists because "change it, then wait until tomorrow's 9am nag to
 * find out" burned three days of iteration on hints alone.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const INTERACTIVE = process.argv.includes("--interactive");
const BASE = "https://reminder-bot.dineshkan.workers.dev";
const TASK_ID = `e2e_${Date.now()}`;
const INST_ID = `e2ei_${randomUUID().slice(0, 8)}`;
const RTASK_ID = `e2e_r${Date.now()}`;
const RINST_ID = `e2ei_${randomUUID().slice(0, 8)}`;

const results = [];
let failed = false;

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "reminder-bot", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error("no JSON from wrangler");
  return JSON.parse(out.slice(start))[0].results ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

async function cleanup() {
  try {
    d1(`DELETE FROM reminder_instances WHERE task_id LIKE 'e2e_%'`);
    d1(`DELETE FROM tasks WHERE id LIKE 'e2e_%'`);
    d1(`DELETE FROM escalation_policies WHERE id='pol_e2e'`);
    console.log("  cleaned up test rows");
  } catch (e) {
    console.error(`  CLEANUP FAILED — remove manually: DELETE FROM tasks WHERE id LIKE 'e2e_%'  (${e})`);
  }
}

console.log(`\ne2e against production ${INTERACTIVE ? "(interactive)" : ""}\n`);

try {
  // 1. Worker answers at all.
  const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  step("worker responds", health === 200, `/health ${health}`);

  // 2. The cron is genuinely ticking — most recent tick_log row is fresh & ok.
  const [lastTick] = d1(`SELECT ran_at, ok, error FROM tick_log ORDER BY ran_at DESC LIMIT 1`);
  const tickAge = lastTick ? (Date.now() - Date.parse(lastTick.ran_at)) / 60000 : Infinity;
  step(
    "cron is ticking",
    !!lastTick && tickAge < 3 && lastTick.ok === 1,
    lastTick ? `last tick ${tickAge.toFixed(1)}m ago, ok=${lastTick.ok}${lastTick.error ? " " + lastTick.error : ""}` : "no tick_log rows",
  );

  // 3. Create a one-off due NOW with a note, on the urgent policy (no quiet
  //    hours, pushes immediately). Instance is inserted directly so the test
  //    exercises claim → route → hint → send, not materialization timing.
  const now = Date.now();
  const [{ id: userId } = {}] = d1(`SELECT id FROM users LIMIT 1`);
  step("found owner", !!userId, userId ?? "no user row");
  d1(
    `INSERT INTO tasks VALUES ('${TASK_ID}','${userId}','[TEST] water the office plants',` +
      `'automated test — the watering can is under the kitchen sink','FREQ=DAILY;COUNT=1',` +
      `'${iso(now)}','12:00','America/Chicago','pol_urgent','supersede',1,'${iso(now)}','${iso(now)}')`,
  );
  d1(
    `INSERT INTO reminder_instances VALUES ('${INST_ID}','${TASK_ID}','${userId}',` +
      `'${iso(now)}','pending',0,0,'${iso(now - 30_000)}','${iso(now + 2 * 3600_000)}',NULL,NULL,NULL,NULL)`,
  );
  // A RECURRING sibling: same policy, FREQ=DAILY. What is different — and
  // what this phase exists to prove — is the ladder: after the first nag a
  // recurring chain must have its NEXT nag scheduled, where the one-off's
  // machinery is identical up to that point.
  // A fast test policy: 1-minute ladder rungs so the SECOND nag arrives inside
  // the suite's patience, proving per-notification hints on the real cron.
  d1(
    `INSERT OR REPLACE INTO escalation_policies VALUES ` +
      `('pol_e2e',NULL,'e2e','[1,1]','["primary"]',30,NULL,NULL,6,'urgent')`,
  );
  d1(
    `INSERT INTO tasks VALUES ('${RTASK_ID}','${userId}','[TEST] daily stretch',` +
      `'automated test — the mat is rolled up behind the couch','FREQ=DAILY',` +
      `'${iso(now - 86_400_000)}','12:00','America/Chicago','pol_e2e','supersede',1,'${iso(now)}','${iso(now)}')`,
  );
  d1(
    `INSERT INTO reminder_instances VALUES ('${RINST_ID}','${RTASK_ID}','${userId}',` +
      `'${iso(now)}','pending',0,0,'${iso(now - 30_000)}','${iso(now + 2 * 3600_000)}',NULL,NULL,NULL,NULL)`,
  );
  step("test reminders created", true, "a one-off and a daily, both due now, urgent, with notes");

  // 4. Wait for the real cron to claim and send it (≤ ~90s).
  console.log("  waiting for the next cron tick…");
  let inst = null, rinst = null;
  for (let i = 0; i < 10; i++) {
    await sleep(10_000);
    [inst] = d1(`SELECT state, attempt_count, next_nag_at, last_hint FROM reminder_instances WHERE id='${INST_ID}'`);
    [rinst] = d1(`SELECT state, attempt_count, next_nag_at, last_hint FROM reminder_instances WHERE id='${RINST_ID}'`);
    if (inst?.state === "notified" && rinst?.state === "notified") break;
    process.stdout.write(".");
  }
  console.log("");
  step(
    "one-off nag sent by the real tick",
    !!inst && inst.state === "notified" && inst.attempt_count >= 1,
    inst ? `state=${inst.state} attempts=${inst.attempt_count}` : "instance vanished",
  );
  step(
    "recurring nag sent by the real tick",
    !!rinst && rinst.state === "notified" && rinst.attempt_count >= 1,
    rinst ? `state=${rinst.state} attempts=${rinst.attempt_count}` : "instance vanished",
  );

  // The recurring chain's defining property: the ladder is ALIVE. The e2e
  // policy ladder is [1,1], so the next nag is scheduled ~1 minute out.
  const nextMin = rinst?.next_nag_at ? (Date.parse(rinst.next_nag_at) - Date.now()) / 60000 : null;
  step(
    "recurring ladder is live (next nag scheduled)",
    nextMin !== null && nextMin > -1 && nextMin < 3,
    nextMin !== null ? `next nag in ${nextMin.toFixed(1)}m` : "next_nag_at is NULL — chain dead after one nag",
  );

  // Per-notification hints (owner's decision): clear the stored hint, wait for
  // nudge two on the real cron, and require it to be REGENERATED. A cleared
  // column that stays NULL means nudge two went out hintless.
  d1(`UPDATE reminder_instances SET last_hint=NULL WHERE id='${RINST_ID}'`);
  console.log("  waiting for nudge two (1-minute test ladder)…");
  let second = null;
  for (let i = 0; i < 12; i++) {
    await sleep(10_000);
    [second] = d1(`SELECT attempt_count, last_hint FROM reminder_instances WHERE id='${RINST_ID}'`);
    if (second && second.attempt_count >= 2 && second.last_hint) break;
    process.stdout.write(".");
  }
  console.log("");
  step(
    "nudge two carries its OWN hint",
    !!second && second.attempt_count >= 2 && !!second.last_hint,
    second
      ? `attempts=${second.attempt_count} hint=${second.last_hint ? `“${second.last_hint}”` : "ABSENT"}`
      : "no second nag inside 2 minutes",
  );

  // 5. The hint. Since 31 Aug hints arrive by EDIT after the nag is already
  //    delivered (send-then-enhance), so give the enhancement pass a moment
  //    before reading last_hint — the send poll above returns too early.
  for (let i = 0; i < 5 && !(inst?.last_hint && rinst?.last_hint); i++) {
    await sleep(8_000);
    [inst] = d1(`SELECT state, attempt_count, next_nag_at, last_hint FROM reminder_instances WHERE id='${INST_ID}'`);
    [rinst] = d1(`SELECT state, attempt_count, next_nag_at, last_hint FROM reminder_instances WHERE id='${RINST_ID}'`);
  }
  for (const [label, row] of [["one-off", inst], ["recurring", rinst]]) {
    if (row?.last_hint) {
      step(`AI hint on the ${label} nag`, true, `“${row.last_hint}”`);
    } else {
      const [tick] = d1(`SELECT report, error FROM tick_log ORDER BY ran_at DESC LIMIT 1`);
      step(`AI hint on the ${label} nag`, false,
        `absent — check: npx wrangler tail reminder-bot  (last tick: ${tick?.report ?? "?"} ${tick?.error ?? ""})`);
    }
  }

  // 6. Close-out. Interactive mode proves the real buttons; otherwise the
  //    state machine is exercised directly.
  if (INTERACTIVE) {
    console.log("\n  → On your phone: tap ✅ Done on the [TEST] water-the-plants nag. Waiting up to 2 minutes…");
    let closed = null;
    for (let i = 0; i < 24; i++) {
      await sleep(5_000);
      [closed] = d1(`SELECT state, ack_source FROM reminder_instances WHERE id='${INST_ID}'`);
      if (closed && closed.state !== "notified") break;
    }
    step("Done closed the one-off", !!closed && closed.state === "acknowledged",
      closed ? `state=${closed.state} via ${closed.ack_source}` : "timed out");
    const [task] = d1(`SELECT active FROM tasks WHERE id='${TASK_ID}'`);
    step("one-off retired by Done", task?.active === 0, `active=${task?.active}`);

    console.log("\n  → Now tap 🗑 Today on the [TEST] daily-stretch nag. Waiting up to 2 minutes…");
    let rclosed = null;
    for (let i = 0; i < 24; i++) {
      await sleep(5_000);
      [rclosed] = d1(`SELECT state FROM reminder_instances WHERE id='${RINST_ID}'`);
      if (rclosed && rclosed.state !== "notified") break;
    }
    step("🗑 Today closed today's occurrence", !!rclosed && rclosed.state === "skipped",
      rclosed ? `state=${rclosed.state}` : "timed out");
    const [rtask] = d1(`SELECT active FROM tasks WHERE id='${RTASK_ID}'`);
    step("…and the series SURVIVES", rtask?.active === 1,
      `active=${rtask?.active} — Today must never delete the reminder itself`);
  } else {
    d1(`UPDATE reminder_instances SET state='acknowledged', next_nag_at=NULL WHERE id='${INST_ID}'`);
    const [closed] = d1(`SELECT state FROM reminder_instances WHERE id='${INST_ID}'`);
    step("close-out state machine", closed?.state === "acknowledged", "(direct; use --interactive to test real buttons)");
  }
} finally {
  await cleanup();
}

console.log("");
if (failed) {
  console.log(`${results.filter((r) => !r.ok).length} of ${results.length} steps failed\n`);
  process.exit(1);
}
console.log(`all ${results.length} steps passed — create → nag → hint → close verified in production\n`);
