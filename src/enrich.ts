/**
 * Task research: a cached answer to one small practical question per task,
 * looked up with Anthropic server-side web search and shown on the nag.
 *
 * Everything here honours two rules settled when this was designed:
 *
 *   1. OFF the send path. Refreshes run in their own tick phase after every
 *      send has gone out; the nag renders only what is already cached. A
 *      search round-trip must never hold a reminder.
 *   2. Attributed or absent. A result always carries its sources and its age.
 *      An unsourced price claim in a nag is worse than no claim — the bot
 *      confidently citing a deal that does not exist is the failure mode that
 *      kept this feature at the bottom of the roadmap.
 *
 * This is also the only part of the system that costs real money (~1-2¢ per
 * refresh: one web search plus Haiku tokens), which is why it is opt-in per
 * task and budgeted to one refresh per tick.
 */

import { Env } from "./types";

const DEFAULT_MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 25_000;
const MAX_RESULT_CHARS = 320;

const SYSTEM =
  "You research one small practical question for a personal reminder app. " +
  "Use web search. Reply with 1-3 plain sentences of the most useful CURRENT " +
  "facts — concrete prices, dates, availability, names. No preamble, no " +
  "markdown, no links in the text. If you cannot find solid current " +
  "information, reply with exactly NO_RESULT.";

export interface ResearchResult {
  summary: string;
  /** Source domains, e.g. ["amazon.com", "costco.com"]. Never empty. */
  sources: string[];
}

/**
 * One research run. Null on any failure, timeout, empty answer, NO_RESULT, or
 * an answer with no citations — an uncited claim is treated as no answer.
 */
export async function runResearch(env: Env, query: string): Promise<ResearchResult | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ENRICH_MODEL ?? DEFAULT_MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: query }],
        // The basic search tool — Haiku doesn't take the dynamic-filtering
        // variant. max_uses caps the per-refresh spend.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      }),
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.error("research call failed", { status: res.status, body: (await res.text()).slice(0, 200) });
      return null;
    }
    const json: any = await res.json();

    // Assemble the text and collect citation URLs from the content blocks.
    let text = "";
    const urls = new Set<string>();
    for (const block of json?.content ?? []) {
      if (block?.type === "text") {
        text += block.text ?? "";
        for (const c of block.citations ?? []) if (c?.url) urls.add(String(c.url));
      }
    }
    const summary = sanitizeResearch(text);
    if (!summary || /^no_result/i.test(summary)) return null;

    const sources = [...urls].map(domainOf).filter(Boolean);
    if (sources.length === 0) {
      // A confident answer with nothing behind it is exactly what must never
      // reach a nag.
      console.warn("research uncited, dropped", { summary: summary.slice(0, 80) });
      return null;
    }
    return { summary, sources: [...new Set(sources)].slice(0, 3) };
  } catch (e) {
    console.error("research failed", String(e));
    return null;
  }
}

/** Untrusted web-derived text on its way into an HTML message. */
export function sanitizeResearch(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  if (/[<>]/.test(s)) s = s.replace(/[<>]/g, "");
  s = s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  if (s.length < 8) return null;
  if (s.length > MAX_RESULT_CHARS) {
    s = s.slice(0, MAX_RESULT_CHARS).replace(/\s+\S*$/, "").trimEnd() + "…";
  }
  return s;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "amazon.com · 3h ago" — a claim is only as good as where and when. */
export function researchLabel(sources: string[], fetchedAtIso: string, now: number): string {
  const hours = Math.max(0, (now - Date.parse(fetchedAtIso)) / 3600_000);
  const age = hours < 1 ? "just now" : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
  return `${sources.join(", ")} · ${age}`;
}
