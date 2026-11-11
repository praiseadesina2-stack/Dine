/**
 * Review retrieval: the RAG layer over stored student reviews.
 *
 * Two retrieval paths, both deterministic:
 *  - filtered: every review for a vendor (optionally one food item);
 *  - keyword: BM25 over review text with a small food-review synonym map,
 *    so "greasy" finds "oily" and "big portion" finds "filling".
 * Semantic (embedding) search can be added behind the same ReviewStore
 * interface later without changing the tools or the agent.
 */

export type Sentiment = "positive" | "neutral" | "negative";

export interface ReviewRecord {
  reviewId: string;
  /** Survey vendor ID (V001...). */
  surveyVendorId: string;
  surveyVendorName: string;
  /**
   * The one Dine catalogue vendor this record belongs to, or null if the vendor is not in the
   * catalogue. A survey review that applies to several vendors is stored as a separate,
   * independent record per vendor.
   */
  vendorId: string | null;
  foodId: string | null;
  foodName: string | null;
  rating: number | null;
  sentiment: Sentiment | null;
  text: string;
  /** ISO timestamp of the survey response. */
  reviewedAt: string | null;
  reviewType: string | null;
  /** Where it came from: file, sheet row and the review ID as written in the sheet. */
  source: { file: string; row: number; reviewId: string };
}

export interface ReviewSummary {
  count: number;
  rated: number;
  averageRating: number | null;
  sentiment: Record<Sentiment, number>;
}

export interface ReviewSearchInput {
  query: string;
  vendorId?: string;
  limit?: number;
}

export interface ReviewHit {
  review: ReviewRecord;
  score: number;
}

export interface ReviewStore {
  forVendor(vendorId: string, opts?: { foodId?: string; limit?: number }): Promise<{ reviews: ReviewRecord[]; summary: ReviewSummary }>;
  search(input: ReviewSearchInput): Promise<ReviewHit[]>;
  get(reviewId: string): Promise<ReviewRecord | null>;
}

// Words students use for the same idea. Each group expands to all its members.
const SYNONYM_GROUPS = [
  ["oily", "greasy", "oil", "grease"],
  ["filling", "portion", "portions", "generous", "voluminous", "big", "large", "satisfying"],
  ["small", "tiny", "sparse", "little", "insufficient"],
  ["slow", "wait", "waiting", "delay", "late", "long"],
  ["fast", "quick", "quickly", "speedy"],
  ["cheap", "affordable", "economical", "value", "budget"],
  ["expensive", "pricey", "overpriced", "premium", "costly"],
  ["spicy", "peppery", "pepper", "hot"],
  ["bland", "tasteless", "flavourless", "flavorless"],
  ["tasty", "delicious", "nice", "peak", "good", "awesome", "flawless"],
  ["rude", "attitude", "attitudes"],
  ["courteous", "polite", "friendly", "kind"],
];

const STOP = new Set(
  "a an and are as at be but by for from has have i if in is it its of on or so that the their there they this to too very was were with you your not no".split(" "),
);

// Keyword scoring ignores negation: "not filling" still matches "filling". The model reads the
// full review text and sentiment, so it sees the negation; ranking alone does not.
const stem = (t: string) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

export const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const stems = [...new Set(group.map(stem))];
  for (const s of stems) SYNONYMS.set(s, [...new Set([...(SYNONYMS.get(s) ?? []), ...stems])]);
}

/** Query terms with synonyms; exact terms weigh 1, synonyms 0.6. */
export function expandQuery(query: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(query)) {
    out.set(t, 1);
    for (const syn of SYNONYMS.get(t) ?? []) if (!out.has(syn)) out.set(syn, 0.6);
  }
  return out;
}

export function summarize(reviews: ReviewRecord[]): ReviewSummary {
  const sentiment: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0 };
  let sum = 0;
  let rated = 0;
  for (const r of reviews) {
    if (r.sentiment) sentiment[r.sentiment]++;
    if (r.rating != null) { sum += r.rating; rated++; }
  }
  return {
    count: reviews.length,
    rated,
    averageRating: rated ? Math.round((sum / rated) * 10) / 10 : null,
    sentiment,
  };
}

const newestFirst = (a: ReviewRecord, b: ReviewRecord) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? "");

export class InMemoryReviewStore implements ReviewStore {
  private byId = new Map<string, ReviewRecord>();
  private docs: { review: ReviewRecord; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;

  constructor(reviews: ReviewRecord[]) {
    let total = 0;
    for (const review of reviews) {
      if (!review.text.trim()) continue;
      this.byId.set(review.reviewId, review);
      const tokens = tokenize(`${review.text} ${review.foodName ?? ""}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ review, tf, len: tokens.length });
      total += tokens.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  get size() {
    return this.docs.length;
  }

  async forVendor(vendorId: string, opts: { foodId?: string; limit?: number } = {}) {
    const all = this.docs
      .map((d) => d.review)
      .filter((r) => r.vendorId === vendorId && (!opts.foodId || r.foodId === opts.foodId))
      .sort(newestFirst);
    return { reviews: all.slice(0, opts.limit ?? 8), summary: summarize(all) };
  }

  async search(input: ReviewSearchInput): Promise<ReviewHit[]> {
    const terms = expandQuery(input.query);
    if (!terms.size) return [];
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    const hits: ReviewHit[] = [];

    for (const d of this.docs) {
      if (input.vendorId && d.review.vendorId !== input.vendorId) continue;
      let score = 0;
      for (const [term, weight] of terms) {
        const f = d.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (score > 0) hits.push({ review: d.review, score: Math.round(score * 100) / 100 });
    }
    hits.sort((x, y) => y.score - x.score || newestFirst(x.review, y.review));
    return hits.slice(0, input.limit ?? 6);
  }

  async get(reviewId: string) {
    return this.byId.get(reviewId) ?? null;
  }
}
