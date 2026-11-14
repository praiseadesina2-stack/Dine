/**
 * The weekly-plan conversation, AI side, no model involved:
 *
 *   button answers (+ optional note) ─▶ profileFromButtons() ─▶ PreferenceProfile
 *   PreferenceProfile ─▶ planWeek() ─▶ PlanResult ─▶ formatPlanMessage()  + PLAN_BUTTONS
 *   "Approve" ─▶ consentMessage() + CONSENT_BUTTONS ─▶ backend stores approval and ONE consent record
 *
 * The backend owns the keyboards, callbacks and records (contracts/tools.md
 * request_user_confirmation, contracts/ordering.md); this file only builds the
 * profile and the texts, so wording stays in one place and can be tested.
 */
import type { Catalogue } from "../find/catalogue.js";
import { parseNoteRules } from "../recommend/note.js";
import { DAYS, type Craving, type Day, type Goal } from "../recommend/types.js";
import { validateProfile, type PlanResult, type PreferenceProfile } from "./planner.js";

// ---------------------------------------------------------------- buttons → profile

/** What the bot collects for a plan: the same buttons as the recommender's timetable mode. */
export interface PlanButtons {
  days: Day[];
  goals?: Goal[];
  cravings?: Craving[];
  /** Per-dinner budget in whole naira (the preset the student tapped). */
  budgetPerMeal: number;
  /** The optional "anything else?" text. */
  note?: string;
}

export type ProfileResult = { ok: true; profile: PreferenceProfile; unread: string[] } | { ok: false; problems: string[] };

const SPICE_FROM_HEAT = (maxHeat?: number, minHeat?: number): PreferenceProfile["spice_level"] =>
  minHeat != null && minHeat >= 2 ? "hot" : maxHeat == null ? "any" : maxHeat <= 0 ? "none" : maxHeat <= 1 ? "mild" : "medium";

/**
 * Button answers to a PreferenceProfile. Hard exclusions in the note ("allergic to
 * groundnut", "no pork", "nothing fried", "not spicy") become profile fields, so the
 * backend stores them explicitly; the note itself is kept as `dietary_notes`.
 * `unread` lists parts of the note that could not be applied, to tell the student.
 */
export function profileFromButtons(b: PlanButtons): ProfileResult {
  const note = b.note?.trim() ?? "";
  const parsed = note ? parseNoteRules(note) : null;
  const profile: PreferenceProfile = {
    version: 1,
    budget_per_dinner_kobo: Math.round(b.budgetPerMeal) * 100,
    dinner_days: DAYS.filter((d) => b.days.includes(d)),
    ...(b.goals?.length ? { goals: [...new Set(b.goals)] } : {}),
    ...(b.cravings?.length ? { cravings: [...new Set(b.cravings)] } : {}),
    ...(parsed?.excludeAllergens.length ? { avoid_ingredients: parsed.excludeAllergens } : {}),
    ...(parsed?.excludePrep.length ? { avoid_preps: parsed.excludePrep } : {}),
    ...(parsed?.vegetarian ? { vegetarian: true } : {}),
    ...(parsed?.noPork ? { no_pork: true } : {}),
    ...(parsed && (parsed.maxHeat != null || parsed.minHeat != null) ? { spice_level: SPICE_FROM_HEAT(parsed.maxHeat, parsed.minHeat) } : {}),
    ...(note ? { dietary_notes: note.slice(0, 200) } : {}),
  };
  const problems = validateProfile(profile);
  if (problems.length) return { ok: false, problems };
  return { ok: true, profile, unread: parsed?.unhandled ?? [] };
}

// ---------------------------------------------------------------- plan message

export const DAY_NAMES: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

/** "16 Nov" for a YYYY-MM-DD date. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** Buttons under the plan (request_user_confirmation type approve_plan, contracts/tools.md). */
export const PLAN_BUTTONS = ["✅ Approve all", "📅 Choose days", "Not now"] as const;

/**
 * The plan as the student sees it. Prices come from the catalogue rows (the stored
 * price), never from the plan's text; the backend re-prices again in propose_plan.
 * Plain text, safe for Telegram without parse_mode.
 */
export async function formatPlanMessage(result: PlanResult, catalogue: Catalogue): Promise<string> {
  if (!result.proposal) {
    return ["I couldn't build a dinner plan with these choices.", ...result.notices].join("\n\n");
  }
  const { week_start, items } = result.proposal;
  const lines = [`🗓️ Your dinner plan for the week of ${shortDate(week_start)}`, ""];
  let total = 0;
  for (const it of items) {
    const meal = await catalogue.getMeal(it.meal_id);
    if (!meal) continue;
    total += meal.priceKobo;
    lines.push(`${DAY_NAMES[it.day]}: ${meal.name} (${meal.vendorName}) - ${naira(meal.priceKobo)}`);
    lines.push(`   ${it.reason}`);
    for (const c of result.cautions[it.day] ?? []) lines.push(`   ⚠️ ${c}`);
  }
  lines.push("", `Total for ${items.length} dinner${items.length === 1 ? "" : "s"}: ${naira(total)} (some vendors add a pack fee)`);
  if (result.notices.length) lines.push("", ...result.notices.map((n) => `ℹ️ ${n}`));
  lines.push("", "Nothing is ordered or paid until you approve.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- consent

/** Stored with the consent record, so the exact wording a student agreed to can be shown later. */
export const CONSENT_TEXT_VERSION = "plan-consent-v1";

/** contracts/policy.md `price_tolerance_pct` (an assumption until both engineers agree). Keep in step with the policy service. */
export const PRICE_TOLERANCE_PCT = 10;

/** Buttons under the consent message. */
export const CONSENT_BUTTONS = ["✅ Yes, order for me", "No, I'll order myself"] as const;

/**
 * Asked once per plan, after "Approve all" or "Choose days" (contracts/ordering.md):
 * one consent covers every approved day of that week. `totalKobo` is the plan total
 * for those days, from the catalogue.
 */
export function consentMessage(days: Day[], weekStart: string, totalKobo: number): string {
  const ordered = DAYS.filter((d) => days.includes(d));
  const which = ordered.length === 7 ? "every day this week" : ordered.map((d) => DAY_NAMES[d]).join(", ");
  return [
    `Should Dine order these dinners for you? (week of ${shortDate(weekStart)})`,
    "",
    `Days: ${which}`,
    `About ${naira(totalKobo)} in total at today's prices, paid from your Dine wallet, plus any pack fee the vendor adds.`,
    "",
    "• Dine orders each day's dinner on Prime and pays from your wallet.",
    `• If a dinner's price goes up by more than ${PRICE_TOLERANCE_PCT}%, Dine asks you before ordering it.`,
    "• If your wallet is short on a day, that dinner is skipped and you're told.",
    "• You can pause or cancel any day before it's ordered.",
    "",
    "This covers only the days above, for this week. Next week's plan asks again.",
  ].join("\n");
}
