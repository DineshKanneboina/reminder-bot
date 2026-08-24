/**
 * The tick. Runs every 60 seconds from a Cron Trigger.
 *
 * Five phases, each independently idempotent. Cron Triggers do not retry a
 * failed scheduled run — the next tick is the retry, which works because all
 * state lives in D1 rather than in process memory.
 */

import { syncBoards } from "./board";
import { buildChannels, resolveTarget } from "./channels";
import { Db, uid } from "./db";
import { firstStepHint } from "./hint";
import { isOneOff, occurrencesBetween } from "./rrule";
import { renderBatch, renderCatchUp, renderNag } from "./render";
import { iso, ms, pushPastQuietHours } from "./time";
import { Env, InstanceRow, LiveInstance, PolicyRow, TaskRow } from "./types";

export interface TickReport {
  materialized: number;
  expired: number;
  superseded: number;
  claimed: number;
  sent: number;
  failed: number;
  caughtUp: number;
  /** Claimed but deliberately not pushed: quiet items still inside their window. */
  parked: number;
  /** Nags that carried a hint. `sent` high with `hinted` at 0 means hints are broken. */
  hinted: number;
}

const DEFAULT_QUIET_AGING_HOURS = 4;

export async function runTick(env: Env, now = Date.now()): Promise<TickReport> {
  const db = Db.from(env);
  const report: TickReport = {
    materialized: 0, expired: 0, superseded: 0, claimed: 0, sent: 0, failed: 0, caughtUp: 0,
    parked: 0, hinted: 0,
  };

  // Every tick leaves a row, even — especially — the ones that die. A weekend
  // of CPU-killed ticks was invisible after the fact because a dead tick left
  // no trace anywhere.
  let error: string | null = null;
  try {
    await tickPhases(env, db, report, now);
  } catch (e) {
    error = String(e);
    console.error("tick failed", error);
  }
  await db.putTickLog(iso(now), error === null, report, error);
  if (new Date(now).getUTCMinutes() === 0) {
    await db.pruneTickLog(iso(now - 48 * 3600_000)).catch(() => {});
  }
  if (error === null) await heartbeat(env, report);
  return report;
}

