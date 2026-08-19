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
// 3b rather than something larger: the timeout is 1200ms, so latency beats depth.
const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const TIMEOUT_MS = 1200;
const MAX_TOKENS = 40;
const MAX_CHARS = 90;
const MIN_CHARS = 4;

const SYSTEM =
  "You suggest the smallest possible first step for a task someone keeps " +
  "putting off. Reply with ONE short imperative sentence, under 12 words. " +
  "No preamble, no quotes, no markdown, no explanation. If the task is " +
  "already small, restate it as one concrete physical action.";

export interface HintSubject {
  title: string;
  notes: string | null;
  attempt_count: number;
}

/**
 * A first-step hint, or null. Null is not an error — it is the normal, safe
 * outcome whenever anything at all is off, and every caller must treat it as
 * "send the nag without a hint".
 */
export async function firstStepHint(env: Env, task: HintSubject): Promise<string | null> {
  if (!env.AI || env.HINTS_ENABLED === "0") return null;

  const prompt =
    `Task: ${task.title}` +
    (task.notes ? `\nWhy it matters: ${task.notes}` : "") +
    (task.attempt_count > 1 ? `\nThey have ignored this ${task.attempt_count} times.` : "");

  try {
    const raw = await withTimeout(
      env.AI.run(env.HINT_MODEL ?? DEFAULT_MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_TOKENS,
      }),
      TIMEOUT_MS,
    );
    if (raw === null) {
      console.warn("hint timed out", { model: env.HINT_MODEL ?? DEFAULT_MODEL });
      return null;
    }
    const text =
      raw && typeof raw === "object" && "response" in raw
        ? String((raw as { response: unknown }).response ?? "")
        : "";
    return sanitize(text);
  } catch (e) {
    // Model unavailable, bad model id, quota exhausted, malformed response —
    // all the same outcome for the nag. Logged rather than swallowed silently:
    // a wrong model id is invisible from the outside, so the only way to tell
    // it apart from "no hint was warranted" is a line in the log.
    console.error("hint failed", { model: env.HINT_MODEL ?? DEFAULT_MODEL, error: String(e) });
    return null;
  }
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
export function sanitize(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^["'`*_\s]+|["'`*_\s]+$/g, "");
  if (s.length < MIN_CHARS) return null;

  // Markup would break the message; a link is never a "first step".
  if (/[<>]/.test(s)) return null;
  if (/https?:\/\/|www\./i.test(s)) return null;
  // The model talking about itself or restating the prompt rather than answering.
  if (/^(as an ai|i cannot|i can't|i'm sorry|sorry[,.]|sure[,!.]|here'?s|okay[,!.]|task:|note:)/i.test(s)) {
    return null;
  }

  if (s.length > MAX_CHARS) {
    s = s.slice(0, MAX_CHARS).replace(/\s+\S*$/, "").trimEnd() + "…";
    if (s.length < MIN_CHARS) return null;
  }
  return s;
}
