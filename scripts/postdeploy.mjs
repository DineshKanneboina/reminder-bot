#!/usr/bin/env node
/**
 * Post-deploy smoke check. npm runs this after `npm run deploy`.
 *
 * A deploy that succeeds tells you the code uploaded, not that it works. The
 * two things that actually went wrong this way were a Workers AI model id that
 * did not exist — invisible, because hints fail silently by design — and a
 * board that stopped re-rendering. Both were found by hand afterwards; this is
 * that by-hand check, written down.
 *
 * Waits for one cron tick, because "is it running" cannot be answered faster
 * than the thing runs. SKIP_WAIT=1 to check state without waiting.
 */

import { execSync } from "node:child_process";

const WAIT_S = Number(process.env.SMOKE_WAIT_S ?? 75);
const results = [];

function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute reminder-bot --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error("no JSON in wrangler output");
  return JSON.parse(out.slice(start))[0].results ?? [];
}

function check(name, fn) {
  process.stdout.write(`  ${name} … `);
  let failure;
  try {
    failure = fn();
  } catch (e) {
    failure = `check failed: ${String(e).split("\n")[0]}`;
  }
  results.push({ name, failure: failure ?? null });
  console.log(failure ? "FAIL" : "ok");
  if (failure) console.log(`      ${failure.replace(/\n/g, "\n      ")}`);
}

const mins = (iso) => (Date.now() - Date.parse(iso)) / 60000;

console.log("\npost-deploy smoke check\n");

check("worker responds", () => {
  const out = execSync(
    `curl -s -o /dev/null -w '%{http_code}' https://reminder-bot.dineshkan.workers.dev/health`,
    { encoding: "utf8" },
  ).trim();
  return out === "200" ? null : `/health returned ${out}`;
});

if (process.env.SKIP_WAIT !== "1") {
  process.stdout.write(`  waiting ${WAIT_S}s for a cron tick `);
  const until = Date.now() + WAIT_S * 1000;
  while (Date.now() < until) {
    execSync("sleep 5");
    process.stdout.write(".");
  }
  console.log(" done\n");
}

// Direct evidence now, not inference: every tick writes a row, including the
// ones that die. A weekend of CPU-killed ticks was invisible precisely because
// a dead tick used to leave no trace.
check("last tick completed cleanly", () => {
  const [row] = d1(`SELECT ran_at, ok, error FROM tick_log ORDER BY ran_at DESC LIMIT 1`);
  if (!row) return "no tick_log rows at all — has a tick run since this deploy?";
  const ageMin = mins(row.ran_at);
  if (ageMin > 3) return `last tick was ${ageMin.toFixed(1)} minutes ago — cron may be stuck (a redeploy re-registers it)`;
  if (Number(row.ok) !== 1) return `last tick DIED: ${row.error}`;
  return null;
});

// The scheduler's own liveness signal. If ticks stop, due work piles up behind
// next_nag_at and nothing clears it — which is silent, because a bot with
// nothing to say looks identical to a bot that has died.
check("ticks are running", () => {
  // Cutoff computed here, not in SQL: timestamps are stored as ISO-8601 with a
  // T and a Z, while SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS".
  // Comparing those as strings silently compares the wrong thing.
  const cutoff = new Date(Date.now() - 4 * 60_000).toISOString();
  const [row] = d1(
    `SELECT COUNT(*) n, MIN(next_nag_at) oldest FROM reminder_instances WHERE next_nag_at IS NOT NULL AND next_nag_at < '${cutoff}'`,
  );
  return Number(row.n) === 0
    ? null
    : `${row.n} reminder(s) overdue past the retry lease, oldest ${row.oldest} — the tick may be dead or erroring`;
});

check("materialization is current", () => {
  const [row] = d1(`SELECT MAX(scheduled_for) far FROM reminder_instances`);
  if (!row.far) return null; // nothing scheduled at all is legitimate
  const hoursAhead = -mins(row.far) / 60;
  return hoursAhead > 12
    ? null
    : `furthest occurrence is only ${hoursAhead.toFixed(1)}h out; the 48h horizon suggests phase A has stopped`;
});

check("today's board exists", () => {
  const rows = d1(`SELECT local_date, updated_at FROM boards`);
  if (rows.length === 0) return "no board row — expected one per local day once past BOARD_HOUR";
  const stale = rows.filter((r) => mins(r.updated_at) > 24 * 60);
  return stale.length ? `board row for ${stale[0].local_date} is over a day old` : null;
});

const failed = results.filter((r) => r.failure);

// Hints fail silently by contract, so there is no external signal at all —
// say so rather than implying the check covered it.
try {
  const [notes] = d1(`SELECT COUNT(*) n FROM tasks WHERE notes IS NOT NULL AND active = 1`);
  console.log(
    `\n  hints: not verifiable from outside (every failure returns null by design).` +
      `\n         ${notes.n} task(s) have notes to work from.` +
      `\n         npx wrangler tail reminder-bot --format pretty` +
      `\n         → look for "hinted" above 0, or a "hint failed" line, on the next nag.`,
  );
} catch {
  /* advisory only */
}
console.log("");
if (failed.length === 0) {
  console.log(`all ${results.length} checks passed — deploy looks healthy\n`);
  process.exit(0);
}
console.log(`${failed.length} of ${results.length} checks failed after deploy\n`);
process.exit(1);