async function tickPhases(env: Env, db: Db, report: TickReport, now: number): Promise<void> {
  const horizonH = Number(env.MATERIALIZE_HORIZON_HOURS ?? 48);
  const staleH = Number(env.STALE_FLOOR_HOURS ?? 2);
  const staleFloor = now - staleH * 3600_000;
  const agingMs = Number(env.QUIET_AGING_HOURS ?? DEFAULT_QUIET_AGING_HOURS) * 3600_000;

  // --- Phase A: materialize upcoming occurrences ---------------------------
  // Window starts at staleFloor, not now: if the Worker was down, occurrences
  // that came due during the gap still get created so Phase C can report them
  // instead of them vanishing silently.
  report.materialized = await materialize(db, staleFloor, now, horizonH);

  // --- Phase B: sweep anything the tick missed while we were down ----------
  // Runs BEFORE the expiry sweep. An instance that went 2h+ overdue because
  // the Worker was down would otherwise be silently marked expired here and
  // never make it into the digest — the user would never learn it was missed.
  // Under healthy operation nothing is ever this stale, so this is a no-op.
  report.caughtUp = await catchUp(env, db, staleFloor);

  // --- Phase C: expire terminated chains, collapse overlapping ones --------
  report.expired = await db.expireOverdue(iso(now));
  report.superseded = await db.supersedeStaleChains(iso(now));

  // --- Phase D: claim due instances, route, send, write the real backoff ---
  const claimed = await db.claimDue(iso(now), iso(staleFloor), iso(now + 120_000), 20);
  report.claimed = claimed.length;

  // Hints are generated inline, so they are budgeted: a tick that claimed
  // twenty reminders must not spend twenty timeouts before any of them are
  // sent. Beyond the budget, nags go out hintless — which is the same thing
  // that happens whenever the model is slow, so it needs no special handling.
  let hintBudget = Number(env.HINT_BUDGET_PER_TICK ?? 3);

  const byUser = groupBy(claimed, (i) => i.user_id);
  for (const [userId, instances] of byUser) {
    const user = await db.user(userId);
    if (!user) continue;

    // Global pause: keep the chain alive, just don't send.
    if (user.paused_until && ms(user.paused_until) > now) {
      for (const i of instances) await db.setNextNag(i.id, user.paused_until);
      continue;
    }

    // Routing, before anything is rendered or sent. A quiet item that hasn't
    // aged out yet is put back exactly as it was found and left to the board.
    const pushable: LiveInstance[] = [];
    for (const inst of instances) {
      const at = pushAt(inst, agingMs);
      if (at <= now) {
        pushable.push(inst);
      } else {
        await db.parkQuiet(inst.id, iso(at), iso(at + inst.give_up_after_minutes * 60_000));
        report.parked++;
      }
    }
    if (pushable.length === 0) continue;

    const channels = await db.channels(userId);
    const registry = buildChannels(env);
    // Loaded once for the whole user, not per nag: the same facts feed every
    // hint in this tick and re-reading them per message is pure waste.
    const facts = hintBudget > 0 ? (await db.preferences(userId)).map((r) => r.text) : [];
    const live = await db.liveForUser(userId, iso(now));
    const indexOf = new Map(live.map((i, k) => [i.id, k + 1]));

    const cap = pushable[0].max_concurrent ?? 4;
    const batched = pushable.length > cap;

    const groups: LiveInstance[][] = batched
      ? [pushable]
      : pushable.map((i) => [i]);

    for (const group of groups) {
      const lead = group[0];
      const startIdx = indexOf.get(lead.id) ?? 1;
      // Only single nags get a hint, and only the FIRST nag of a chain. A
      // batched message is already a list. And by the fourth nudge you have
      // read the suggestion — a different one each time reads as the bot
      // casting around, and four chances to say something useless beat one.
      // Spending the budget once per chain is what pays for a bigger model.
      let hint: string | null = null;
      if (group.length === 1 && lead.attempt_count <= 1 && hintBudget > 0) {
        hintBudget--;
        hint = await firstStepHint(env, {
          title: lead.title,
          notes: lead.notes,
          attempt_count: lead.attempt_count,
          preferences: facts,
        });
        if (hint) report.hinted++;
      }

      const { text, actions } =
        group.length > 1
          ? renderBatch(group, startIdx)
          : renderNag(lead, startIdx, live.length, hint);

      const step = Math.max(0, lead.escalation_step - 1);
      const ladder = safeJson<string[]>(lead.channel_ladder, ["primary"]);
      const want = ladder[Math.min(step, ladder.length - 1)] ?? "primary";
      const dest = resolveTarget(want, channels, registry);

      if (!dest) {
        report.failed += group.length;
        continue;
      }

      // One user's broken channel must never abort the tick for everyone else.
      const res = await dest.channel
        .send(dest.target, text, actions)
        .catch((e) => ({ ok: false as const, error: String(e) }));

      if (!res.ok) {
        // Leave the lease in place — the next tick retries in ~2 minutes.
        report.failed += group.length;
        console.error("send failed", { userId, kind: dest.channel.kind, error: res.error });
        continue;
      }

      report.sent += group.length;
      for (const inst of group) {
        await db.setNextNag(inst.id, nextNagAt(inst, now), inst.id === lead.id ? hint : null);
      }
    }
  }

  // --- Phase E: reconcile the pinned daily board ---------------------------
  // Last, so it reflects everything the phases above just did. Never allowed to
  // throw: the board is a view, and a broken view must not fail the tick.
  //
  // Gated: a full board render costs real CPU (Intl-heavy), and on an idle
  // tick nothing can have changed. Activity syncs immediately; otherwise every
  // fifth minute catches pure time-passage changes (midnight rollover,
  // upcoming items becoming due are activity anyway via the claim).
  const activity =
    report.sent + report.claimed + report.parked + report.expired +
    report.superseded + report.caughtUp + report.materialized > 0;
  if (activity || new Date(now).getUTCMinutes() % 5 === 0) {
    await syncBoards(env, db, now).catch((e) => console.error("board phase failed", e));
  }
}

/**
 * When an instance is allowed to push a notification, as opposed to merely
 * appearing on the board.
 *
 * 'urgent' and 'notify' push the moment they come due. So do one-offs, whatever
 * their tier: "remind me at 10:27" is a moment the user chose, and holding it
 * back four hours answers a different question than the one they asked. The
 * quiet window is for standing habits, where the board genuinely is enough
 * until the day starts getting away from you.
 *
 * Everything else waits out the aging window, and that wait is itself pushed
 * past quiet hours so a 23:30 item doesn't come alive at 03:30.
 */
