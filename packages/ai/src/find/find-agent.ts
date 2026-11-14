/**
 * /find agent (issue #13): Gemini tool-calling loop over read-only catalogue
 * tools, ending in a structured final_answer that must pass the grounding
 * check. Any failure returns { ok: false } so the caller can fall back to the
 * rule-based recommender. This module never touches orders or money.
 */
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import type { ReviewRecord, ReviewStore } from "../context/reviews.js";
import type { Catalogue, MealRecord } from "./catalogue.js";
import { checkGrounding, type ProposedPick } from "./grounding.js";
import { preSearch } from "./presearch.js";
import { declarationsFor, FINAL_ANSWER, runReadTool, ToolArgError } from "./tools.js";
import { loadPrompt } from "../prompts.js";
import { warningsOf } from "../recommend/engine.js";
import { parseItem, profileOf } from "../recommend/profile.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";

/** prompts/find/<version>/. Override with FIND_PROMPT_VERSION; see prompts/README.md. */
export const DEFAULT_PROMPT_VERSION = "v2";

export function buildSystemPrompt(opts: { reviews: boolean; version?: string }): string {
  const version = opts.version ?? process.env.FIND_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION;
  const claims = loadPrompt("find", version, opts.reviews ? "claims-reviews" : "claims-no-reviews");
  return loadPrompt("find", version, "system").replace("{{CLAIMS_RULE}}", claims);
}

export interface FindAgentOptions {
  catalogue: Catalogue;
  /** Student reviews. Without it the agent runs on catalogue facts only. */
  reviews?: ReviewStore | null;
  apiKey?: string;
  model?: string;
  /** Model round-trips before giving up. */
  maxSteps?: number;
  /** Per model call (default 8s). Each call also stops at the overall deadline. */
  timeoutMs?: number;
  /** Whole conversation, model and tools (default 20s, contracts/tools.md "Limits"); then fall back. */
  deadlineMs?: number;
  /** Rejected final answers allowed before giving up. */
  maxRepairs?: number;
  /** Run search_meals on the student's words before the first model call (default true). */
  preSearch?: boolean;
  /** Gemini thinking level: MINIMAL, LOW, MEDIUM, HIGH or "default" (model's own). Env FIND_THINKING_LEVEL; default LOW. */
  thinkingLevel?: string;
}

export interface FindPick {
  meal: MealRecord;
  reason: string;
  /** Reviews backing the reason, already checked to be about this meal's vendor. */
  reviews: ReviewRecord[];
}

export interface FindTrace {
  /** Model that served this conversation; empty until one answers. */
  model: string;
  /** Failed model calls (retries and fallbacks), for cost and reliability tracking. */
  attempts: { model: string; error: string }[];
  steps: { tool: string; args: unknown; result?: unknown; error?: string; ms?: number }[];
  /** One entry per model round-trip that answered: wall time (including retries/fallbacks) and the tools it asked for. */
  turns: { ms: number; calls: string[] }[];
  /** Total wall time spent waiting on the model vs running read tools. */
  modelMs: number;
  toolMs: number;
  rejections: string[][];
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export type FindResult =
  | { ok: true; message: string; picks: FindPick[]; trace: FindTrace }
  | {
      ok: false;
      reason: "not_configured" | "model_error" | "timeout" | "ungrounded" | "too_many_steps";
      detail?: string;
      /** Meals matching the request's food words or budget (catalogue rows, stored prices), for the keyword fallback to show. */
      candidates?: MealRecord[];
      /** "keywords": candidates matched the student's food words; "budget": only their budget. */
      candidatesMatchedBy?: "keywords" | "budget";
      trace: FindTrace;
    };

export class FindAgent {
  private ai: GoogleGenAI | null;
  private models: string[];
  private maxSteps: number;
  private timeoutMs: number;
  private deadlineMs: number;
  private maxRepairs: number;
  private thinkingLevel: ThinkingLevel | null;

  constructor(private opts: FindAgentOptions) {
    const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.AI_PROVIDER_API_KEY;
    this.ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
    // GEMINI_MODEL may be a comma-separated list: primary first, then fallbacks for 429/5xx.
    const spec = opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.models = spec.split(",").map((s) => s.trim()).filter(Boolean);
    this.maxSteps = opts.maxSteps ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.deadlineMs = opts.deadlineMs ?? 20_000;
    this.maxRepairs = opts.maxRepairs ?? 1;
    const level = (opts.thinkingLevel ?? process.env.FIND_THINKING_LEVEL ?? "LOW").toUpperCase();
    this.thinkingLevel = level === "DEFAULT" ? null : (ThinkingLevel as Record<string, ThinkingLevel>)[level] ?? ThinkingLevel.LOW;
  }

