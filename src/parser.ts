/**
 * Reply parsing.
 *
 * Fast path first: buttons and keywords cover the overwhelming majority of
 * traffic and must never be slow, costly, or nondeterministic. Only genuinely
 * novel text reaches the model.
 */

import { LiveInstance } from "./types";

export type Intent =
  | "create" | "update" | "delete" | "complete" | "snooze" | "skip"
  | "list" | "tasks" | "set_notes" | "show_notes" | "remember" | "forget" | "preferences" | "research"
  | "set_timezone" | "set_quiet_hours"
  | "pause" | "resume" | "confirm" | "help" | "unknown";

export interface Parsed {
  intent: Intent;
  confidence: number;
  target: {
    instance_number: number | null;
    instance_id: string | null;
    task_query: string | null;
    /** A task already resolved by the bot itself (a staged delete). Never
     *  model-supplied: the confirm step acts on exactly what was shown. */
    task_id?: string | null;
  };
  /** Answer to a numbered choice the bot offered: a position, or all of them. */
  choice: number | "all" | null;
  task: {
    title: string | null;
    /** Free text about what the task actually is, for nag-time hints. */
    notes: string | null;
    rrule: string | null;
    local_time: string | null;
    /** YYYY-MM-DD in the user's timezone — for one-offs and delayed starts. */
    start_date: string | null;
    policy: string | null;
    overlap: "supersede" | "stack" | null;
  };
  snooze_minutes: number | null;
  timezone: string | null;
  quiet_hours: { start: string; end: string } | null;
  pause_minutes: number | null;
  clarifying_question: string | null;
  /** A standing fact about the user, for "remember: ...". */
  memory: string | null;
  source: "button" | "keyword" | "llm";
}

const blank = (intent: Intent, source: Parsed["source"], patch: Partial<Parsed> = {}): Parsed => ({
  intent,
  confidence: 1,
  target: { instance_number: null, instance_id: null, task_query: null },
  choice: null,
  task: { title: null, notes: null, rrule: null, local_time: null, start_date: null, policy: null, overlap: null },
  snooze_minutes: null,
  timezone: null,
  quiet_hours: null,
  pause_minutes: null,
  clarifying_question: null,
  memory: null,
  source,
  ...patch,
});

/** '30m' | '2h' | '90' -> minutes */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|days?)?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "m").toLowerCase();
  if (unit.startsWith("h")) return n * 60;
  if (unit.startsWith("d")) return n * 1440;
  return n;
}

// ------------------------------------------------------------------ fast path

/**
 * Button callbacks: `verb:instanceId:index[:arg]`. Unambiguous by construction
 * — the payload carries the exact instance id, so there is nothing to resolve.
 */
export function parseButton(payload: string): Parsed | null {
  const [verb, instanceId, , arg] = payload.split(":");
  if (!instanceId) return null;
  const target = { instance_number: null, instance_id: instanceId, task_query: null };
  switch (verb) {
    case "done":
      return blank("complete", "button", { target });
    case "skip":
      return blank("skip", "button", { target });
    case "snooze":
      return blank("snooze", "button", { target, snooze_minutes: parseDuration(arg) ?? 60 });
    // The ❌ Forever button: delete the whole series. Carries the exact
    // instance id like every button, and needsConfirmation exempts buttons —
    // the tap IS the confirmation, per the owner's explicit choice.
    case "remove":
      return blank("delete", "button", { target });
    default:
      return null;
  }
}

/**
 * Keyword path. Returns null if nothing matches, in which case the caller
 * escalates to the model.
 *
 * A bare `done` with more than one live chain deliberately does NOT guess —
 * acknowledging the wrong reminder silences something you needed.
 */
