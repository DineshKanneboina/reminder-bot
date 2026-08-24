/**
 * Nag-time "first step" hints.
 *
 * A one-liner generated when a nag is about to go out, suggesting the smallest
 * concrete action that would end it. Runs on Workers AI (env.AI) rather than
 * the Anthropic key, because this is the SEND path: it must not depend on a
 * paid key, an inbound quota, or anything running on a laptop.
 *
 * Every rule here exists to keep a nag from being held hostage by a hint:
 *
 *   - hard timeout; the generation is abandoned, not awaited
 *   - any failure, empty result or suspicious result returns null
 *   - null means the nag sends exactly as it did before Phase 2
 *   - nothing in this file throws
 *
 * A late hint is worth nothing. A late nag is the product failing.
 */

import { Env } from "./types";

// Verify with `npx wrangler ai models` before changing this. Model ids are not
// stable across accounts or over time, and because every failure here is
// swallowed, a wrong id produces no hints and no error — silence that looks
// exactly like "the feature is on and the model had nothing to add".
/**
 * Verify with `npx wrangler ai models` before changing this — ids differ per
 * account, and a wrong one produces no hints and no visible error.
 *
 * The history is worth keeping. llama-3.2-3b could not hold eight rules
 * (capacity, not wording — two prompt rewrites changed nothing). gpt-oss-120b
 * looked better on paper and failed twice in practice: it returns OpenAI-style
 * { choices } rather than the documented { response }, and it is a REASONING
 * model — under max_tokens 40 it spends the whole budget thinking and emits
 * empty content. A reasoning model is the wrong tool for a 12-word imperative
 * on a 3-second budget. 70b-fp8-fast is non-reasoning, instruction-capable,
 * and answers in the shape it documents. All of these fit the 10k-neuron/day
 * free tier at ~10 hints/day; quality and fit are the only criteria that ever
 * mattered. `npm run e2e` verifies a candidate in 90 seconds — use it.
 */
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TOKENS = 40;
const MAX_CHARS = 90;
const MIN_CHARS = 4;

/**
 * Written against real output, not guesses. The first version produced "Go to
 * the grocery store" for "Buy protein powder" — a restatement at the same
 * altitude, not a smaller step — and "Open Microsoft Word and start a new
 * document" for "update resume", inventing an app the user may not own. Rules
 * 2, 3 and 4 exist for exactly those two failures.
 *
 * Examples deliberately use tasks the owner does not have. A 3b model will
 * happily echo an example verbatim when it recognises the title, which would
 * look like a good hint while teaching us nothing.
 */
const SYSTEM = [
  "You help someone start a task they keep putting off. Reply with the single smallest first move.",
  "",
  "Rules:",
  "1. ONE imperative sentence, under 12 words. No preamble, quotes, markdown or explanation.",
  "2. It must be SMALLER than the task and doable in under two minutes, right now. You are breaking inertia, not describing the job.",
  "3. Never restate the task. For \"Build shelf\", \"Build the shelf\" is useless.",
  "4. Never name an app, shop, brand or website unless the note names it. You do not know what they use.",
  "5. One concrete action only: open something, find something, move something, write one line, send one message.",
  "6. If a note is given, build the step out of what the note says.",
  "7. The more times they have ignored it, the smaller your step should be.",
  "7b. Standing facts under \"About them\" are things they told you once. Use one when it makes the step concrete — a brand, a shop, where something lives. Ignore them when they are irrelevant; never list them back.",
  "8. If the task is only two or three words, it is a label, not instructions. Infer the most likely concrete first move rather than echoing the label back.",
  "",
  "Examples:",
  "Task: Cancel the gym membership",
  "→ Find the membership email and open it.",
  "",
  "Task: Write Ana's birthday card",
  "Why it matters: it has to be posted by Friday",
  "→ Put the card and a pen on the kitchen table.",
  "",
  "Task: Fix the leaking tap",
  "They have ignored this 6 times.",
  "→ Put a bucket under the pipe.",
  "",
  "Task: Reply to Sam",
  "→ Open the thread and read his last message.",
  "",
  "Task: taxes",
  "→ Find last year's return and open it.",
].join("\n");

export interface HintSubject {
  title: string;
  notes: string | null;
  attempt_count: number;
  /** Standing facts about the owner. Empty is the normal case. */
  preferences?: string[];
  /** Cached web research for this task, if any. */
  research?: string | null;
}

/**
 * A first-step hint, or null. Null is not an error — it is the normal, safe
 * outcome whenever anything at all is off, and every caller must treat it as
 * "send the nag without a hint".
 */