export function pushAt(inst: LiveInstance, agingMs: number): number {
  const due = ms(inst.scheduled_for);
  if (inst.tier !== "quiet") return due;
  if (isOneOff(inst.rrule)) return due;
  return pushPastQuietHours(due + agingMs, inst.timezone, inst.quiet_start, inst.quiet_end);
}

/**
 * Where the next nag lands: this nag's ladder entry, pushed out of quiet hours,
 * clamped to give_up_at. Returns null when the ladder is exhausted, which is
 * what ends the chain.
 *
 * The claim has already incremented escalation_step, so the nag that just went
 * out is number `escalation_step` and its gap is `ladder[escalation_step - 1]`.
 * Reading the raw step instead skipped ladder[0] entirely: a [10,20,40,60]
 * ladder produced gaps of 20/40/60 and one nag fewer than it declares. The
 * channel ladder a few lines below has always indexed on step - 1, so the two
 * halves of the same policy disagreed about which nag they were on.
 */
export function nextNagAt(inst: LiveInstance, now: number): string | null {
  const ladder = safeJson<number[]>(inst.ladder_minutes, [10, 20, 40, 60]);
  const step = inst.escalation_step - 1;
  if (step < 0 || step >= ladder.length) return null;

  let next = now + ladder[step] * 60_000;
  next = pushPastQuietHours(next, inst.timezone, inst.quiet_start, inst.quiet_end);

  const giveUp = ms(inst.give_up_at);
  if (next >= giveUp) return null;
  return iso(next);
}

/** Phase A. INSERT OR IGNORE against the unique key makes this a no-op on re-run. */
async function materialize(
  db: Db,
  from: number,
  now: number,
  horizonHours: number,
): Promise<number> {
  const tasks = await db.activeTasks();
  const to = now + horizonHours * 3600_000;
  let created = 0;

  const policyCache = new Map<string, PolicyRow>();
  for (const task of tasks) {
    let policy = policyCache.get(task.policy_id) ?? null;
    if (!policy) {
      policy = await db.policy(task.policy_id);
      if (!policy) continue;
      policyCache.set(task.policy_id, policy);
    }

    let occs: number[];
    try {
      occs = occurrencesBetween(task.rrule, ms(task.dtstart), task.local_time, task.timezone, from, to);
    } catch (e) {
      // A malformed rule should not take down every other task's scheduling.
      console.error("bad rrule", { taskId: task.id, rrule: task.rrule, error: String(e) });
      continue;
    }

    for (const at of occs) {
      const firstNag = pushPastQuietHours(at, task.timezone, policy.quiet_start, policy.quiet_end);
      const row: InstanceRow = {
        id: uid(),
        task_id: task.id,
        user_id: task.user_id,
        scheduled_for: iso(at),
        state: "pending",
        attempt_count: 0,
        escalation_step: 0,
        next_nag_at: iso(firstNag),
        give_up_at: iso(firstNag + policy.give_up_after_minutes * 60_000),
        acknowledged_at: null,
        ack_source: null,
      };
      if (await db.insertInstanceIfAbsent(row)) created++;
    }
  }
  return created;
}

/**
 * Phase C. If we were down, don't fire 40 individual nags on restart — that's
 * how a reminder channel becomes something you mute. One digest, then close
 * them out.
 */
async function catchUp(env: Env, db: Db, staleFloor: number): Promise<number> {
  const stale = await db.stale(iso(staleFloor));
  if (stale.length === 0) return 0;

  // Close FIRST, in one atomic statement, then tell the user. The old order —
  // send the digest, then close row by row — meant a tick killed mid-loop had
  // announced items it never closed, and every revival announced them again:
  // the triple "I was offline" digest. Losing one digest to a crash is
  // recoverable (the board still shows Missed); repeating it is spam.
  await db.closeStale(stale.map((i) => i.id));

  const registry = buildChannels(env);
  for (const [userId, insts] of groupBy(stale, (i) => i.user_id)) {
    const channels = await db.channels(userId);
    const dest = resolveTarget("primary", channels, registry);
    if (dest) {
      const { text } = renderCatchUp(insts);
      await dest.channel.send(dest.target, text).catch(() => {});
    }
  }
  return stale.length;
}

/**
 * Dead man's switch. Once you trust this thing, silence is indistinguishable
 * from "nothing due" — so a third party has to notice when the ticks stop.
 */
async function heartbeat(env: Env, report: TickReport): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  await fetch(env.HEARTBEAT_URL, {
    method: "POST",
    body: JSON.stringify(report),
  }).catch(() => {});
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type { TaskRow };
