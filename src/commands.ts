/**
 * Intent -> database mutation. Everything here returns a reply string; the
 * transport layer decides how to deliver it.
 */

import { Db, uid } from "./db";
import { Parsed, needsConfirmation } from "./parser";
import { describeRRule, firstOccurrence, parseRRule } from "./rrule";
import { describeSchedule, renderLiveList, renderTaskList, esc, shortDate } from "./render";
import { clockLabel, iso, localDateStart, ms, parseClock } from "./time";
import { Env, LiveInstance, OutboundAction, TaskRow, UserRow } from "./types";

export interface Reply {
  text: string;
  actions?: OutboundAction[];
}

const DEFAULT_TIME = "09:00";
const POLICY_WORDS = "<code>notify</code>, <code>gentle</code>, <code>quiet</code> or <code>urgent</code>";

export async function applyIntent(
  p: Parsed,
  user: UserRow,
  db: Db,
  env: Env,
  live: LiveInstance[],
  /** Injected clock. Command handlers must never reach for Date.now() directly
   *  or they can't be driven by simulated time the way the tick can. */
  now: number = Date.now(),
): Promise<Reply> {
  // Two-turn handshake for anything destructive or uncertain.
  if (needsConfirmation(p) && p.intent !== "unknown" && p.intent !== "confirm") {
    // An update is confirmed in terms of the real task, so resolve it first.
    let subject: TaskRow | null = null;
    if (p.intent === "update" && p.target.task_query) {
      const found = await resolveTask(db, user.id, p);
      if ("task" in found) subject = found.task;
    }
    const summary = summarize(p, live, user.timezone, now, subject);
    if (summary) {
      await db.putPendingAction(user.id, p, summary, 300_000, now);
      return { text: `${summary}\n\nReply <code>y</code> to confirm.` };
    }
  }

  switch (p.intent) {
    case "confirm": {
      // The injected clock, not Date.now(): putPendingAction stamped expires_at
      // from `now`, so checking it against wall-clock time compares two
      // different clocks. Harmless in production where they agree, but it made
      // the confirm path untestable — a y-confirmation appeared to expire or
      // not depending on what time the suite happened to run.
      const pending = await db.takePendingAction(user.id, now);
      if (!pending) return { text: "Nothing waiting for confirmation." };
      const confirmed: Parsed = { ...pending.payload, confidence: 1, source: "button" };
      return applyIntent(confirmed, user, db, env, live, now);
    }

    case "create": {
      if (!p.task.title) return { text: "What should I call it?" };
      if (!p.task.rrule) return { text: "How often? e.g. <i>every weekday</i>, <i>every monday</i>." };
      try {
        parseRRule(p.task.rrule);
      } catch {
        return { text: "I couldn't turn that into a schedule — try rephrasing the frequency." };
      }
      const localTime = validClock(p.task.local_time) ?? DEFAULT_TIME;
      const asked = p.task.policy ? await db.policyByName(user.id, p.task.policy) : null;
      if (p.task.policy && !asked) {
        return { text: `I don't have a <b>${esc(p.task.policy)}</b> style. Try ${POLICY_WORDS}.` };
      }
      const policy = asked ?? (await db.policy(user.default_policy_id));
      if (!policy) return { text: "No escalation policy configured — run the seed migration." };

      // Anchor. An explicit date ("on september 3rd") wins; otherwise creation
      // time, so a task made at 9am with a 6:30am rule starts tomorrow rather
      // than instantly nagging about this morning.
      let anchor = now;
      if (p.task.start_date) {
        const dated = localDateStart(p.task.start_date, user.timezone);
        if (dated === null) return { text: "I didn't understand that date." };
        anchor = dated;
      }

      // Refuse to store something that will never fire. A dated one-off whose
      // date has gone is born dead, and silently keeping it is worse than
      // saying so — it would sit in the tasks list looking scheduled forever.
      const first = firstOccurrence(p.task.rrule, anchor, localTime, user.timezone);
      if (first === null) {
        return { text: "That schedule never comes round — try rephrasing the date or frequency." };
      }
      if (first < now) {
        return {
          text:
            `That would have been ${shortDate(first, user.timezone)} at ` +
            `${clockLabel(localTime)}, which has already passed. When should it be?`,
        };
      }

      const task: TaskRow = {
        id: uid(),
        user_id: user.id,
        title: p.task.title,
        notes: null,
        rrule: p.task.rrule,
        dtstart: iso(anchor),
        local_time: localTime,
        timezone: user.timezone,
        policy_id: policy.id,
        overlap: p.task.overlap ?? "supersede",
        active: 1,
        created_at: iso(now),
        updated_at: iso(now),
      };
      await db.insertTask(task);
      const styled = asked ? ` · <i>${esc(asked.name)}</i>` : "";
      return {
        text:
          `✅ <b>${esc(task.title)}</b> — ` +
          `${describeSchedule(task.rrule, anchor, task.local_time, task.timezone)}${styled}`,
      };
    }

    case "update": {
      const match = await resolveTask(db, user.id, p);
      if ("error" in match) return { text: match.error };
      const fields: Partial<TaskRow> = {};
      if (p.task.title) fields.title = p.task.title;
      if (p.task.rrule) {
        try {
          parseRRule(p.task.rrule);
          fields.rrule = p.task.rrule;
        } catch {
          return { text: "That schedule didn't parse — try rephrasing." };
        }
      }
      const t = validClock(p.task.local_time);
      if (t) fields.local_time = t;
      if (p.task.start_date && localDateStart(p.task.start_date, match.task.timezone) === null) {
        return { text: "I didn't understand that date." };
      }
      if (p.task.overlap) fields.overlap = p.task.overlap;
      if (p.task.policy) {
        const pol = await db.policyByName(user.id, p.task.policy);
        if (!pol) {
          return { text: `I don't have a <b>${esc(p.task.policy)}</b> style. Try ${POLICY_WORDS}.` };
        }
        fields.policy_id = pol.id;
      }
      const mergedRule = fields.rrule ?? match.task.rrule;
      const mergedTime = fields.local_time ?? match.task.local_time;
      const anchor = anchorFor(p, match.task, mergedRule, mergedTime, now);
      if (anchor !== ms(match.task.dtstart)) fields.dtstart = iso(anchor);

      if (Object.keys(fields).length === 0) return { text: "Nothing to change." };
      await db.updateTask(match.task.id, fields);
      // Only a schedule change invalidates what's already materialized. A
      // policy change must NOT supersede: the live instances join their policy
      // through the task, so they pick up the new one on the next tick — and
      // superseding here would silently drop whatever is open right now.
      if (
        fields.rrule !== undefined ||
        fields.local_time !== undefined ||
        fields.dtstart !== undefined
      ) {
        await db.supersedeAll(match.task.id);
      }
      const merged = { ...match.task, ...fields };
      const styled = p.task.policy ? ` · <i>${esc(p.task.policy)}</i>` : "";
      return {
        text:
          `✏️ <b>${esc(merged.title)}</b> — ` +
          `${describeSchedule(mergedRule, anchor, mergedTime, match.task.timezone)}${styled}`,
      };
    }

    case "delete": {
      const match = await resolveTask(db, user.id, p);
      if ("error" in match) return { text: match.error };
      await db.deactivateTask(match.task.id);
      return { text: `🗑️ Removed <b>${esc(match.task.title)}</b>.` };
    }

    case "complete":
    case "skip": {
      const id = await resolveInstance(db, user.id, p, live);
      if (!id) {
        return {
          text: live.length
            ? "Which one?\n" + renderLiveList(live).text
            : "Nothing open to close out.",
          actions: live.length ? renderLiveList(live).actions : undefined,
        };
      }
      const state = p.intent === "complete" ? "acknowledged" : "skipped";
      const ok = await db.terminate(id, state, p.source);
      if (!ok) return { text: "That one was already closed out." };
      const inst = live.find((i) => i.id === id);
      const verb = p.intent === "complete" ? "✅ Done" : "🚫 Skipped";
      return { text: `${verb}${inst ? ` — ${esc(inst.title)}` : ""}` };
    }

    case "snooze": {
      const id = await resolveInstance(db, user.id, p, live);
      if (!id) return { text: "Snooze which one?\n" + renderLiveList(live).text };
      const mins = p.snooze_minutes ?? 60;
      const ok = await db.snooze(id, now + mins * 60_000);
      if (!ok) return { text: "That one was already closed out." };
      return { text: `⏳ Back in ${formatMinutes(mins)}.` };
    }

    case "list": {
      const r = renderLiveList(live);
      return { text: r.text, actions: r.actions };
    }

    case "tasks":
      return { text: renderTaskList(await db.tasksForUser(user.id), now) };

    case "set_timezone": {
      if (!p.timezone || !isValidZone(p.timezone)) {
        return { text: "I need an IANA zone, like <code>Asia/Tokyo</code>." };
      }
      await db.setTimezone(user.id, p.timezone);
      return { text: `🌏 Timezone set to <b>${esc(p.timezone)}</b>. Existing reminders follow you.` };
    }

    case "pause": {
      const mins = p.pause_minutes ?? 120;
      await db.setPaused(user.id, now + mins * 60_000);
      return { text: `🔇 Paused for ${formatMinutes(mins)}. Nothing is lost — it resumes after.` };
    }

    case "resume":
      await db.setPaused(user.id, null);
      return { text: "🔔 Back on." };

    case "help":
      return { text: HELP };

    case "unknown":
    default:
      return {
        text: p.clarifying_question ?? "I didn't follow — try <code>help</code>.",
      };
  }
}