export async function firstStepHint(env: Env, task: HintSubject): Promise<string | null> {
  if (!env.AI || env.HINTS_ENABLED === "0") return null;

  const facts = (task.preferences ?? []).filter(Boolean);
  const prompt =
    `Task: ${task.title}` +
    (task.notes ? `\nWhy it matters: ${task.notes}` : "") +
    (task.attempt_count > 1 ? `\nThey have ignored this ${task.attempt_count} times.` : "") +
    (facts.length ? `\nAbout them:\n${facts.map((f) => `- ${f}`).join("\n")}` : "") +
    (task.research ? `\nCurrent info (from a web check):\n${task.research}` : "");

  try {
    const raw = await withTimeout(
      env.AI.run(env.HINT_MODEL ?? DEFAULT_MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_TOKENS,
      }),
      Number(env.HINT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    );
    if (raw === null) {
      console.warn("hint timed out", { model: env.HINT_MODEL ?? DEFAULT_MODEL });
      return null;
    }
    // Two shapes exist in the wild. Most Workers AI text models return
    // { response }; gpt-oss returns OpenAI-style { choices: [{ message:
    // { content } }] } — despite Cloudflare's model page documenting
    // `response`. That mismatch silently killed every hint for three days;
    // only the shape log below made it findable. Anything else is reported,
    // never quietly treated as an empty answer.
    const text = extractText(raw);
    if (text === null) {
      console.error("hint response shape unrecognized", {
        model: env.HINT_MODEL ?? DEFAULT_MODEL,
        keys: raw && typeof raw === "object" ? Object.keys(raw).slice(0, 8) : typeof raw,
      });
      return null;
    }
    // An EMPTY answer logs too. gpt-oss returned "" for every single hint —
    // reasoning models spend max_tokens thinking — and empty was the one path
    // that said nothing anywhere.
    if (!text.trim()) {
      console.warn("hint empty", { model: env.HINT_MODEL ?? DEFAULT_MODEL });
      return null;
    }
    const clean = sanitize(text, task.title);
    if (!clean && text.trim()) {
      // A drop is as invisible as a timeout unless it says so. Log what the
      // model actually said: "why did this one nag lose its hint" is otherwise
      // unanswerable after the fact, and the answer is usually in the output.
      console.warn("hint dropped", { title: task.title, raw: text.trim().slice(0, 120) });
    }
    return clean;
  } catch (e) {
    // Model unavailable, bad model id, quota exhausted, malformed response —
    // all the same outcome for the nag. Logged rather than swallowed silently:
    // a wrong model id is invisible from the outside, so the only way to tell
    // it apart from "no hint was warranted" is a line in the log.
    console.error("hint failed", { model: env.HINT_MODEL ?? DEFAULT_MODEL, error: String(e) });
    return null;
  }
}

/** The generated text out of either Workers AI response shape, else null. */
function extractText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  if ("response" in raw) return String((raw as { response: unknown }).response ?? "");
  const choices = (raw as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices[0]?.message?.content !== undefined) {
    return String(choices[0].message.content ?? "");
  }
  return null;
}

/**
 * Resolves to null once `ms` has passed. The underlying promise is abandoned
 * rather than cancelled — Workers tears it down with the request, and waiting
 * for a slow model to finish is the exact thing this prevents.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer)) as Promise<T | null>;
}

/**
 * Model output is untrusted text on its way into an HTML message. Collapse it
 * to one line, then drop anything that doesn't look like a plain short
 * instruction — silently, because a missing hint is invisible while a mangled
 * one is worse than nothing.
 */
export function sanitize(raw: string, title = ""): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  // The examples in SYSTEM are arrow-prefixed; small models copy the format.
  s = s.replace(/^\s*(→|->|reply:)\s*/i, "");
  s = s.replace(/^["'`*_\s]+|["'`*_\s]+$/g, "");
  if (s.length < MIN_CHARS) return null;

  // Markup would break the message; a link is never a "first step".
  if (/[<>]/.test(s)) return null;
  if (/https?:\/\/|www\./i.test(s)) return null;
  // The model talking about itself or restating the prompt rather than answering.
  if (/^(as an ai|i cannot|i can't|i'm sorry|sorry[,.]|sure[,!.]|here'?s|okay[,!.]|task:|note:)/i.test(s)) {
    return null;
  }

  // A hint whose content words all appear in the title says nothing the nag did
  // not already say. "Build shelf" → "Build the shelf" is the shape to kill.
  if (title) {
    const words = contentWords(s);
    const fromTitle = contentWords(title);
    if (words.size > 0 && [...words].every((w) => fromTitle.has(w))) return null;
  }

  if (s.length > MAX_CHARS) {
    s = s.slice(0, MAX_CHARS).replace(/\s+\S*$/, "").trimEnd() + "…";
    if (s.length < MIN_CHARS) return null;
  }
  return s;
}

/** Words that carry meaning, for telling a real step from a restatement. */
const FILLER = new Set([
  "the", "a", "an", "to", "and", "of", "your", "my", "it", "its", "this", "that",
  "for", "on", "in", "at", "with", "then", "just", "start", "starting", "first",
  "go", "get", "do", "make", "take", "one", "some", "up", "out", "now",
]);

/** Crude suffix stripping, so "building the shelf" still reads as "Build shelf". */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !FILLER.has(w))
      .map(stem),
  );
}
