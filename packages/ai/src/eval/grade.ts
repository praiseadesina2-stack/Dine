/**
 * Deterministic grading for /find eval cases. No model judges another model here:
 * every check is a rule over the agent's structured result and the catalogue.
 */
import type { MealRecord } from "../find/catalogue.js";
import { extractAmounts } from "../find/grounding.js";
import type { FindResult } from "../find/find-agent.js";

export interface CaseExpect {
  /** Expect a grounded answer (not a fallback). Omit for cases where a fallback is also acceptable. */
  ok?: boolean;
  minPicks?: number;
  maxPicks?: number;
  /** Every pick costs at most this. */
  maxPriceNaira?: number;
  /** At least one pick is from one of these vendors. */
  anyVendor?: string[];
  /** No pick is from these vendors. */
  forbidVendors?: string[];
  /** Regex (case-insensitive): at least one pick name matches. */
  anyName?: string;
  /** Regex: every pick name matches. */
  allNames?: string;
  /** Regex: no pick name matches. */
  forbidNames?: string;
  /** Regex: the message must not match. */
  messageMustNot?: string;
}

export interface EvalCase {
  id: string;
  query: string;
  tags: string[];
  expect: CaseExpect;
}

export interface Grade {
  pass: boolean;
  failures: string[];
  /** Price or meal claims in the shipped answer that the catalogue does not back. Must be 0. */
  unsupportedClaims: string[];
}

const re = (s: string) => new RegExp(s, "i");

export function gradeCase(c: EvalCase, result: FindResult, catalogue: Map<string, MealRecord>): Grade {
  const failures: string[] = [];
  const unsupportedClaims: string[] = [];
  const e = c.expect;

  if (!result.ok) {
    // An infrastructure failure means the case was never tested: never count it as a pass.
    if (result.reason === "model_error" || result.reason === "not_configured" || result.reason === "timeout") {
      return { pass: false, failures: [`not tested: no model answer (${result.reason}${result.detail ? `: ${result.detail.slice(0, 80)}` : ""})`], unsupportedClaims };
    }
    // A fallback never ships model text, so it can't make unsupported claims.
    if (e.ok) failures.push(`fell back (${result.reason}${result.detail ? `: ${result.detail.slice(0, 120)}` : ""})`);
    const pass = failures.length === 0 && (e.minPicks ?? 0) === 0;
    if (!pass && failures.length === 0) failures.push(`fell back (${result.reason}) but picks were expected`);
    return { pass, failures, unsupportedClaims };
  }

  const picks = result.picks;
  const names = picks.map((p) => p.meal.name);

  // Independent grounding re-check: every pick is a real catalogue meal at the stored price,
  // and every amount in the message is a catalogue price or a number the user typed.
  const allowed = new Set<number>(extractAmounts(c.query));
  for (const m of catalogue.values()) allowed.add(Math.round(m.priceKobo / 100));
  for (const p of picks) {
    const stored = catalogue.get(p.meal.mealId);
    if (!stored) unsupportedClaims.push(`pick ${p.meal.mealId} is not in the catalogue`);
    else if (stored.priceKobo !== p.meal.priceKobo) unsupportedClaims.push(`pick ${p.meal.mealId} price differs from catalogue`);
    for (const r of p.reviews) if (r.vendorId !== p.meal.vendorId) unsupportedClaims.push(`review ${r.reviewId} cited for another vendor`);
  }
  for (const text of [result.message, ...picks.map((p) => p.reason)]) {
    for (const n of extractAmounts(text)) if (!allowed.has(n)) unsupportedClaims.push(`amount ${n} in "${text.slice(0, 60)}"`);
  }

  if (e.minPicks != null && picks.length < e.minPicks) failures.push(`expected at least ${e.minPicks} picks, got ${picks.length}`);
  if (e.maxPicks != null && picks.length > e.maxPicks) failures.push(`expected at most ${e.maxPicks} picks, got ${picks.length}`);
  if (e.maxPriceNaira != null) {
    for (const p of picks) {
      const naira = p.meal.priceKobo / 100;
      if (naira > e.maxPriceNaira) failures.push(`${p.meal.name} costs ${naira}, over ${e.maxPriceNaira}`);
    }
  }
  if (e.anyVendor && picks.length && !picks.some((p) => e.anyVendor!.includes(p.meal.vendorId))) {
    failures.push(`no pick from ${e.anyVendor.join("/")}; got ${picks.map((p) => p.meal.vendorId).join(", ")}`);
  }
  for (const p of picks) {
    if (e.forbidVendors?.includes(p.meal.vendorId)) failures.push(`picked forbidden vendor ${p.meal.vendorId}`);
  }
  if (e.anyName && picks.length && !names.some((n) => re(e.anyName!).test(n))) failures.push(`no pick name matches /${e.anyName}/: ${names.join(", ")}`);
  if (e.allNames) for (const n of names) if (!re(e.allNames).test(n)) failures.push(`"${n}" does not match /${e.allNames}/`);
  if (e.forbidNames) for (const n of names) if (re(e.forbidNames).test(n)) failures.push(`"${n}" matches forbidden /${e.forbidNames}/`);
  if (e.messageMustNot && re(e.messageMustNot).test(result.message)) failures.push(`message matches forbidden /${e.messageMustNot}/`);

  for (const u of unsupportedClaims) failures.push(`unsupported claim: ${u}`);
  return { pass: failures.length === 0, failures, unsupportedClaims };
}