  isConfigured(): boolean {
    return this.ai !== null;
  }

  async find(userText: string): Promise<FindResult> {
    const started = Date.now();
    const trace: FindTrace = { model: "", attempts: [], steps: [], turns: [], modelMs: 0, toolMs: 0, rejections: [], inputTokens: 0, outputTokens: 0, ms: 0 };
    const deadline = started + this.deadlineMs;
    let candidates: MealRecord[] = [];
    let matchedBy: "keywords" | "budget" = "keywords";
    const done = <T extends FindResult>(r: T): T => {
      trace.ms = Date.now() - started;
      if (!r.ok && candidates.length) Object.assign(r, { candidates, candidatesMatchedBy: matchedBy });
      return r;
    };

    const seen = new Map<string, MealRecord>();
    const seenReviews = new Map<string, ReviewRecord>();
    const toolCtx = {
      catalogue: this.opts.catalogue,
      reviews: this.opts.reviews,
      onSeenMeals: (meals: MealRecord[]) => meals.forEach((m) => seen.set(m.mealId, m)),
      onSeenReviews: (reviews: ReviewRecord[]) => reviews.forEach((r) => seenReviews.set(r.reviewId, r)),
    };
    const request = userText.slice(0, 1000);
    const firstTurn: Part[] = [{ text: request }];
    if (this.opts.preSearch !== false) {
      // Same read tools and "seen" bookkeeping as model-requested calls, so grounding
      // treats these meals and reviews exactly like ones the model asked for.
      const toolStarted = Date.now();
      const pre = await preSearch(request, toolCtx);
      trace.toolMs += Date.now() - toolStarted;
      if (pre) {
        if (pre.matchedBy !== "overview") {
          candidates = pre.meals;
          matchedBy = pre.matchedBy;
        }
        trace.steps.push(...pre.steps);
        firstTurn.push({ text: pre.text });
      }
    }
    // After the pre-search, so keyword mode still has candidates without a key.
    if (!this.ai) return done({ ok: false, reason: "not_configured", trace });
    const contents: Content[] = [{ role: "user", parts: firstTurn }];

    // maxSteps model calls for searching and answering, plus one extra call per allowed repair,
    // so an answer rejected on the last search step can still be fixed.
    for (let step = 0; step < this.maxSteps + this.maxRepairs; step++) {
      let response;
      const modelStarted = Date.now();
      const remaining = deadline - modelStarted;
      if (remaining <= 500) return done({ ok: false, reason: "timeout", detail: `over the ${this.deadlineMs}ms deadline`, trace });
      try {
        // From the last search step on, or when time is short, only final_answer is allowed,
        // so the model answers with what it has found instead of timing out.
        const finalOnly = step >= this.maxSteps - 1 || remaining < FINAL_ONLY_BELOW_MS;
        response = await this.generate(contents, trace, finalOnly, deadline);
      } catch (err: any) {
        trace.modelMs += Date.now() - modelStarted;
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        return done({ ok: false, reason: timedOut ? "timeout" : "model_error", detail: String(err?.message ?? err), trace });
      }
      const modelMs = Date.now() - modelStarted;
      trace.modelMs += modelMs;

      trace.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      trace.outputTokens +=
        (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);

      const modelContent = response.candidates?.[0]?.content;
      const calls = response.functionCalls ?? [];
      trace.turns.push({ ms: modelMs, calls: calls.map((c) => c.name ?? "") });
      if (!modelContent || calls.length === 0) {
        return done({ ok: false, reason: "model_error", detail: "model returned no function call", trace });
      }
      // Keep the model turn verbatim so Gemini thought signatures are preserved.
      contents.push(modelContent);

      const replies: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;

        if (name === FINAL_ANSWER) {
          const parsed = parseFinalAnswer(args);
          const verdict = parsed.ok
            ? checkGrounding({ message: parsed.message, picks: parsed.picks, seen, seenReviews, userText })
            : { ok: false as const, problems: [parsed.error] };
          trace.steps.push({ tool: name, args, error: verdict.ok ? undefined : verdict.problems.join("; ") });

          let problems = verdict.ok ? [] : verdict.problems;
          if (verdict.ok && parsed.ok) {
            const picks = await this.resolvePicks(parsed.picks, seenReviews);
            if (picks) return done({ ok: true, message: parsed.message, picks, trace });
            problems = ["a picked meal is no longer available"]; // changed between search and answer
          }
          trace.rejections.push(problems);
          if (trace.rejections.length > this.maxRepairs) {
            return done({ ok: false, reason: "ungrounded", detail: problems.join("; "), trace });
          }
          replies.push(fnResponse(call.id, name, { error: "final_answer rejected", problems }));
          continue;
        }

        const toolStarted = Date.now();
        try {
          const result = await runReadTool(toolCtx, name, args);
          const ms = Date.now() - toolStarted;
          trace.toolMs += ms;
          trace.steps.push({ tool: name, args, result, ms });
          replies.push(fnResponse(call.id, name, result));
        } catch (err: any) {
          const ms = Date.now() - toolStarted;
          trace.toolMs += ms;
          const msg = err instanceof ToolArgError ? err.message : "tool failed";
          trace.steps.push({ tool: name, args, error: String(err?.message ?? err), ms });
          replies.push(fnResponse(call.id, name, { error: msg }));
        }
      }
      contents.push({ role: "user", parts: replies });
    }