export function parseKeyword(raw: string, live: LiveInstance[]): Parsed | null {
  const text = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  const byNumber = (n: number | null) =>
    n && live[n - 1] ? live[n - 1].id : null;

  let m: RegExpExecArray | null;

  // done | done 2 | d 2 | ✅ | x
  if ((m = /^(?:done|d|x|✅|✔️?|finished|complete)\s*(\d+)?$/.exec(text))) {
    const n = m[1] ? parseInt(m[1], 10) : null;
    if (n === null && live.length > 1) {
      return blank("unknown", "keyword", {
        confidence: 0.3,
        clarifying_question: "Which one? Reply with its number, e.g. `done 2`.",
      });
    }
    const idx = n ?? (live.length === 1 ? 1 : null);
    return blank("complete", "keyword", {
      target: { instance_number: idx, instance_id: byNumber(idx), task_query: null },
    });
  }

  // snooze | snooze 30m | snooze 2 1h | later
  // Whitespace between the groups is required. Without it, `\s*(\d+)?` grabs
  // the "4" of "45m" as an index and leaves "5m" as the duration.
  if ((m = /^(?:snooze|later|zz)(?:\s+(\d+))?(?:\s+(\d+\s*(?:m|min|mins|minutes|h|hr|hrs|hours)?))?$/.exec(text))) {
    const hasIndex = m[1] !== undefined && m[2] !== undefined;
    const idx = hasIndex ? parseInt(m[1], 10) : live.length === 1 ? 1 : null;
    const dur = parseDuration(hasIndex ? m[2] : (m[2] ?? m[1])) ?? 60;
    if (idx === null && live.length > 1) {
      return blank("unknown", "keyword", {
        confidence: 0.3,
        clarifying_question: "Snooze which one? e.g. `snooze 2 30m`.",
      });
    }
    return blank("snooze", "keyword", {
      target: { instance_number: idx, instance_id: byNumber(idx), task_query: null },
      snooze_minutes: dur,
    });
  }

  // skip | skip 3
  if ((m = /^skip\s*(\d+)?$/.exec(text))) {
    const idx = m[1] ? parseInt(m[1], 10) : live.length === 1 ? 1 : null;
    if (idx === null && live.length > 1) {
      return blank("unknown", "keyword", {
        confidence: 0.3,
        clarifying_question: "Skip which one? e.g. `skip 2`.",
      });
    }
    return blank("skip", "keyword", {
      target: { instance_number: idx, instance_id: byNumber(idx), task_query: null },
    });
  }

  if (/^(list|open|now|today|what'?s? (?:open|due))$/.test(text)) return blank("list", "keyword");
  if (/^(tasks|reminders|all)$/.test(text)) return blank("tasks", "keyword");
  // Before the help catch-all below: that regex matches "what do you ...",
  // which swallowed "what do you know about me" and answered with the manual.
  if (/^(preferences|about me|what do you know about me)$/.test(text)) {
    return blank("preferences", "keyword");
  }
  if (/^(help|\?|start|\/start|\/help)$/.test(text)) return blank("help", "keyword");
  // Common questions about the bot itself — answer with help, skip the model.
  if (/what (can|do) (you|u)|what are (you|your)|how do (you|i|this)|what.*buttons?|capabilit/i.test(text)) {
    return blank("help", "keyword");
  }
  if (/^(y|yes|yep|confirm|ok|okay)$/.test(text)) return blank("confirm", "keyword");
  // Answers to a numbered choice the bot offered ("That matches 2: …").
  // "Both of them" once went to the model, which asked what the user meant.
  if (/^(?:(?:delete|remove)\s+)?(?:both|all)(?:\s+of\s+them)?$/.test(text)) {
    return blank("confirm", "keyword", { choice: "all" });
  }
  if ((m = /^(\d{1,2})$/.exec(text))) {
    return blank("confirm", "keyword", { choice: parseInt(m[1], 10) });
  }
  // Typed delete, deterministic. The model, asked to delete something right
  // after a conversation about a task, hedged with BOTH the name and an open
  // list number — and the number pointed at a different reminder.
  if ((m = /^(?:delete|remove)\s+(?:the\s+)?(\d{1,2})$/i.exec(text))) {
    const idx = parseInt(m[1], 10);
    return blank("delete", "keyword", {
      target: { instance_number: idx, instance_id: byNumber(idx), task_query: null },
    });
  }
  if ((m = /^(?:delete|remove)\s+(?:the\s+)?(?:reminder\s+(?:for\s+)?)?(\S.*)$/i.exec(raw.trim()))) {
    return blank("delete", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1].trim() },
    });
  }
  if (/^(resume|unpause|back)$/.test(text)) return blank("resume", "keyword");

  if ((m = /^(?:pause|stop|mute)\s*(\d+\s*\w*)?$/.exec(text))) {
    return blank("pause", "keyword", { pause_minutes: parseDuration(m[1]) });
  }

  // "note for gym: knee has been bad, start with five minutes" — and a bare
  // "note: ..." right after creating something, which attaches to that task.
  // Deterministic: capturing context must never itself cost a model call.
  // A colon is the EXPLICIT separator and wins when present — titles never
  // contain one, so "note for check-in flight: passport ready" splits at the
  // colon even though the title has a dash. Only without a colon do comma,
  // dash or newline end the title ("Note for book Thailand flight,\n\n…").
  if (
    (m =
      /^note\s+for\s+([^:\n]+?)\s*:\s*(\S[\s\S]*)$/i.exec(raw.trim()) ??
      /^note\s+for\s+([^:,\-\n]+?)\s*[,\-\n]\s*(\S[\s\S]*)$/i.exec(raw.trim()))
  ) {
    return blank("set_notes", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1].trim() },
      task: {
        title: null, notes: m[2].trim(), rrule: null, local_time: null,
        start_date: null, policy: null, overlap: null,
      },
    });
  }
  if ((m = /^notes?(?:\s+for\s+([^:,\-\n]+))?$/i.exec(text))) {
    return blank("show_notes", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1]?.trim() ?? null },
    });
  }
  if ((m = /^note\s*[:\-]\s*(.+)$/is.exec(raw.trim()))) {
    return blank("set_notes", "keyword", {
      task: {
        title: null, notes: m[1].trim(), rrule: null, local_time: null,
        start_date: null, policy: null, overlap: null,
      },
    });
  }

  // "remember: I use Ryse protein" — standing facts, kept apart from task
  // notes because they apply to everything rather than to one reminder.
  if ((m = /^(?:remember|note about me)\s*[:\-]\s*(.+)$/is.exec(raw.trim()))) {
    return blank("remember", "keyword", { memory: m[1].trim() });
  }
  if ((m = /^forget\s+(\d+)$/.exec(text))) {
    return blank("forget", "keyword", { target: { instance_number: parseInt(m[1], 10), instance_id: null, task_query: null } });
  }
  // "research protein powder: current price of Ryse on Amazon" — attach a
  // daily web lookup to a task. Deterministic, like every config-changing
  // command. The query rides in task.notes (documented convention).
  if (
    (m =
      /^(?:research|look ?up)\s+(?:for\s+)?([^:\n]+?)\s*:\s*(\S[\s\S]*)$/i.exec(raw.trim()) ??
      /^(?:research|look ?up)\s+(?:for\s+)?([^:,\-\n]+?)\s*[,\-\n]\s*(\S[\s\S]*)$/i.exec(raw.trim()))
  ) {
    return blank("research", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1].trim() },
      task: {
        title: null, notes: m[2].trim(), rrule: null, local_time: null,
        start_date: null, policy: null, overlap: null,
      },
    });
  }
  if ((m = /^stop\s+(?:research(?:ing)?|look(?:ing)? ?up)\s+(?:for\s+)?(.+)$/i.exec(text))) {
    return blank("research", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1].trim() },
    });
  }

  // "make book flight a one-off" / "set gym to once" — the repair for a task
  // that was created as recurring when it should only ever happen once.
  if ((m = /^(?:make|set)\s+(.+?)\s+(?:a\s+|to\s+(?:a\s+)?)?(?:one[- ]?off|one[- ]?time|once)$/.exec(text))) {
    return blank("update", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1] },
      task: {
        title: null, notes: null, rrule: "FREQ=DAILY;COUNT=1", local_time: null,
        start_date: null, policy: null, overlap: null,
      },
    });
  }

  // Speakable policies: "make gym urgent", "set trash to gentle".
  // Last, so it can't shadow the verbs above; a policy word must end the line.
  if ((m = /^(?:make|set)\s+(.+?)(?:\s+to)?\s+(gentle|urgent|quiet|notify|default)$/.exec(text))) {
    return blank("update", "keyword", {
      target: { instance_number: null, instance_id: null, task_query: m[1] },
      task: {
        title: null, notes: null, rrule: null, local_time: null, start_date: null,
        // "quiet" is how the tier is spoken; 'default' is the policy that carries it.
        policy: m[2] === "quiet" ? "default" : m[2],
        overlap: null,
      },
    });
  }

  return null;
}

