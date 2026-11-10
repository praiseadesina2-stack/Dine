/**
 * Groundedness check (issue #12): reject any answer that names a meal the
 * tools did not return, or mentions a money amount that is neither a price the
 * tools returned nor a number the user typed.
 */
import type { MealRecord } from "./catalogue.js";

export interface ProposedPick {
  mealId: string;
  reason: string;
}

export interface GroundingInput {
  message: string;
  picks: ProposedPick[];
  /** Meals returned by tools in this conversation, keyed by mealId. */
  seen: Map<string, MealRecord>;
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
    problems.push(...amountProblems(p.reason, `reason for ${p.mealId}`, input));
  }
  problems.push(...amountProblems(input.message, "message", input));

  return problems.length ? { ok: false, problems } : { ok: true };
}

function amountProblems(text: string, where: string, input: GroundingInput): string[] {
  const allowed = new Set<number>(extractAmounts(input.userText));
  for (const m of input.seen.values()) allowed.add(Math.round(m.priceKobo / 100));
  return extractAmounts(text)
    .filter((n) => !allowed.has(n))
    .map((n) => `${where} mentions ${n}, which is not a catalogue price or a number the user gave; remove it`);
}
