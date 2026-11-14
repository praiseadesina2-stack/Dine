/**
 * Weekly dinner planner (issue #15).
 *
 * The recommender engine picks the meals, not a model: it is the only code that
 * knows allergens, cooking methods and pork, so hard exclusions are enforced in
 * code. A plan is Prime mains only (one catalogue meal_id per day, no extras),
 * dinner only, one per dinner day, each within the per-dinner budget.
 *
 * The output is a PlanProposal (contracts/schemas/plan-proposal.schema.json):
 * the arguments of the backend's propose_plan endpoint, which re-prices every
 * item from the database and stores a draft. Nothing here orders or pays.
 */
import type { Catalogue, MealRecord } from "../find/catalogue.js";
import { runEngine, type EngineOptions } from "../recommend/engine.js";
import { ALLERGENS, type Allergen } from "../recommend/knowledge.js";
import { loadPrimeMenu, type PrimeMenu } from "../recommend/menu.js";
import { parseNoteRules } from "../recommend/note.js";
import {
  AVOIDABLE_PREPS, CRAVINGS, DAYS, EMPTY_NOTE, GOALS,
  type AvoidablePrep, type Craving, type Day, type Goal, type NoteConstraints,
} from "../recommend/types.js";

// ---------------------------------------------------------------- contract types

/** contracts/schemas/preference-profile.schema.json */
export interface PreferenceProfile {
  version: 1;
  budget_per_dinner_kobo: number;
  dinner_days: Day[];
  goals?: Goal[];
  cravings?: Craving[];
  likes?: string[];
  dislikes?: string[];
  avoid_ingredients?: Allergen[];
  avoid_preps?: AvoidablePrep[];
  vegetarian?: boolean;
  no_pork?: boolean;
  spice_level?: "none" | "mild" | "medium" | "hot" | "any";
  portion_preference?: "small" | "regular" | "large" | "any";
  dietary_notes?: string;
}

/** contracts/schemas/plan-proposal.schema.json */
export interface PlanProposal {
  week_start: string;
  items: { day: Day; meal_id: string; quoted_price_kobo: number; reason: string; reason_refs?: string[] }[];
  note?: string;
}

export interface PlanResult {
  /** null when not a single day could be filled. */
  proposal: PlanProposal | null;
  /** Days with no meal that fits the budget and preferences. */
  unfilled: Day[];
  /** Per-day allergen and pork cautions, for the bot to show under each item. */
  cautions: Partial<Record<Day, string[]>>;
  /** Things the student should know: parts of their profile that could not be applied, unfilled days. */
  notices: string[];
  /** When the menu the engine used was captured. */
  menuAsOf: string;
}

export interface PlanOptions {
  /** Catalogue the meal_ids come from; must be the one behind the read tools. */
  catalogue: Catalogue;
  menu?: PrimeMenu;
  /**
   * Vendor status for the planned week. Defaults to every vendor open: the crawl's
   * open/closed flag is a snapshot of one evening, not of next week.
   */
  isVendorOpen?: EngineOptions["isVendorOpen"];
  /** Changes picks between "show me another plan" requests. */
  seed?: number;
}

// ---------------------------------------------------------------- profile → engine input

const SPICE: Record<NonNullable<PreferenceProfile["spice_level"]>, Pick<NoteConstraints, "maxHeat" | "minHeat">> = {
  none: { maxHeat: 0 }, mild: { maxHeat: 1 }, medium: { maxHeat: 2 }, hot: { minHeat: 2 }, any: {},
};

/** Hard exclusions come from the profile's enums; likes, dislikes and notes go through the note reader. */
export function profileToConstraints(profile: PreferenceProfile, menu: PrimeMenu = loadPrimeMenu()): NoteConstraints {
  const out: NoteConstraints = { ...structuredClone(EMPTY_NOTE), parsedBy: "rules" };
  out.excludeAllergens.push(...(profile.avoid_ingredients ?? []));
  out.excludePrep.push(...(profile.avoid_preps ?? []));
  out.vegetarian = !!profile.vegetarian;
  out.noPork = !!profile.no_pork;
  Object.assign(out, SPICE[profile.spice_level ?? "any"]);

  const read = (text: string, as: "like" | "dislike" | "note") => {
    // One clause per entry, so "rice, beans" in a like stays two likes.
    const n = parseNoteRules(as === "dislike" ? `no ${text}` : text, menu);
    out.excludeAllergens.push(...n.excludeAllergens);
    out.excludeComponents.push(...n.excludeComponents);
    out.excludeVendors.push(...n.excludeVendors);
    out.excludePrep.push(...n.excludePrep);
    out.preferComponents.push(...n.preferComponents);
    out.preferVendors.push(...n.preferVendors);
    out.vegetarian ||= n.vegetarian;
    out.noPork ||= n.noPork;
    if (n.maxHeat != null) out.maxHeat = Math.min(out.maxHeat ?? n.maxHeat, n.maxHeat);
    if (n.minHeat != null && out.maxHeat == null) out.minHeat = n.minHeat;
    out.unhandled.push(...n.unhandled.map((u) => (as === "dislike" ? u.replace(/^no /, "") : u)));
  };
  for (const like of profile.likes ?? []) read(like, "like");
  for (const dislike of profile.dislikes ?? []) read(dislike, "dislike");
  if (profile.dietary_notes) read(profile.dietary_notes, "note");

  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  return {
    ...out,
    excludeAllergens: uniq(out.excludeAllergens), excludeComponents: uniq(out.excludeComponents),
    excludeVendors: uniq(out.excludeVendors), excludePrep: uniq(out.excludePrep),
    // A food both liked and disliked is avoided.
    preferComponents: uniq(out.preferComponents).filter((c) => !out.excludeComponents.includes(c)),
    preferVendors: uniq(out.preferVendors).filter((v) => !out.excludeVendors.includes(v)),
    unhandled: uniq(out.unhandled),
  };
}