// ------------------------------------------------------------------ LLM path

const SYSTEM = `You convert short text messages into reminder-app commands.

Reply with ONE JSON object and nothing else. No prose, no markdown fences.

Schema:
{
  "intent": "create|update|delete|complete|snooze|skip|list|tasks|help|set_notes|show_notes|remember|preferences|research|set_timezone|set_quiet_hours|pause|resume|unknown",
  "confidence": 0.0-1.0,
  "target": {"instance_number": int|null, "task_query": string|null},
  "task": {"title": string|null, "notes": string|null, "rrule": string|null, "local_time": "HH:MM"|null,
           "start_date": "YYYY-MM-DD"|null,
           "policy": "notify|gentle|default|urgent"|null, "overlap": "supersede|stack"|null},
  "snooze_minutes": int|null,
  "timezone": "IANA zone"|null,
  "quiet_hours": {"start":"HH:MM","end":"HH:MM"}|null,
  "pause_minutes": int|null,
  "clarifying_question": string|null,
  "memory": string|null
}

Rules:
0. Questions ABOUT the bot itself — capabilities ("what can you do"), how it
   works, what the buttons do, how to phrase things — are intent "help" with
   confidence 1.0. Do not ask a clarifying question for these; "help" IS the
   answer. Only use "unknown" when the message looks like a task command you
   cannot parse.
1. "rrule" is a bare RFC 5545 rule: FREQ=WEEKLY;BYDAY=MO,WE,FR. Never natural
   language. Never include DTSTART. Use BYDAY with an ordinal for things like
   the last Friday of the month (BYDAY=-1FR).
1b. ONE-TIME reminders ("remind me to X", "tomorrow at 3", "on sept 20") are
   rrule "FREQ=DAILY;COUNT=1". ALWAYS set start_date for these — resolve
   "today"/"tomorrow"/weekday names/"sept 20" into a YYYY-MM-DD date using the
   supplied now and timezone. start_date is what puts the reminder on the right
   day; without it the reminder happens today. Never schedule a one-off in the
   past — if the time today has passed, use tomorrow. If the user gives no time
   or date at all ("soon", "at some point"), still emit the COUNT=1 rrule with
   start_date and local_time null — the app picks a default. Do NOT ask how
   often for a one-time reminder.
1c. ONE-OFF IS THE DEFAULT. Ask: "once they have done this, is it finished?"
   Finished after one go -> one-off (FREQ=DAILY;COUNT=1):
     book a flight, set up a doctor's appointment, register for a class,
     renew a passport, call the bank, buy a specific thing, fix the sink,
     plan a trip with someone, reply to an email, find someone's number.
   Comes round again by its own nature -> recurring:
     gym, vitamins, take out the trash, water the plants, weekly review,
     stand-up, pay rent, weigh in.
   Emit a RECURRING rule ONLY when the user actually said a repeating word —
   "every", "each", "daily", "weekly", "monthly", "on Mondays", "twice a
   week". If they said no such word, it is a one-off, even when the task
   sounds like it might recur. "remind me to book the Thailand flight" is
   COUNT=1; "remind me to stretch every morning" is FREQ=DAILY.
2. Resolve relative times against the supplied now and timezone. Never assume UTC.
3. Never invent a local_time. If the user gave no time, leave it null.
4. Prefer overlap "stack" only for things that genuinely accumulate (paperwork,
   errands). Daily habits are "supersede".
5. If the message is ambiguous or you are guessing, set intent "unknown", a low
   confidence, and write a clarifying_question. Do not guess.
6. "task_query" is a short substring of an existing task title, for update,
   delete, complete and skip.
7. Titles are short and imperative: "gym", "take out trash", "review finances".
8. FOLLOW-UPS: "that" / "it" / "the reminder" refers to the task in the
   previous exchange. "Make that in the evening" after creating a task is
   intent "update" with that task as task_query and the new local_time.
9. If your previous reply was a clarifying question, the current message is
   probably the ANSWER. Merge it with what the user originally asked and emit
   the complete intent — never reply "nothing to change" territory: an update
   must carry the field being changed.
10. Times of day when no clock time is given: morning=09:00, noon=12:00,
   afternoon=15:00, evening=18:00, night/tonight=21:00.
10a. A create may carry its own context. "Add a daily reminder to organize the
   bedroom. Note: hanging the Lego painting, use hangers" is ONE intent
   "create", with the reminder in task.title and everything after "note:" in
   task.notes. Do not drop it and do not split it into two intents.
10b. CONTEXT about an existing task — "the gym one is for my knee", "I need
   this because rent is due" — is intent "set_notes" with task_query and the
   context in task.notes. It is never a new task.
10a2. Asking to SEE notes — "list my notes", "what's the note on gym" — is
   intent "show_notes" (task_query optional). Never help.
10b2. Asking to LOOK SOMETHING UP for a task — "check the price", "find deals
   on X", "tell me what's best" — is intent "research": task_query names the
   task, task.notes carries what to search for. The app then checks the web
   daily and shows what it finds on the nag.
10c. A STANDING FACT about the user rather than about one task — "I use Ryse
   protein", "I shop at Costco", "my gym is on 5th" — is intent "remember"
   with the fact in "memory". These apply to everything; task.notes applies to
   one reminder. If unsure which, prefer set_notes.
11. POLICY is how loudly it nags, and is spoken plainly. Set it on create AND on
   update, whenever the user says something about insistence:
     "just notify me", "one ping", "don't nag"        -> "notify"
     "gently", "softly", "no rush", "easy on me"      -> "gentle"
     "quietly", "on the board", "normal"              -> "default"
     "urgent", "important", "keep at me", "nag me"    -> "urgent"
   "make the gym one urgent" / "stop nagging me about trash" are intent
   "update" with task_query set and ONLY policy changed — leave rrule and
   local_time null so the schedule is left alone.`;