// ------------------------------------------------------------------ resolvers

async function resolveTask(
  db: Db,
  userId: string,
  p: Parsed,
): Promise<{ task: TaskRow } | { error: string }> {
  if (!p.target.task_query) return { error: "Which reminder?" };
  const matches = await db.findTasks(userId, p.target.task_query);
  if (matches.length === 0) return { error: `No reminder matching “${esc(p.target.task_query)}”.` };
  if (matches.length > 1) {
    return {
      error:
        `That matches ${matches.length}:\n` +
        matches.map((t) => `• ${esc(t.title)}`).join("\n") +
        `\nBe a bit more specific.`,
    };
  }
  return { task: matches[0] };
}

async function resolveInstance(
  db: Db,
  userId: string,
  p: Parsed,
  live: LiveInstance[],
): Promise<string | null> {
  if (p.target.instance_id) return p.target.instance_id;
  const n = p.target.instance_number;
  if (n && live[n - 1]) return live[n - 1].id;
  if (p.target.task_query) {
    const q = p.target.task_query.toLowerCase();
    const hits = live.filter((i) => i.title.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0].id;
  }
  if (live.length === 1) return live[0].id;
  return null;
}

// ------------------------------------------------------------------ helpers

function summarize(
  p: Parsed,
  live: LiveInstance[],
  tz: string,
  now: number,
  task: TaskRow | null,
): string | null {
  switch (p.intent) {
    case "create": {
      if (!p.task.title || !p.task.rrule) return null;
      const clock = validClock(p.task.local_time) ?? DEFAULT_TIME;
      const anchor = (p.task.start_date && localDateStart(p.task.start_date, tz)) || now;
      return `Create <b>${esc(p.task.title)}</b> — ${describeSchedule(p.task.rrule, anchor, clock, tz)}?`;
    }
    case "update": {
      // Never invent a time here. Falling back to DEFAULT_TIME told the user
      // "to once at 9:00 am" for a task that actually fires at 21:00 — a
      // confirmation prompt that misstates the change is worse than none.
      if (!task) return `Change <b>${esc(p.target.task_query ?? "")}</b>?`;
      const rule = p.task.rrule ?? task.rrule;
      const time = validClock(p.task.local_time) ?? task.local_time;
      const anchor = anchorFor(p, task, rule, time, now);
      return `Change <b>${esc(task.title)}</b> to ${describeSchedule(rule, anchor, time, task.timezone)}?`;
    }
    case "delete":
      return `Delete <b>${esc(p.target.task_query ?? "")}</b>? This stops all future reminders for it.`;
    case "set_timezone":
      return `Set your timezone to <b>${esc(p.timezone ?? "")}</b>?`;
    default:
      return null;
  }
}

