/**
 * Turns the "Food review" sheet exports (Dim_Vendors, Dim_FoodItems,
 * Fact_Reviews as CSV) into ReviewRecords linked to Dine catalogue vendors.
 * Pure: takes file contents, returns records plus a report of everything that
 * was dropped or could not be matched, so nothing is lost silently.
 */
import { readTable } from "./csv.js";
import type { ReviewRecord, Sentiment } from "./reviews.js";

export interface CatalogueVendorRef {
  id: string;
  name: string;
}

export interface IngestInput {
  vendorsCsv: string;
  foodItemsCsv: string;
  reviewsCsv: string;
  /** File name recorded as each review's source. */
  reviewsFile: string;
  catalogueVendors: CatalogueVendorRef[];
  /** Survey vendor ID -> catalogue vendor ids; replaces alias matching for that vendor. */
  overrides?: Record<string, string[]>;
  /** Review ID -> catalogue vendor ids; wins over the vendor mapping, for survey vendors that merged several real ones. */
  reviewOverrides?: Record<string, string[]>;
}

export interface IngestReport {
  reviewsIn: number;
  /** Records written; higher than reviewsIn when a review is copied to several vendors. */
  reviewsOut: number;
  dropped: { reviewId: string; row: number; reason: string }[];
  /** Survey vendors with no catalogue match: their reviews are kept but no tool will surface them. */
  unmatchedVendors: { surveyVendorId: string; name: string }[];
  /** Survey vendors that matched more than one catalogue vendor. Confirm or override these. */
  ambiguousVendors: { surveyVendorId: string; name: string; vendorIds: string[] }[];
  /** Reviews whose food item belongs to a different vendor than the review row says. */
  vendorFoodMismatches: { reviewId: string; vendorId: string; foodId: string; foodVendorId: string }[];
  missingColumns: string[];
}

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

const SENTIMENTS: Sentiment[] = ["positive", "neutral", "negative"];

/** "2026-11-03 4:29:39" or "11/3/2026 4:29:39" (Lagos time) -> ISO, or null. */
export function parseTimestamp(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  let y: string, mo: string, d: string, h: string, mi: string, sec: string | undefined;
  if (m) [, y, mo, d, h, mi, sec] = m;
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    [, mo, d, y, h, mi, sec] = m;
  }
  const p = (v: string | undefined) => (v ?? "0").padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(sec)}+01:00`;
}

export function matchVendors(
  surveyName: string,
  aliases: string,
  catalogue: CatalogueVendorRef[],
): string[] {
  // Drop "(Boli, yam, potato etc)" notes before splitting, or their commas split one alias into several.
  const aliasList = aliases.replace(/\([^)]*\)/g, " ").split(",");
  const names = new Set([surveyName, ...aliasList].map(norm).filter(Boolean));
  return catalogue.filter((v) => names.has(norm(v.name))).map((v) => v.id);
}

export function buildReviews(input: IngestInput): { reviews: ReviewRecord[]; report: IngestReport } {
  const vendors = readTable(input.vendorsCsv, {
    id: ["vendor id"],
    name: ["normalized vendor name", "vendor name"],
    aliases: ["aliases"],
  });
  const foods = readTable(input.foodItemsCsv, {
    id: ["food id"],
    name: ["normalized food item", "food item"],
    vendorId: ["vendor id"],
  });
  const facts = readTable(input.reviewsCsv, {
    id: ["review id"],
    vendorId: ["vendor id"],
    foodId: ["food id"],
    rating: ["rating"],
    sentiment: ["sentiment"],
    text: ["cleaned feedback", "feedback"],
    timestamp: ["timestamp"],
    type: ["review type"],
  });

  const report: IngestReport = {
    reviewsIn: facts.records.length,
    reviewsOut: 0,
    dropped: [],
    unmatchedVendors: [],
    ambiguousVendors: [],
    vendorFoodMismatches: [],
    missingColumns: [
      ...vendors.missing.map((c) => `Dim_Vendors.${c}`),
      ...foods.missing.map((c) => `Dim_FoodItems.${c}`),
      ...facts.missing.map((c) => `Fact_Reviews.${c}`),
    ],
  };

  const vendorInfo = new Map<string, { name: string; vendorIds: string[] }>();
  for (const v of vendors.records) {
    if (!v.id) continue;
    const vendorIds = input.overrides?.[v.id] ?? matchVendors(v.name, v.aliases, input.catalogueVendors);
    vendorInfo.set(v.id, { name: v.name, vendorIds });
    if (vendorIds.length === 0) report.unmatchedVendors.push({ surveyVendorId: v.id, name: v.name });
    else if (vendorIds.length > 1 && !input.overrides?.[v.id]) {
      report.ambiguousVendors.push({ surveyVendorId: v.id, name: v.name, vendorIds });
    }
  }
  const foodInfo = new Map(foods.records.filter((f) => f.id).map((f) => [f.id, f]));

  const reviews: ReviewRecord[] = [];
  const seenIds = new Set<string>();
  for (const r of facts.records) {
    const drop = (reason: string) => report.dropped.push({ reviewId: r.id || "(none)", row: r._row, reason });
    if (!r.id) { drop("no review id"); continue; }
    if (seenIds.has(r.id)) { drop("duplicate review id"); continue; }
    if (!r.text) { drop("no feedback text"); continue; }
    const vendor = vendorInfo.get(r.vendorId);
    if (!vendor) { drop(`unknown vendor id "${r.vendorId}"`); continue; }
    seenIds.add(r.id);

    const food = r.foodId ? foodInfo.get(r.foodId) : undefined;
    if (food && food.vendorId && food.vendorId !== r.vendorId) {
      report.vendorFoodMismatches.push({ reviewId: r.id, vendorId: r.vendorId, foodId: r.foodId, foodVendorId: food.vendorId });
    }

    const ratingNum = Number(r.rating);
    const sentiment = r.sentiment.toLowerCase() as Sentiment;
    const base = {
      surveyVendorId: r.vendorId,
      surveyVendorName: vendor.name,
      foodId: r.foodId || null,
      foodName: food?.name || null,
      // The form allowed 0 as a protest vote (Audit EXC-004); only 1-5 counts as a rating.
      rating: r.rating !== "" && ratingNum >= 1 && ratingNum <= 5 ? ratingNum : null,
      sentiment: SENTIMENTS.includes(sentiment) ? sentiment : null,
      text: r.text.replace(/\s+/g, " ").slice(0, 500),
      reviewedAt: parseTimestamp(r.timestamp),
      reviewType: r.type || null,
      source: { file: input.reviewsFile, row: r._row, reviewId: r.id },
    };
    const targets = input.reviewOverrides?.[r.id] ?? vendor.vendorIds;
    if (targets.length === 0) reviews.push({ ...base, reviewId: r.id, vendorId: null });
    else if (targets.length === 1) reviews.push({ ...base, reviewId: r.id, vendorId: targets[0] });
    // One independent record per vendor; nothing ties the copies to each other.
    else for (const vendorId of targets) reviews.push({ ...base, reviewId: `${r.id}-${vendorId}`, vendorId });
  }
  report.reviewsOut = reviews.length;
  return { reviews, report };
}
