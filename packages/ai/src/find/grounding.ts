/**
 * Groundedness check (issue #12): reject any answer that names a meal the
 * tools did not return, or mentions a money amount that is neither a price the
 * tools returned nor a number the user typed.
 */
import type { ReviewRecord } from "../context/reviews.js";
import type { MealRecord } from "./catalogue.js";

export interface ProposedPick {
  mealId: string;
  reason: string;
  /** Reviews the reason relies on. */
  reviewIds?: string[];
}

export interface GroundingInput {
  message: string;
  picks: ProposedPick[];
  /** Meals returned by tools in this conversation, keyed by mealId. */
  seen: Map<string, MealRecord>;
  /** Reviews returned by tools in this conversation, keyed by reviewId. */
  seenReviews?: Map<string, ReviewRecord>;
  /** The user's own words; budgets they typed may be echoed back. */
  userText: string;
}

export type GroundingResult = { ok: true } | { ok: false; problems: string[] };

// ₦1,200 · N1200 · NGN 1,200 · 1200 naira · 1.2k
const CURRENCY_AMOUNT =
  /(?:₦|\bNGN\s*|\bN(?=\d))\s*(\d[\d,]*(?:\.\d+)?)(k?)|(\d[\d,]*(?:\.\d+)?)(k?)\s*(?:naira|ngn)\b/gi;
// any bare number >= 100 is treated as a possible price
const BARE_NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d{3,})(?![\w.])/g;

const toNumber = (digits: string, k: string) => {
  const n = Number(digits.replace(/,/g, ""));
  return k ? n * 1000 : n;
};

export function extractAmounts(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(CURRENCY_AMOUNT)) {
    out.add(m[1] != null ? toNumber(m[1], m[2]) : toNumber(m[3], m[4]));
  }
  for (const m of text.matchAll(BARE_NUMBER)) out.add(toNumber(m[1], ""));
  return [...out];
}

export function checkGrounding(input: GroundingInput): GroundingResult {
  const problems: string[] = [];

  const ids = new Set<string>();
  for (const p of input.picks) {
    if (ids.has(p.mealId)) problems.push(`meal_id ${p.mealId} is picked twice`);
    ids.add(p.mealId);
    const meal = input.seen.get(p.mealId);
    if (!meal) problems.push(`meal_id ${p.mealId} was not returned by any tool; search first`);
    else if (!meal.available) problems.push(`meal_id ${p.mealId} is not available`);
    for (const id of p.reviewIds ?? []) {
      const review = input.seenReviews?.get(id);
      if (!review) problems.push(`review_id ${id} was not returned by get_reviews or search_reviews`);
      else if (meal && review.vendorId !== meal.vendorId) {
        problems.push(`review_id ${id} is about another vendor, not ${meal.vendorName}`);
      }
    }
    problems.push(...amountProblems(p.reason, `reason for ${p.mealId}`, input));
    if (!p.reviewIds?.length) {
      for (const w of claimWords(p.reason, `${input.userText} ${meal?.name ?? ""}`)) {
        problems.push(`reason for ${p.mealId} says "${w}" without review_ids; cite a review of this dish or drop the claim`);
      }
    }
  }
  problems.push(...amountProblems(input.message, "message", input));
  for (const w of claimWords(input.message, input.userText)) {
    problems.push(`message says "${w}", a claim only reviews can back; put it in a pick's reason with review_ids or drop it`);
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}

// Words that state what a dish is like. Only reviews can back them. Words the user typed
// ("something filling") or that are in the dish name ("Spicy Rice") are allowed.
const CLAIM_WORDS = [
  "tasty", "delicious", "yummy", "flavourful", "flavorful", "filling", "hearty", "generous", "satisfying",
  "popular", "favourite", "favorite", "loved", "best", "oily", "greasy", "bland", "fresh", "crispy", "juicy",
];

export function claimWords(text: string, allowedText: string): string[] {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  const allowed = new Set(allowedText.toLowerCase().split(/[^a-z]+/));
  return CLAIM_WORDS.filter((w) => words.has(w) && !allowed.has(w));
}

function amountProblems(text: string, where: string, input: GroundingInput): string[] {
  const allowed = new Set<number>(extractAmounts(input.userText));
  for (const m of input.seen.values()) allowed.add(Math.round(m.priceKobo / 100));
  return extractAmounts(text)
    .filter((n) => !allowed.has(n))
    .map((n) => `${where} mentions ${n}, which is not a catalogue price or a number the user gave; remove it`);
}
