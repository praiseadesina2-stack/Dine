/**
 * Build Context/derived/reviews.json from the "Food review" sheet exports.
 *   pnpm --filter @dine/ai context:ingest
 *
 * Put these CSVs in Context/ (Google Sheets: File > Download > CSV, one per tab):
 *   *Dim_Vendors*.csv, *Dim_FoodItems*.csv, *Fact_Reviews*.csv
 * Optional: Context/vendor-map.json fixes what alias matching gets wrong:
 *   { "vendors": { "V005": [] },                          survey vendor -> catalogue ids ([] = unlink)
 *     "reviews": { "REV-014": ["pizza_republic_633"] } }   one review -> catalogue ids (wins over "vendors")
 */
import fs from "fs";
import path from "path";
import { VENDORS as BOT_VENDORS } from "../../../../apps/api/src/data/vendors.js";
import { primeSourceVendors } from "../find/prime-catalogue.js";
import { buildReviews } from "./ingest.js";
import { CONTEXT_DIR, DERIVED_DIR, REVIEWS_FILE, type DerivedReviews } from "./sources.js";

function findCsv(tab: string): string {
  const files = fs.existsSync(CONTEXT_DIR) ? fs.readdirSync(CONTEXT_DIR) : [];
  const match = files.find((f) => f.toLowerCase().endsWith(".csv") && f.toLowerCase().includes(tab.toLowerCase()));
  if (!match) {
    console.error(`No CSV for "${tab}" in ${CONTEXT_DIR}. Export that sheet tab as CSV into the Context folder.`);
    process.exit(1);
  }
  return path.join(CONTEXT_DIR, match);
}

const vendorsPath = findCsv("Dim_Vendors");
const foodsPath = findCsv("Dim_FoodItems");
const reviewsPath = findCsv("Fact_Reviews");
const mapPath = path.join(CONTEXT_DIR, "vendor-map.json");
const vendorMap: { vendors?: Record<string, string[]>; reviews?: Record<string, string[]> } = fs.existsSync(mapPath)
  ? JSON.parse(fs.readFileSync(mapPath, "utf8"))
  : {};
// Same vendor set the find agent uses, so review vendor ids always match catalogue ids.
const VENDORS = primeSourceVendors({ extraVendors: BOT_VENDORS });
const catalogueIds = new Set(VENDORS.map((v) => v.id));
for (const [key, ids] of Object.entries({ ...vendorMap.vendors, ...vendorMap.reviews })) {
  const bad = ids.filter((id) => !catalogueIds.has(id));
  if (bad.length) {
    console.error(`vendor-map.json: ${key} -> unknown catalogue vendor id(s) ${bad.join(", ")}`);
    process.exit(1);
  }
}

const { reviews, report } = buildReviews({
  vendorsCsv: fs.readFileSync(vendorsPath, "utf8"),
  foodItemsCsv: fs.readFileSync(foodsPath, "utf8"),
  reviewsCsv: fs.readFileSync(reviewsPath, "utf8"),
  reviewsFile: path.basename(reviewsPath),
  catalogueVendors: VENDORS.map((v) => ({ id: v.id, name: v.name })),
  overrides: vendorMap.vendors,
  reviewOverrides: vendorMap.reviews,
});

if (report.missingColumns.length) {
  console.error(`Missing columns: ${report.missingColumns.join(", ")}. Check the CSV headers.`);
  process.exit(1);
}

fs.mkdirSync(DERIVED_DIR, { recursive: true });
const out: DerivedReviews = {
  generatedAt: new Date().toISOString(),
  sources: [vendorsPath, foodsPath, reviewsPath].map((p) => path.basename(p)),
  reviews,
};
fs.writeFileSync(REVIEWS_FILE, JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(DERIVED_DIR, "ingest-report.json"), JSON.stringify(report, null, 2));

const linked = reviews.filter((r) => r.vendorId).length;
const copied = reviews.length - new Set(reviews.map((r) => r.source.reviewId)).size;
console.log(
  `Reviews: ${report.reviewsIn} in, ${report.dropped.length} dropped, ${report.reviewsOut} records written` +
    `${copied ? ` (${copied} extra from copying reviews to each vendor)` : ""}, ${linked} on catalogue vendors.`,
);
for (const v of report.unmatchedVendors) {
  const why = vendorMap.vendors?.[v.surveyVendorId] ? "unlinked in vendor-map.json" : "not in catalogue";
  const rescued = reviews.filter((r) => r.surveyVendorId === v.surveyVendorId && r.vendorId).length;
  console.log(`  ${why}: ${v.surveyVendorId} ${v.name}${rescued ? ` (${rescued} review(s) assigned individually)` : ""}`);
}
for (const v of report.ambiguousVendors) {
  console.log(`  ambiguous: ${v.surveyVendorId} ${v.name} -> ${v.vendorIds.join(", ")}; copied to each (confirm in vendor-map.json)`);
}
if (report.vendorFoodMismatches.length) {
  console.log(`  ${report.vendorFoodMismatches.length} reviews name a food item from a different vendor (see ingest-report.json)`);
}
console.log(`Wrote ${REVIEWS_FILE}`);
