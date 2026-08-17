/**
 * Intent -> database mutation. Everything here returns a reply string; the
 * transport layer decides how to deliver it.
 */

import { Db, uid } from "./db";
import { Parsed, needsConfirmation } from "./parser";
import { describeRRule, parseRRule } from "./rrule";
import { renderLiveList, renderTaskList, esc } from "./render";
import { iso, parseClock } from "./time";
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
    const summary = summarize(p, live);
    if (summary) {
      await db.putPendingAction(user.id, p, summary, 300_000, now);
      return { text: `${summary}\n\nReply <code>y</code> to confirm.` };
    }
  }

  switch (p.intent) {
    case "confirm": {
      const pending = await db.takePendingAction(user.id);
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

      const task: TaskRow = {
        id: uid(),
        user_id: user.id,
        title: p.task.title,
        notes: null,
        rrule: p.task.rrule,
        // Anchor to creation time exactly. A task made at 9am with a 6:30am
        // rule starts tomorrow rather than instantly nagging about this morning.
        dtstart: iso(now),
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
        text: `✅ <b>${esc(task.title)}</b> — ${describeRRule(task.rrule, task.local_time)}${styled}`,
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
      if (p.task.overlap) fields.overlap = p.task.overlap;
      if (p.task.policy) {
        const pol = await db.policyByName(user.id, p.task.policy);
        if (!pol) {
          return { text: `I don't have a <b>${esc(p.task.policy)}</b> style. Try ${POLICY_WORDS}.` };
        }
        fields.policy_id = pol.id;
      }
      if (Object.keys(fields).length === 0) return { text: "Nothing to change." };

      await db.updateTask(match.task.id, fields);
      // Only a schedule change invalidates what's already materialized. A
      // policy change must NOT supersede: the live instances join their policy
      // through the task, so they pick up the new one on the next tick — and
      // superseding here would silently drop whatever is open right now.
      if (fields.rrule !== undefined || fields.local_time !== undefined) {
        await db.supersedeAll(match.task.id);
      }
      const merged = { ...match.task, ...fields };
      const styled = p.task.policy ? ` · <i>${esc(p.task.policy)}</i>` : "";
      return {
        text: `✏️ <b>${esc(merged.title)}</b> — ${describeRRule(merged.rrule, merged.local_time)}${styled}`,
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

function summarize(p: Parsed, live: LiveInstance[]): string | null {
  switch (p.intent) {
    case "create":
      if (!p.task.title || !p.task.rrule) return null;
      return `Create <b>${esc(p.task.title)}</b> — ${describeRRule(p.task.rrule, validClock(p.task.local_time) ?? DEFAULT_TIME)}?`;
    case "update":
      return `Change <b>${esc(p.target.task_query ?? "")}</b>${p.task.rrule ? ` to ${describeRRule(p.task.rrule, validClock(p.task.local_time) ?? DEFAULT_TIME)}` : ""}?`;
    case "delete":
      return `Delete <b>${esc(p.target.task_query ?? "")}</b>? This stops all future reminders for it.`;
    case "set_timezone":
      return `Set your timezone to <b>${esc(p.timezone ?? "")}</b>?`;
    default:
      return null;
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

<b>Make one</b>
• <code>gym every mon/wed/fri at 6:30am</code>
• <code>take out trash every tuesday 8pm</code>
• <code>review finances last friday of the month at 5pm</code>

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