// ---------------------------------------------------------------- planning

/** The Monday on or after `now`, in Lagos time (UTC+1, no daylight saving), as YYYY-MM-DD. */
export function nextMonday(now: Date = new Date()): string {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  const dow = lagos.getUTCDay(); // 0 = Sunday
  const add = (8 - dow) % 7;
  lagos.setUTCDate(lagos.getUTCDate() + add);
  return lagos.toISOString().slice(0, 10);
}

const REASON_MAX = 140;

function planReason(reasons: string[]): string {
  // The engine adds a "₦x of your ₦y budget" line; plans carry no prices (the bot shows the stored price).
  const kept = reasons.filter((r) => !/₦|\d{3,}/.test(r));
  let text = "";
  for (const r of kept) {
    const next = text ? `${text}; ${r.charAt(0).toLowerCase()}${r.slice(1)}` : r;
    if (next.length > REASON_MAX) break;
    text = next;
  }
  return text || "Fits your budget and preferences";
}

export async function planWeek(profile: PreferenceProfile, weekStart: string, opts: PlanOptions): Promise<PlanResult> {
  const problems = validateProfile(profile);
  if (problems.length) throw new Error(`invalid preference profile: ${problems.join("; ")}`);

  const menu = opts.menu ?? loadPrimeMenu();
  const constraints = profileToConstraints(profile, menu);
  const days = DAYS.filter((d) => profile.dinner_days.includes(d));
  const result = runEngine(
    {
      mode: "timetable",
      days,
      mealsPerDay: 1,
      goals: profile.goals,
      cravings: profile.cravings,
      budgetPerMeal: Math.floor(profile.budget_per_dinner_kobo / 100),
      seed: opts.seed,
    },
    constraints,
    { menu, isVendorOpen: opts.isVendorOpen ?? (() => true), primeOnly: true, maxExtras: 0 },
  );
  if (result.mode !== "timetable") throw new Error("engine returned the wrong mode");

  const items: PlanProposal["items"] = [];
  const unfilled: Day[] = [];
  const cautions: PlanResult["cautions"] = {};
  for (const { day, meals } of result.days) {
    const pick = meals[0]?.pick;
    const meal = pick?.orderable && pick.vendorId ? await findMeal(opts.catalogue, pick.vendorId, pick.items[0]?.name) : null;
    // Fail closed: an engine pick the catalogue does not know (or with a different price) is not planned.
    if (!pick || !meal || pick.items.length !== 1 || meal.priceKobo !== Math.round((pick.totalPrice ?? 0) * 100)) {
      unfilled.push(day);
      continue;
    }
    items.push({ day, meal_id: meal.mealId, quoted_price_kobo: meal.priceKobo, reason: planReason(pick.reasons), reason_refs: [] });
    if (pick.warnings.length) cautions[day] = pick.warnings;
  }

  const notices = result.notices.filter((n) => !/could not be filled/.test(n));
  if (unfilled.length) {
    notices.push(`No dinner fits your budget and preferences on ${unfilled.join(", ")}. Try a higher budget or fewer restrictions.`);
  }
  const distinct = new Set(items.map((i) => i.meal_id)).size;
  if (items.length >= 3 && distinct <= items.length / 2) {
    notices.push("Only a few dinners fit your budget and preferences, so some repeat. A higher budget or fewer restrictions gives more variety.");
  }
  if (profile.portion_preference && profile.portion_preference !== "any") {
    notices.push("Portion size isn't used for planning yet.");
  }

  const proposal: PlanProposal | null = items.length ? { week_start: weekStart, items } : null;
  if (proposal) {
    const bad = validatePlanProposal(proposal);
    if (bad.length) throw new Error(`planner built an invalid proposal: ${bad.join("; ")}`);
  }
  return { proposal, unfilled, cautions, notices, menuAsOf: result.menuAsOf };
}

async function findMeal(catalogue: Catalogue, vendorId: string, name: string | undefined): Promise<MealRecord | null> {
  if (!name) return null;
  const vendor = await catalogue.getVendor(vendorId);
  return vendor?.meals.find((m) => m.name === name && m.available) ?? null;
}

