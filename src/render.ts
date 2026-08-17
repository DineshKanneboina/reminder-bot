import { describeRRule } from "./rrule";
import { toLocalParts } from "./time";
import { LiveInstance, OutboundAction, TaskRow } from "./types";

export const clock = (isoStr: string, tz: string): string => {
  const p = toLocalParts(Date.parse(isoStr), tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

const ordinal = (n: number): string =>
  n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

/**
 * A single nag. `index` is the 1-based position in the user's live list, which
 * is what makes numbered text replies ("done 2") resolvable.
 */
export function renderNag(inst: LiveInstance, index: number, total: number) {
  const nth = inst.attempt_count > 1 ? ` · ${ordinal(inst.attempt_count)} nudge` : "";
  const head = total > 1 ? `${index}. ` : "";
  const text =
    `⏰ ${head}<b>${esc(inst.title)}</b>\n` +
    `<i>due ${clock(inst.scheduled_for, inst.timezone)}${nth}</i>`;
  const actions: OutboundAction[] = [
    { label: "✅ Done", payload: `done:${inst.id}:${index}` },
    { label: "⏳ 1h", payload: `snooze:${inst.id}:${index}:60` },
    { label: "🚫 Skip", payload: `skip:${inst.id}:${index}` },
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

export function renderLiveList(insts: LiveInstance[]) {
  if (insts.length === 0) return { text: "✨ Nothing open right now.", actions: [] };
  const lines = insts.map(
    (i, k) => `${k + 1}. <b>${esc(i.title)}</b> — due ${clock(i.scheduled_for, i.timezone)}`,
  );
  return {
    text: `<b>Open now</b>\n${lines.join("\n")}`,
    actions: insts.slice(0, 4).map((i, k) => ({ label: `✅ ${k + 1}`, payload: `done:${i.id}:${k + 1}` })),
  };
}

export function renderTaskList(tasks: TaskRow[]) {
  if (tasks.length === 0) return "You have no active reminders. Try: <code>gym every mon/wed/fri at 6:30am</code>";
  const lines = tasks.map(
    (t) => `• <b>${esc(t.title)}</b> — ${describeRRule(t.rrule, t.local_time)}`,
  );
  return `<b>Your reminders</b>\n${lines.join("\n")}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