    return done({ ok: false, reason: "too_many_steps", trace });
  }

  /**
   * One model round-trip, never past `deadline`.
   *
   * Before any model has answered, a 429 (quota) moves straight to the next model:
   * retrying the same model a moment later almost always gets another 429 and only
   * adds latency. Other transient failures (5xx, timeout, network) get one quick
   * retry on the same model first.
   *
   * Once a model answers, the rest of the conversation stays on it, because Gemini
   * thought signatures from one model are not valid for another. A 429 then waits
   * the delay Gemini suggests, if it fits before the deadline, and retries once.
   */
  private async generate(contents: Content[], trace: FindTrace, finalOnly: boolean, deadline: number) {
    const pinned = !!trace.model;
    const models = pinned ? [trace.model] : this.models;
    let lastErr: unknown;
    for (const [i, model] of models.entries()) {
      const hasNext = i < models.length - 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          const wait = (lastErr as any)?.status === 429 ? retryDelayMs(lastErr) ?? 1_000 : 300 + Math.random() * 300;
          if (Date.now() + wait + 1_000 > deadline) break;
          await sleep(wait);
        }
        const callTimeout = Math.min(this.timeoutMs, deadline - Date.now());
        if (callTimeout < 1_000) throw Object.assign(new Error("deadline reached"), { name: "TimeoutError" });
        try {
          const response = await this.ai!.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: buildSystemPrompt({ reviews: !!this.opts.reviews }),
              tools: [{ functionDeclarations: declarationsFor({ reviews: !!this.opts.reviews }) }],
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.ANY,
                  ...(finalOnly ? { allowedFunctionNames: [FINAL_ANSWER] } : {}),
                },
              },
              temperature: 0.4,
              ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } } : {}),
              abortSignal: AbortSignal.timeout(callTimeout),
            },
          });
          trace.model = model;
          return response;
        } catch (err) {
          lastErr = err;
          trace.attempts.push({ model, error: shortError(err) });
          if (!isTransient(err)) {
            // 404 = model name not available to this key: skip to the next model.
            if ((err as any)?.status === 404) break;
            throw err;
          }
          if ((err as any)?.status === 429 && !pinned && hasNext) break;
        }
      }
    }
    throw lastErr;
  }

  /** Re-read each pick from the catalogue so the price shown is the stored one. */
  private async resolvePicks(picks: ProposedPick[], seenReviews: Map<string, ReviewRecord>): Promise<FindPick[] | null> {
    const out: FindPick[] = [];
    for (const p of picks) {
      const meal = await this.opts.catalogue.getMeal(p.mealId);
      if (!meal || !meal.available) return null;
      const reviews = (p.reviewIds ?? []).map((id) => seenReviews.get(id)).filter((r): r is ReviewRecord => !!r);
      out.push({ meal, reason: p.reason, reviews });
    }
    return out;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Below this much time left, the model may only call final_answer. */
const FINAL_ONLY_BELOW_MS = 5_000;

/** Wait suggested by a Gemini 429 ("retryDelay": "2s"), in ms, if present. */
function retryDelayMs(err: any): number | undefined {
  const m = String(err?.message ?? "").match(/retryDelay\W+(\d+(?:\.\d+)?)s/i);
  return m ? Number(m[1]) * 1000 : undefined;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function isTransient(err: any): boolean {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  // Node's fetch throws TypeError("fetch failed") with the socket error as `cause`.
  if (err?.name === "TypeError" && /fetch failed/i.test(String(err?.message))) return true;
  if (NETWORK_CODES.has(err?.code) || NETWORK_CODES.has(err?.cause?.code)) return true;
  const status = typeof err?.status === "number" ? err.status : 0;
  return status === 429 || status >= 500;
}

function shortError(err: any): string {
  const status = err?.status ? `${err.status} ` : "";
  const name = err?.name === "TimeoutError" ? "timeout" : "";
  return `${status}${name}`.trim() || String(err?.message ?? err).slice(0, 80);
}

function fnResponse(id: string | undefined, name: string, response: Record<string, unknown>): Part {
  return { functionResponse: { id, name, response } };
}

type ParsedFinal = { ok: true; message: string; picks: ProposedPick[] } | { ok: false; error: string };

/** A review ID cited inline, alone or in a bracketed list: "(REV-066, REV-108)", "REV-107". */
const INLINE_REVIEW_IDS = /\s*\(\s*REV-[A-Z0-9-]+(?:\s*[,;]\s*REV-[A-Z0-9-]+)*\s*\)|\bREV-[A-Z0-9-]+\b/gi;

/**
 * Remove review IDs the model wrote into its text. They belong in review_ids (where
 * grounding checks them); in text they mean nothing to a student, and the grounding
 * check would read "REV-108" as a ₦108 claim.
 */
export function stripInlineReviewIds(text: string): string {
  return text
    .replace(INLINE_REVIEW_IDS, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseFinalAnswer(args: Record<string, unknown>): ParsedFinal {
  const message = typeof args.message === "string" ? stripInlineReviewIds(args.message) : "";
  if (!message) return { ok: false, error: "message is required" };
  if (!Array.isArray(args.picks)) return { ok: false, error: "picks must be an array" };
  if (args.picks.length > 3) return { ok: false, error: "at most 3 picks" };
  const picks: ProposedPick[] = [];
  for (const p of args.picks) {
    const mealId = typeof p?.meal_id === "string" ? p.meal_id : "";
    const reason = typeof p?.reason === "string" ? stripInlineReviewIds(p.reason) : "";
    if (!mealId || !reason) return { ok: false, error: "each pick needs meal_id and reason" };
    if (p.review_ids != null && (!Array.isArray(p.review_ids) || p.review_ids.some((id: unknown) => typeof id !== "string"))) {
      return { ok: false, error: "review_ids must be an array of strings" };
    }
    const reviewIds = [...new Set((p.review_ids ?? []) as string[])].slice(0, 3);
    picks.push({ mealId, reason: reason.slice(0, 200), reviewIds });
  }
  return { ok: true, message: message.slice(0, 600), picks };
}

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

/** Plain-text rendering for Telegram. Prices come from the catalogue, never from the model. */
export function formatFindReply(result: Extract<FindResult, { ok: true }>): string {
  const lines = [result.message];
  result.picks.forEach((p, i) => {
    lines.push("", `${i + 1}. ${p.meal.name} (${p.meal.vendorName}) - ${naira(p.meal.priceKobo)}`, `   ${p.reason}`);
  });
  return lines.join("\n");
}

/** Meals the keyword fallback shows at most. */
export const FALLBACK_PICKS = 3;

/**
 * Keyword-mode reply for when the model gave no usable answer (outage, timeout,
 * ungrounded answer). Built only from catalogue rows the pre-search found for the
 * student's own words, so it needs no model and makes no claim beyond name, vendor
 * and stored price. With no matches it points the student to the menu buttons.
 */
export function formatFallbackReply(result: Extract<FindResult, { ok: false }>): string {
  const meals = (result.candidates ?? []).filter((m) => m.available).slice(0, FALLBACK_PICKS);
  if (!meals.length) {
    return "I can't search properly right now. Try again in a minute, or tap Browse to see the menu.";
  }
  const lines = [
    result.candidatesMatchedBy === "budget"
      ? "I can't give a full answer right now, but these are within your budget:"
      : "I can't give a full answer right now, but these match what you asked for:",
  ];
  meals.forEach((m, i) => {
    lines.push("", `${i + 1}. ${m.name} (${m.vendorName}) - ${naira(m.priceKobo)}`);
    for (const w of cautionsFor(m)) lines.push(`   ⚠ ${w}`);
  });
  return lines.join("\n");
}

/** Allergen and pork cautions from the recommender's food rules; none when the item isn't understood. */
export function cautionsFor(meal: MealRecord): string[] {
  try {
    const parsed = parseItem(meal.vendorName, meal.name, meal.priceKobo / 100);
    return parsed.parts.length ? warningsOf(profileOf(parsed.parts, parsed.minHeat)) : [];
  } catch {
    return [];
  }
}

/** Telegram text for any /find result: the model's answer, or the keyword fallback. */
export function formatFindResult(result: FindResult): string {
  return result.ok ? formatFindReply(result) : formatFallbackReply(result);
}
