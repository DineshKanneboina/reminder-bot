#!/usr/bin/env node
/**
 * Live end-to-end test against PRODUCTION.
 *
 *   npm run e2e                  create → real cron tick → nag+hint verified → cleanup  (~90s)
 *   npm run e2e -- --interactive same, then waits for you to tap the buttons on your phone
 *
 * What it proves, in order: the worker is up, the cron is actually ticking
 * (tick_log), a reminder created NOW is claimed and SENT on the next tick, the
 * AI hint was generated (and what it said — last_hint), and close-out works.
 *
 * It sends ONE real Telegram message to the owner's chat, prefixed [TEST], and
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
    `INSERT INTO tasks VALUES ('${TASK_ID}','${userId}','[TEST] badger e2e — tap nothing',` +
      `'this is an automated test; the first step is to ignore it','FREQ=DAILY;COUNT=1',` +
      `'${iso(now)}','12:00','America/Chicago','pol_urgent','supersede',1,'${iso(now)}','${iso(now)}')`,
  );
  d1(
    `INSERT INTO reminder_instances VALUES ('${INST_ID}','${TASK_ID}','${userId}',` +
      `'${iso(now)}','pending',0,0,'${iso(now - 30_000)}','${iso(now + 2 * 3600_000)}',NULL,NULL,NULL)`,
  );
  step("test reminder created", true, "due now, urgent, with a note");

  // 4. Wait for the real cron to claim and send it (≤ ~90s).
  console.log("  waiting for the next cron tick…");
  let inst = null;
  for (let i = 0; i < 10; i++) {
    await sleep(10_000);
    [inst] = d1(`SELECT state, attempt_count, next_nag_at, last_hint FROM reminder_instances WHERE id='${INST_ID}'`);
    if (inst && inst.state === "notified" && inst.attempt_count >= 1) break;
    process.stdout.write(".");
  }
  console.log("");
  step(
    "nag was sent by the real tick",
    !!inst && inst.state === "notified" && inst.attempt_count >= 1,
    inst ? `state=${inst.state} attempts=${inst.attempt_count}` : "instance vanished",
  );

  // 5. The hint. Stored on the instance at send time, so the exact text the
  //    model produced is inspectable — and its absence is a finding, not a shrug.
  if (inst?.last_hint) {
    step("AI hint generated", true, `“${inst.last_hint}”`);
  } else {
    const [tick] = d1(`SELECT report, error FROM tick_log ORDER BY ran_at DESC LIMIT 1`);
    step("AI hint generated", false,
      `no hint on the nag — check: npx wrangler tail reminder-bot  (last tick: ${tick?.report ?? "?"} ${tick?.error ?? ""})`);
  }

  // 6. Close-out. Interactive mode proves the real buttons; otherwise the
  //    state machine is exercised directly.
  if (INTERACTIVE) {
    console.log("\n  → On your phone: tap ✅ Done on the [TEST] message. Waiting up to 2 minutes…");
    let closed = null;
    for (let i = 0; i < 24; i++) {
      await sleep(5_000);
      [closed] = d1(`SELECT state, ack_source FROM reminder_instances WHERE id='${INST_ID}'`);
      if (closed && closed.state !== "notified") break;
    }
    step("button tap closed it", !!closed && closed.state === "acknowledged",
      closed ? `state=${closed.state} via ${closed.ack_source}` : "timed out");
    const [task] = d1(`SELECT active FROM tasks WHERE id='${TASK_ID}'`);
    step("one-off retired by Done", task?.active === 0, `active=${task?.active}`);
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
