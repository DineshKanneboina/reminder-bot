import { describeRRule, isOneOff, oneOffOccurrence } from "./rrule";
import { clockLabel, formatClock, localDateString, localDayBounds, ms, toLocalParts } from "./time";
import { LiveInstance, OutboundAction, TaskRow } from "./types";

export const clock = (isoStr: string, tz: string): string => {
  const p = toLocalParts(Date.parse(isoStr), tz);
  return formatClock(p.hour, p.minute);
};

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'Thu 13 Aug' — enough to place a one-off without a full timestamp. */
export const shortDate = (epochMs: number, tz: string): string => {
  const p = toLocalParts(epochMs, tz);
  return `${SHORT_DAYS[p.weekday]} ${p.day} ${SHORT_MONTHS[p.month - 1]}`;
};

/**
 * How a task's schedule reads, in one place so the creation confirmation, the
 * edit confirmation and the tasks list can never disagree. A dated one-off
 * says its date; anything else describes its rule.
 */
export function describeSchedule(
  rrule: string,
  dtstartMs: number,
  localTime: string,
  tz: string,
): string {
  const once = oneOffOccurrence(rrule, dtstartMs, localTime, tz);
  if (once !== null) return `once, ${shortDate(once, tz)} at ${clockLabel(localTime)}`;
  return describeRRule(rrule, localTime);
}

/**
 * A time, dated only when it isn't today: "6:00 pm", "yesterday 6:00 pm",
 * "Sun 9 Aug 6:00 pm".
 *
 * Anything that survives past midnight needs this. A bare clock time under a
 * heading that says today reads as today — that is what made last night's 6pm
 * item and tonight's 6pm occurrence indistinguishable on the board, and the
 * same trap exists in every other list that can carry an item over.
 */
export function whenLabel(isoStr: string, tz: string, now: number): string {
  const at = ms(isoStr);
  const day = localDateString(at, tz);
  const time = clock(isoStr, tz);
  if (day === localDateString(now, tz)) return time;
  if (day === localDateString(localDayBounds(now, tz)[0] - 1000, tz)) return `yesterday ${time}`;
  return `${shortDate(at, tz)} ${time}`;
}

/**
 * What is still on the plate, appended when something is closed out. Numbering
 * matches liveForUser, so the `done 2` in this very message resolves correctly.
 */
export function renderRemaining(open: LiveInstance[], later: LiveInstance[], now: number) {
  const blocks: string[] = [];

  if (open.length) {
    const lines = open.map(
      (i, k) => `${k + 1}. <b>${esc(i.title)}</b> — due ${whenLabel(i.scheduled_for, i.timezone, now)}`,
    );
    blocks.push(`<b>Still open</b>\n${lines.join("\n")}`);
  }

  if (later.length) {
    const shown = later.slice(0, LATER_SHOWN);
    const lines = shown.map((i) => `• ${esc(i.title)} · ${clock(i.scheduled_for, i.timezone)}`);
    const more = later.length > LATER_SHOWN ? `\n…and ${later.length - LATER_SHOWN} more` : "";
    blocks.push(`<b>Later today</b>\n${lines.join("\n")}${more}`);
  }

  if (blocks.length === 0) {
    return { text: "✨ That's everything for today.", actions: [] as OutboundAction[] };
  }
  return {
    text: blocks.join("\n\n"),
    actions: open
      .slice(0, 4)
      .map((i, k) => ({ label: `✅ ${k + 1}`, payload: `done:${i.id}:${k + 1}` })),
  };
}

const LATER_SHOWN = 5;

const ordinal = (n: number): string =>
  n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

/**
 * A single nag. `index` is the 1-based position in the user's live list, which
 * is what makes numbered text replies ("done 2") resolvable.
 */
export function renderNag(
  inst: LiveInstance,
  index: number,
  total: number,
  /** Optional first-step suggestion. Null renders exactly as it did before. */
  hint?: string | null,
) {
  const nth = inst.attempt_count > 1 ? ` · ${ordinal(inst.attempt_count)} nudge` : "";
  const head = total > 1 ? `${index}. ` : "";
  // esc even though hint.ts already drops angle brackets: this is model output
  // going into an HTML message, and one guard is not a guard.
  const tip = hint ? `\n💡 <i>${esc(hint)}</i>` : "";
  const text =
    `⏰ ${head}<b>${esc(inst.title)}</b>\n` +
    `<i>due ${clock(inst.scheduled_for, inst.timezone)}${nth}</i>${tip}`;
  // A one-off has no tomorrow, so Done is unambiguous: it finishes the task
  // for good. A recurring nag deliberately has NO done button — the owner's
  // call, after "Done" on a daily read as "handled forever" and it wasn't:
  // 🗑 dismisses today (tomorrow still comes), ❌ deletes the whole series.
  const actions: OutboundAction[] = isOneOff(inst.rrule)
    ? [
        { label: "✅ Done", payload: `done:${inst.id}:${index}` },
        { label: "⏳ 1h", payload: `snooze:${inst.id}:${index}:60` },
      ]
    : [
        { label: "⏳ 1h", payload: `snooze:${inst.id}:${index}:60` },
        { label: "🗑 Today", payload: `skip:${inst.id}:${index}` },
        { label: "❌ Forever", payload: `remove:${inst.id}:${index}` },
      ];
  return { text, actions };
}

