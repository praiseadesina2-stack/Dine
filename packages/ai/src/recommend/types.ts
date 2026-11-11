/**
 * The contract between the bot (backend) and the recommender.
 * The bot collects these from button taps; only `note` is free text.
 * Use the exported value lists as the button callback codes so both sides agree.
 */
import type { Allergen } from "./knowledge.js";
import type { Allergen, Prep } from "./knowledge.js";

/** Cooking methods a student can ask to avoid ("no fried food"). */
export const AVOIDABLE_PREPS = ["fried", "grilled", "roasted", "baked", "boiled"] as const satisfies readonly Prep[];
export type AvoidablePrep = (typeof AVOIDABLE_PREPS)[number];

export const GOALS = ["protein_rich", "high_fibre", "healthy", "light", "bulk"] as const;
export type Goal = (typeof GOALS)[number];

export const CRAVINGS = ["sweet", "filling", "spicy", "savoury", "snack", "surprise"] as const;
export type Craving = (typeof CRAVINGS)[number];

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export type MealSlot = "breakfast" | "lunch" | "dinner";

/** Prime (Dine ordering) only sells in the evening. Lagos local hours, [from, to). */
export const DEFAULT_PRIME_HOURS = { from: 16, to: 24 };
/** Which meals a timetable day covers, by meals per day. */
export const SLOTS_FOR: Record<1 | 2 | 3, MealSlot[]> = {
  1: ["dinner"],
  2: ["lunch", "dinner"],
  3: ["breakfast", "lunch", "dinner"],
};

export interface RecommendRequest {
  mode: "now" | "timetable";
  /** Timetable only. */
  days?: Day[];
  /** Timetable only; default 3. */
  mealsPerDay?: 1 | 2 | 3;
  goals?: Goal[];
  cravings?: Craving[];
  /** Budget for one meal, whole naira. */
  budgetPerMeal: number;
  /** The optional "anything else?" text. */
  note?: string;
  /** Meal keys already shown, so "show me others" returns new picks. */
  excludeMealKeys?: string[];
  /** Changes "surprise" picks between rerolls. */
  seed?: number;
}

/** What the free-text note was understood to mean. */
export interface NoteConstraints {
  excludeAllergens: Allergen[];
  /** Component ids from knowledge.ts. */
  excludeComponents: string[];
  excludeVendors: string[];
  /** Cooking methods to avoid: any meal with a component cooked this way is excluded. */
  excludePrep: AvoidablePrep[];
  preferComponents: string[];
  preferVendors: string[];
  vegetarian: boolean;
  noPork: boolean;
  maxHeat?: number;
  minHeat?: number;
  /** Parts of the note that could not be applied; worth telling the user. */
  unhandled: string[];
  parsedBy: "none" | "rules" | "model";
}

export const EMPTY_NOTE: NoteConstraints = {
  excludeAllergens: [], excludeComponents: [], excludeVendors: [], preferComponents: [], preferVendors: [],
  excludeAllergens: [], excludeComponents: [], excludeVendors: [], excludePrep: [], preferComponents: [], preferVendors: [],
  vegetarian: false, noPork: false, unhandled: [], parsedBy: "none",
};

export interface MealSuggestion {
  /** Stable id for this meal; pass back in excludeMealKeys to reroll. */
  key: string;
  /** Short title, e.g. "Rice and beans" or "Shawarma + 2 Sausages". */
  name: string;
  /** True only for Prime meals, which can be ordered through Dine. */
  orderable: boolean;
  /** Present only when orderable; campus meals carry no label at all. */
  orderLabel?: "Order on Dine";
  /** Orderable meals only: the Prime vendor to add the items from. */
  vendorId?: string;
  vendorName?: string;
  location?: "inside_cafeteria" | "outside_cafeteria";
  /**
   * Orderable meals: the exact Prime cart items, each with its price.
   * Campus meals: just what's on the plate (e.g. "Rice and beans", "Fish", "Dodo"),
   * with no quantities or prices; the student buys as much as their budget allows.
   */
  items: { name: string; price?: number }[];
  /** Orderable meals only. */
  totalPrice?: number;
  /** Short lines tied to what the user asked for. */
  reasons: string[];
  /** Rough estimates for ranking; label them as estimates if shown. */
  estimates: { proteinG: number; fibreG: number; kcal: number; heat: number; confidence: "high" | "medium" | "low" };
  /** Allergens in typical recipes, and similar cautions. */
  warnings: string[];
}

export interface TimetableMeal {
  slot: MealSlot;
  pick: MealSuggestion | null;
  /** Up to 2 swaps for this slot. */
  alternatives: MealSuggestion[];
}

export interface RecommendResultBase {
  note: NoteConstraints;
  /** Things the user should know (limits of the menu, unread parts of the note). */
  notices: string[];
  /** When the menu and prices were captured. */
  menuAsOf: string;
}

export type RecommendResult =
  | (RecommendResultBase & { mode: "now"; options: MealSuggestion[] })
  | (RecommendResultBase & { mode: "timetable"; days: { day: Day; meals: TimetableMeal[] }[] });