/**
 * Where an edited task's schedule should be anchored.
 *
 * An explicit date always wins. Otherwise the existing anchor stands — except
 * when the task is becoming a one-off, where a months-old dtstart would put
 * the single occurrence COUNT=1 allows in the past, spending the reminder the
 * moment it is saved. With no date given, "once" means the next time that hour
 * comes round.
 */
function anchorFor(
  p: Parsed,
  task: TaskRow,
  rule: string,
  localTime: string,
  now: number,
): number {
  if (p.task.start_date) {
    const dated = localDateStart(p.task.start_date, task.timezone);
    if (dated !== null) return dated;
  }
  if (isOneOffRule(rule)) {
    const first = firstOccurrence(rule, ms(task.dtstart), localTime, task.timezone);
    if (first === null || first < now) return now;
  }
  return ms(task.dtstart);
}

function isOneOffRule(rrule: string): boolean {
  try {
    return parseRRule(rrule).count === 1;
  } catch {
    return false;
  }
}

function validClock(v: string | null): string | null {
  if (!v) return null;
  try {
    const [h, m] = parseClock(v);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

const HELP = `<b>What I understand</b>

<b>Once, then done</b>
Say it without a repeating word and it happens once.
• <code>book the Thailand flight tomorrow at 9pm</code>
• <code>doctor's appointment on sept 3 at 2pm</code>
• <code>call the bank friday morning</code>

<b>Over and over</b>
Say <i>every</i>, <i>each</i>, <i>daily</i>, <i>weekly</i> — that word is what
makes it repeat.
• <code>gym every mon/wed/fri at 6:30am</code>
• <code>take out trash every tuesday 8pm</code>
• <code>vitamins daily at 8am</code>
• <code>weigh in every other monday at 7am</code>
• <code>review finances last friday of the month at 5pm</code>
• <code>rent on the 1st of the month at 9am</code>

I always tell you which one I made — <i>once, Thu 3 Sep at 2:00 pm</i> or
<i>daily at 6:30 am</i>. If I got it wrong:
• <code>make book flight a one-off</code>
• <code>change gym to every tuesday</code>

<b>When I nag you</b>
• <code>done</code> / <code>done 2</code>
• <code>snooze 30m</code> / <code>snooze 2 1h</code>
• <code>skip</code>

<b>How loudly</b>
Most things stay quiet: they sit on the pinned board for today and only
start nagging if you leave them there.
• <code>make gym urgent</code> — nags straight away, and keeps at it
• <code>make trash gentle</code> — a nudge every so often
• <code>make dishes notify</code> — one message, never again
• <code>make gym quiet</code> — back to board-first

<b>Everything else</b>
• <code>list</code> — what's open right now
• <code>tasks</code> — all your reminders
• <code>pause 2h</code> / <code>resume</code>
• <code>set timezone to Asia/Tokyo</code>
• <code>delete gym</code>

Anything else, just say it in plain English.`;