export async function parseWithLlm(
  text: string,
  ctx: {
    now: number;
    timezone: string;
    live: LiveInstance[];
    taskTitles: string[];
    lastExchange?: { user: string; bot: string } | null;
  },
  env: { ANTHROPIC_API_KEY?: string; PARSER_MODEL?: string },
): Promise<Parsed> {
  if (!env.ANTHROPIC_API_KEY) {
    return blank("unknown", "llm", {
      confidence: 0,
      clarifying_question:
        "I didn't understand that. Try: `gym every mon/wed/fri at 6:30am`, `list`, or `done 1`.",
    });
  }

  const context = [
    `now: ${new Date(ctx.now).toISOString()}`,
    ctx.lastExchange
      ? `previous exchange —\n  user said: ${ctx.lastExchange.user}\n  you replied: ${ctx.lastExchange.bot}`
      : `previous exchange — none`,
    `timezone: ${ctx.timezone}`,
    `open reminders: ${
      ctx.live.length
        ? ctx.live.map((i, k) => `${k + 1}. ${i.title}`).join("; ")
        : "none"
    }`,
    `existing tasks: ${ctx.taskTitles.join("; ") || "none"}`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.PARSER_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: `${context}\n\nmessage: ${text}` }],
    }),
  });

  if (!res.ok) {
    return blank("unknown", "llm", {
      confidence: 0,
      clarifying_question: "I couldn't parse that right now — try again in a moment?",
    });
  }

  const data = (await res.json()) as any;
  const body = (data.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  try {
    const raw = JSON.parse(body);
    const p = blank(normalizeIntent(raw.intent), "llm", {
      confidence: clamp(raw.confidence),
      target: {
        instance_number: intOrNull(raw.target?.instance_number),
        instance_id: null,
        task_query: strOrNull(raw.target?.task_query),
      },
      task: {
        title: strOrNull(raw.task?.title),
        notes: strOrNull(raw.task?.notes),
        rrule: strOrNull(raw.task?.rrule),
        local_time: strOrNull(raw.task?.local_time),
        start_date: (() => {
          const v = strOrNull(raw.task?.start_date);
          return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
        })(),
        policy: strOrNull(raw.task?.policy),
        overlap: raw.task?.overlap === "stack" ? "stack" : raw.task?.overlap === "supersede" ? "supersede" : null,
      },
      snooze_minutes: intOrNull(raw.snooze_minutes),
      timezone: strOrNull(raw.timezone),
      quiet_hours:
        raw.quiet_hours?.start && raw.quiet_hours?.end
          ? { start: String(raw.quiet_hours.start), end: String(raw.quiet_hours.end) }
          : null,
      pause_minutes: intOrNull(raw.pause_minutes),
      clarifying_question: strOrNull(raw.clarifying_question),
      memory: strOrNull(raw.memory),
    });
    // Resolve a model-supplied index against the real live list.
    const n = p.target.instance_number;
    if (n && ctx.live[n - 1]) p.target.instance_id = ctx.live[n - 1].id;
    return p;
  } catch {
    return blank("unknown", "llm", {
      confidence: 0,
      clarifying_question: "I didn't quite get that — can you rephrase?",
    });
  }
}

/** Destructive or low-confidence actions get a two-turn handshake. */
export function needsConfirmation(p: Parsed): boolean {
  if (p.source === "button") return false;
  if (p.intent === "delete") return true;
  if (p.intent === "update" && p.task.rrule) return true;
  return p.confidence < 0.8;
}

const INTENTS: Intent[] = [
  "create", "update", "delete", "complete", "snooze", "skip", "list", "tasks",
  "set_notes", "show_notes", "remember", "forget", "preferences", "research", "set_timezone", "set_quiet_hours", "pause", "resume", "confirm", "help", "unknown",
];

function normalizeIntent(v: unknown): Intent {
  const s = String(v ?? "").toLowerCase() as Intent;
  return INTENTS.includes(s) ? s : "unknown";
}
const clamp = (v: unknown): number => Math.min(1, Math.max(0, Number(v) || 0));
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const intOrNull = (v: unknown): number | null =>
  Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.round(Number(v)) : null;