/** One message covering several live chains, used when over max_concurrent. */
export function renderBatch(insts: LiveInstance[], startIndex: number) {
  const lines = insts.map(
    (i, k) =>
      `${startIndex + k}. <b>${esc(i.title)}</b> — due ${clock(i.scheduled_for, i.timezone)}`,
  );
  const text =
    `⏰ <b>${insts.length} open</b>\n${lines.join("\n")}\n\n` +
    `<i>Reply <code>done 1</code>, <code>snooze 2 30m</code>, or <code>skip 3</code>.</i>`;
  const actions: OutboundAction[] = insts
    .slice(0, 4)
    .map((i, k) => ({ label: `✅ ${startIndex + k}`, payload: `done:${i.id}:${startIndex + k}` }));
  return { text, actions };
}

/** Digest sent after downtime instead of firing every missed instance. */
export function renderCatchUp(insts: LiveInstance[]) {
  const lines = insts
    .slice(0, 15)
    .map((i) => `• <b>${esc(i.title)}</b> — was due ${clock(i.scheduled_for, i.timezone)}`);
  const more = insts.length > 15 ? `\n…and ${insts.length - 15} more` : "";
  return {
    text:
      `😅 I was offline for a while. Here's what you missed — nothing below will nag you:\n\n` +
      lines.join("\n") + more,
    actions: [] as OutboundAction[],
  };
}

export function renderLiveList(insts: LiveInstance[], now: number) {
  if (insts.length === 0) return { text: "✨ Nothing open right now.", actions: [] };
  const lines = insts.map(
    (i, k) => `${k + 1}. <b>${esc(i.title)}</b> — due ${whenLabel(i.scheduled_for, i.timezone, now)}`,
  );
  return {
    text: `<b>Open now</b>\n${lines.join("\n")}`,
    actions: insts.slice(0, 4).map((i, k) => ({ label: `✅ ${k + 1}`, payload: `done:${i.id}:${k + 1}` })),
  };
}

/**
 * The tasks list, split by what will actually happen again.
 *
 * A spent one-off is still active=1 in the database — nothing retires it — so
 * listing it alongside live reminders makes the whole list untrustworthy: you
 * end up comparing a board that is right against a list that is lying.
 */
export function renderTaskList(tasks: TaskRow[], now: number) {
  if (tasks.length === 0) {
    return "You have no active reminders. Try: <code>gym every mon/wed/fri at 6:30am</code>";
  }

  const live: string[] = [];
  const spent: string[] = [];
  let firstSpent = "";

  for (const t of tasks) {
    const once = oneOffOccurrence(t.rrule, ms(t.dtstart), t.local_time, t.timezone);
    if (once === null) {
      live.push(`• <b>${esc(t.title)}</b> — ${describeRRule(t.rrule, t.local_time)}`);
    } else if (once > now) {
      live.push(
        `• <b>${esc(t.title)}</b> — ${describeSchedule(t.rrule, ms(t.dtstart), t.local_time, t.timezone)}`,
      );
    } else {
      if (!firstSpent) firstSpent = t.title;
      spent.push(`• <s>${esc(t.title)}</s> — was ${shortDate(once, t.timezone)}`);
    }
  }

  const blocks: string[] = [];
  if (live.length) blocks.push(`<b>Your reminders</b>\n${live.join("\n")}`);
  if (spent.length) {
    blocks.push(
      `<b>Already happened</b>\n${spent.join("\n")}\n` +
        `<i>One-offs stay here until you clear them — <code>delete ${esc(firstSpent)}</code>.</i>`,
    );
  }
  return blocks.join("\n\n");
}

/** The standing facts, numbered so `forget 2` has something to resolve against. */
export function renderPreferences(facts: { text: string }[]): string {
  if (facts.length === 0) {
    return (
      "I'm not remembering anything about you yet.\n" +
      "<i>Say <code>remember: I use Ryse protein</code> and I'll work it into my suggestions.</i>"
    );
  }
  const lines = facts.map((f, k) => `${k + 1}. ${esc(f.text)}`);
  return `<b>What I know about you</b>\n${lines.join("\n")}\n<i>Drop one with <code>forget 2</code>.</i>`;
}

export function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