// ---------------------------------------------------------------- validation (mirrors the JSON Schemas)

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isStrList = (v: unknown, max: number, maxLen: number) =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length >= 1 && s.length <= maxLen);
const isEnumSet = (v: unknown, allowed: readonly string[]) =>
  Array.isArray(v) && new Set(v).size === v.length && v.every((x) => allowed.includes(x));

const PROFILE_KEYS = new Set([
  "version", "budget_per_dinner_kobo", "dinner_days", "goals", "cravings", "likes", "dislikes", "avoid_ingredients",
  "avoid_preps", "vegetarian", "no_pork", "spice_level", "portion_preference", "dietary_notes",
]);

/** Problems with a PreferenceProfile, as preference-profile.schema.json defines it; empty when valid. */
export function validateProfile(p: unknown): string[] {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["profile must be an object"];
  const o = p as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!PROFILE_KEYS.has(k)) out.push(`unknown field ${k}`);
  if (o.version !== 1) out.push("version must be 1");
  const b = o.budget_per_dinner_kobo;
  if (!Number.isInteger(b) || (b as number) < 50_000 || (b as number) > 2_000_000) out.push("budget_per_dinner_kobo must be an integer from 50000 to 2000000");
  if (!isEnumSet(o.dinner_days, DAYS) || !(o.dinner_days as unknown[]).length) out.push("dinner_days must be 1 to 7 distinct day codes");
  if (o.goals != null && !isEnumSet(o.goals, GOALS)) out.push("goals has an unknown or repeated value");
  if (o.cravings != null && !isEnumSet(o.cravings, CRAVINGS)) out.push("cravings has an unknown or repeated value");
  if (o.likes != null && !isStrList(o.likes, 10, 40)) out.push("likes must be at most 10 strings of 1 to 40 characters");
  if (o.dislikes != null && !isStrList(o.dislikes, 10, 40)) out.push("dislikes must be at most 10 strings of 1 to 40 characters");
  if (o.avoid_ingredients != null && !isEnumSet(o.avoid_ingredients, ALLERGENS)) out.push("avoid_ingredients has an unknown or repeated value");
  if (o.avoid_preps != null && !isEnumSet(o.avoid_preps, AVOIDABLE_PREPS)) out.push("avoid_preps has an unknown or repeated value");
  for (const k of ["vegetarian", "no_pork"]) if (o[k] != null && typeof o[k] !== "boolean") out.push(`${k} must be a boolean`);
  if (o.spice_level != null && !["none", "mild", "medium", "hot", "any"].includes(o.spice_level as string)) out.push("spice_level is not allowed");
  if (o.portion_preference != null && !["small", "regular", "large", "any"].includes(o.portion_preference as string)) out.push("portion_preference is not allowed");
  if (o.dietary_notes != null && (typeof o.dietary_notes !== "string" || o.dietary_notes.length > 200)) out.push("dietary_notes must be a string of at most 200 characters");
  return out;
}

/** Problems with a PlanProposal, as plan-proposal.schema.json defines it; empty when valid. */
export function validatePlanProposal(p: unknown): string[] {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["proposal must be an object"];
  const o = p as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!["week_start", "items", "note"].includes(k)) out.push(`unknown field ${k}`);
  if (typeof o.week_start !== "string" || !DATE.test(o.week_start)) out.push("week_start must be YYYY-MM-DD");
  if (o.note != null && (typeof o.note !== "string" || o.note.length > 280)) out.push("note must be at most 280 characters");
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 7) return [...out, "items must have 1 to 7 entries"];
  const days = new Set<string>();
  o.items.forEach((it: any, i: number) => {
    const at = `items[${i}]`;
    if (!it || typeof it !== "object") return out.push(`${at} must be an object`);
    for (const k of Object.keys(it)) if (!["day", "meal_id", "quoted_price_kobo", "reason", "reason_refs"].includes(k)) out.push(`${at} unknown field ${k}`);
    if (!DAYS.includes(it.day)) out.push(`${at}.day is not a day code`);
    else if (days.has(it.day)) out.push(`${at}.day ${it.day} is repeated`);
    days.add(it.day);
    if (typeof it.meal_id !== "string" || !it.meal_id || it.meal_id.length > 128) out.push(`${at}.meal_id must be 1 to 128 characters`);
    if (!Number.isInteger(it.quoted_price_kobo) || it.quoted_price_kobo < 1) out.push(`${at}.quoted_price_kobo must be a positive integer`);
    if (typeof it.reason !== "string" || !it.reason || it.reason.length > 140) out.push(`${at}.reason must be 1 to 140 characters`);
    if (it.reason_refs != null && (!isStrList(it.reason_refs, 3, 128) || new Set(it.reason_refs).size !== it.reason_refs.length)) {
      out.push(`${at}.reason_refs must be at most 3 distinct ids`);
    }
  });
  return out;
}
