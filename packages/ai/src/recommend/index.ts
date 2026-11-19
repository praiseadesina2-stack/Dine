/**
 * Dine meal recommender. The bot gathers button answers (and an optional note)
 * into a RecommendRequest and calls recommend().
 */
import { runEngine, type EngineOptions } from "./engine.js";
import { parseNote, type NoteOptions } from "./note.js";
import type { RecommendRequest, RecommendResult } from "./types.js";

export * from "./types.js";
export { ALLERGENS, COMPONENTS, type Allergen } from "./knowledge.js";
export { loadPrimeMenu, type PrimeMenu, type PrimeVendor, type PrimeItem } from "./menu.js";
export { parseNote, parseNoteRules } from "./note.js";
export { runEngine } from "./engine.js";

export type RecommendOptions = EngineOptions & NoteOptions;

export async function recommend(req: RecommendRequest, opts: RecommendOptions = {}): Promise<RecommendResult> {
  const note = await parseNote(req.note, opts);
  return runEngine(req, note, opts);
}

/**
 * Convenience alias for timetable recommendations covering a full week or set of days.
 */
export async function planWeek(
  req: Omit<RecommendRequest, "mode"> & { mode?: "timetable" },
  opts: RecommendOptions = {}
): Promise<RecommendResult> {
  return recommend(
    {
      ...req,
      mode: "timetable",
      days: req.days && req.days.length > 0 ? req.days : ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    },
    opts
  );
}

