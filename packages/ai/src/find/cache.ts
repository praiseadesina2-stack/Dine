/**
 * Answer cache for /find. Wraps a FindAgent (or anything with the same `find`)
 * so repeated requests skip the model: a hit costs a few catalogue reads
 * instead of several Gemini round-trips.
 *
 * Safety rules:
 *  - Only grounded answers (ok: true) are cached. Fallbacks never are.
 *  - The cache stores meal ids, not meal records. On a hit every pick is re-read
 *    from the catalogue; if any pick is gone, unavailable or has changed price,
 *    the entry is dropped and the request goes to the agent. Prices shown always
 *    come from the catalogue at the time of the reply.
 *  - The key includes a version (model, prompt version, catalogue version), so a
 *    prompt or menu change never serves answers made under the old one.
 *  - Identical requests that arrive together share one agent call.
 *
 * Storage sits behind FindCacheStore. The default is in-process memory (LRU with
 * TTL); a shared store such as Redis can be plugged in by the API without
 * changing this module.
 */
import type { ReviewRecord } from "../context/reviews.js";
import type { Catalogue, MealRecord } from "./catalogue.js";
import type { FindPick, FindResult, FindTrace } from "./find-agent.js";

/** What is stored per request: ids and text only. */
export interface CachedAnswer {
  message: string;
  picks: { mealId: string; priceKobo: number; reason: string; reviews: ReviewRecord[] }[];
  /** Model that produced the answer, for tracing. */
  model: string;
  createdAt: number;
}

export interface FindCacheStore {
  get(key: string): Promise<CachedAnswer | undefined>;
  set(key: string, value: CachedAnswer, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-process store: least-recently-used eviction plus per-entry expiry. */
export class MemoryFindCacheStore implements FindCacheStore {
  private entries = new Map<string, { value: CachedAnswer; expiresAt: number }>();

  constructor(private maxEntries = 500, private now: () => number = Date.now) {}

  async get(key: string): Promise<CachedAnswer | undefined> {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map order tracks recency.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  async set(key: string, value: CachedAnswer, ttlMs: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface Finder {
  find(userText: string): Promise<FindResult>;
}

export type CacheStatus = "hit" | "miss" | "shared" | "bypass";

export type CachedFindResult = FindResult & { cache: CacheStatus };

export interface CachedFinderOptions {
  agent: Finder;
  catalogue: Catalogue;
  store?: FindCacheStore;
  /** Default 30 minutes; menus and availability change within a meal period. */
  ttlMs?: number;
  /**
   * Anything that should invalidate cached answers when it changes: model list,
   * prompt version, catalogue version. Defaults to GEMINI_MODEL and FIND_PROMPT_VERSION.
   */
  version?: string;
  /** Requests longer than this after normalizing are not cached (long free-text notes rarely repeat). Default 160. */
  maxKeyChars?: number;
  now?: () => number;
}

export interface FindContext {
  /** Anything outside the text that changes the right answer, e.g. "lunch", a campus id. */
  scope?: string;
}

/**
 * Normalizes a request so trivially different phrasings share an entry:
 * case, spacing, punctuation, "₦2,000" / "2000 naira" / "2k" all collapse.
 * Word order is kept, because it can carry meaning ("no rice, beans").
 */
export function normalizeRequest(text: string): string {
  return text
    .toLowerCase()
    .replace(/₦|\bngn\b/g, " ")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Math.round(Number(n) * 1000)))
    .replace(/\b(\d+)\s*naira\b/g, "$1")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class CachedFinder implements Finder {
  private store: FindCacheStore;
  private ttlMs: number;
  private version: string;
  private maxKeyChars: number;
  private now: () => number;
  private inFlight = new Map<string, Promise<FindResult>>();
  readonly stats = { hit: 0, miss: 0, shared: 0, bypass: 0, stale: 0 };

  constructor(private opts: CachedFinderOptions) {
    this.store = opts.store ?? new MemoryFindCacheStore();
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.version =
      opts.version ?? `${process.env.GEMINI_MODEL ?? "default"}|${process.env.FIND_PROMPT_VERSION ?? "default"}`;
    this.maxKeyChars = opts.maxKeyChars ?? 160;
    this.now = opts.now ?? Date.now;
  }

  keyFor(userText: string, ctx: FindContext = {}): string | null {
    const norm = normalizeRequest(userText);
    if (!norm || norm.length > this.maxKeyChars) return null;
    return `find|${this.version}|${ctx.scope ?? ""}|${norm}`;
  }

  async find(userText: string, ctx: FindContext = {}): Promise<CachedFindResult> {
    const started = this.now();
    const key = this.keyFor(userText, ctx);
    if (!key) {
      this.stats.bypass++;
      return { ...(await this.opts.agent.find(userText)), cache: "bypass" };
    }

    const cached = await this.safeGet(key);
    if (cached) {
      const picks = await this.revalidate(cached);
      if (picks) {
        this.stats.hit++;
        return { ok: true, message: cached.message, picks, trace: hitTrace(cached.model, this.now() - started), cache: "hit" };
      }
      this.stats.stale++;
      await this.store.delete(key).catch(() => {});
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.stats.shared++;
      return { ...(await pending), cache: "shared" };
    }

    const call = this.opts.agent.find(userText);
    this.inFlight.set(key, call);
    try {
      const result = await call;
      this.stats.miss++;
      if (result.ok && result.picks.length) {
        await this.store
          .set(
            key,
            {
              message: result.message,
              picks: result.picks.map((p) => ({ mealId: p.meal.mealId, priceKobo: p.meal.priceKobo, reason: p.reason, reviews: p.reviews })),
              model: result.trace.model,
              createdAt: this.now(),
            },
            this.ttlMs,
          )
          .catch(() => {}); // a broken cache must never break /find
      }
      return { ...result, cache: "miss" };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async safeGet(key: string): Promise<CachedAnswer | undefined> {
    try {
      return await this.store.get(key);
    } catch {
      return undefined;
    }
  }

  /** Fresh catalogue records for every pick, or null if any pick no longer holds. */
  private async revalidate(cached: CachedAnswer): Promise<FindPick[] | null> {
    const meals = await Promise.all(cached.picks.map((p) => this.opts.catalogue.getMeal(p.mealId)));
    const out: FindPick[] = [];
    for (const [i, p] of cached.picks.entries()) {
      const meal: MealRecord | null = meals[i];
      // A price change can break the budget the answer was built for, so treat it as stale.
      if (!meal || !meal.available || meal.priceKobo !== p.priceKobo) return null;
      out.push({ meal, reason: p.reason, reviews: p.reviews });
    }
    return out;
  }
}

function hitTrace(model: string, ms: number): FindTrace {
  return { model, attempts: [], steps: [], turns: [], modelMs: 0, toolMs: ms, rejections: [], inputTokens: 0, outputTokens: 0, ms };
}
