/**
 * Where the AI's data comes from. Raw files live in <repo>/Context (local
 * only, gitignored); ingest writes cleaned, provenance-tagged JSON to
 * <repo>/Context/derived, and the runtime only ever reads the derived files.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { InMemoryReviewStore, type ReviewRecord } from "./reviews.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONTEXT_DIR = process.env.DINE_CONTEXT_DIR || path.resolve(__dirname, "../../../../Context");
export const DERIVED_DIR = path.join(CONTEXT_DIR, "derived");
export const REVIEWS_FILE = path.join(DERIVED_DIR, "reviews.json");

export interface DerivedReviews {
  generatedAt: string;
  sources: string[];
  reviews: ReviewRecord[];
}

/** Loads the review store, or null if ingest has not been run yet. */
export function loadReviewStore(file = REVIEWS_FILE): InMemoryReviewStore | null {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as DerivedReviews;
  return new InMemoryReviewStore(data.reviews);
}
