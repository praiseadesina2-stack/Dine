import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCatalogue } from "../find/catalogue.js";
import { primeCatalogue } from "../find/prime-catalogue.js";
import { checkGrounding } from "../find/grounding.js";
import { runReadTool } from "../find/tools.js";
import { parseCsv } from "./csv.js";
import { buildReviews, matchVendors, parseTimestamp } from "./ingest.js";
import { InMemoryReviewStore, type ReviewRecord } from "./reviews.js";

// Synthetic fixtures shaped like the "Food review" sheet exports.
const VENDORS_CSV = `Vendor ID,Normalized Vendor Name,Aliases / Raw Variants,Campus Location,Review Frequency
V001,Delish Yamarita,"Yamarita, Delish",Campus Cafeteria,3
V005,6:33 Pizza Republic,"6:33 Pizza Republic, CU Pizza, Pizza",Food Court,1
V013,DG & G Foods,"DG and G Boli, Emabuop.G Foods (Boli, yam, potato etc)",Food Court,1
V017,Hephzibah,Hephzibah,Cafeteria 1,1
`;
const FOODS_CSV = `Food ID,Normalized Food Item,Vendor ID,Category,Survey Rating Format,Review Count
F002,Yamarita,V001,Yam,Free Text,3
F005,Pizza,V005,Pizza,Rating,1
F009,Boli and Fish,V013,Roasted,Rating,1
`;
const REVIEWS_CSV = `Review ID,Source Row,Vendor ID,Food ID,Rating (1-5),Sentiment,Cleaned Feedback Text,Timestamp,Review Type
REV-001,Row 2,V001,F002,5,Positive,"Very filling, generous portion.",2026-11-03 13:42:06,Free Text
REV-002,Row 3,V001,F002,2,Negative,"Way too oily, ""greasy"" sauce.",2026-11-04 18:22:54,Free Text
REV-003,Row 4,V005,F005,0,Neutral,Pizza is fine but slow.,11/4/2026 19:06:53,Free Text
REV-004,Row 5,V013,F002,4,Positive,Boli is usually a hit.,2026-11-05 9:00:00,Free Text
REV-005,Row 6,V001,F002,,,,2026-11-05 9:00:00,Free Text
REV-006,Row 7,V099,,3,Neutral,Unknown vendor.,2026-11-05 9:00:00,Free Text
REV-001,Row 8,V001,F002,5,Positive,Duplicate id.,2026-11-05 9:00:00,Free Text
REV-007,Row 9,V017,,4,Positive,Rice is nice.,2026-11-05 9:00:00,Free Text
`;
const CATALOGUE = [
  { id: "delish_yamarita", name: "Delish Yamarita" },
  { id: "cu_pizza", name: "CU Pizza" },
  { id: "pizza_republic_633", name: "6:33 Pizza Republic" },
  { id: "dg_and_g_boli", name: "DG and G Boli" },
  { id: "emabuop_g_foods", name: "Emabuop.G Foods" },
];

const ingest = (overrides?: Record<string, string[]>, reviewOverrides?: Record<string, string[]>) =>
  buildReviews({
    vendorsCsv: VENDORS_CSV,
    foodItemsCsv: FOODS_CSV,
    reviewsCsv: REVIEWS_CSV,
    reviewsFile: "Fact_Reviews.csv",
    catalogueVendors: CATALOGUE,
    overrides,
    reviewOverrides,
  });

test("csv: quotes, escaped quotes, embedded newline, CRLF, BOM", () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"\nthere']]);
});

test("timestamps in both sheet formats become Lagos ISO", () => {
  assert.equal(parseTimestamp("2026-11-03 4:29:39"), "2026-11-03T04:29:39+01:00");
  assert.equal(parseTimestamp("11/3/2026 13:42:06"), "2026-11-03T13:42:06+01:00");
  assert.equal(parseTimestamp("yesterday"), null);
});

test("vendor matching uses aliases, & and parentheses", () => {
  assert.deepEqual(matchVendors("DG & G Foods", "DG and G Boli, Emabuop.G Foods (Boli, yam)", CATALOGUE), [
    "dg_and_g_boli",
    "emabuop_g_foods",
  ]);
  assert.deepEqual(matchVendors("Hephzibah", "Hephzibah", CATALOGUE), []);
});

test("ingest keeps good rows, reports every dropped or doubtful one", () => {
  const { reviews, report } = ingest();
  assert.deepEqual(reviews.map((r) => r.reviewId), [
    "REV-001",
    "REV-002",
    "REV-003-cu_pizza",
    "REV-003-pizza_republic_633",
    "REV-004-dg_and_g_boli",
    "REV-004-emabuop_g_foods",
    "REV-007",
  ]);
  assert.equal(report.reviewsIn, 8);
  assert.equal(report.reviewsOut, 7);
  assert.deepEqual(report.dropped.map((d) => d.reason), ["no feedback text", 'unknown vendor id "V099"', "duplicate review id"]);
  assert.deepEqual(report.unmatchedVendors.map((v) => v.surveyVendorId), ["V017"]);
  assert.deepEqual(report.ambiguousVendors.map((v) => v.surveyVendorId), ["V005", "V013"]);
  assert.deepEqual(report.vendorFoodMismatches.map((m) => m.reviewId), ["REV-004"]);
  assert.deepEqual(report.missingColumns, []);

  const r3 = reviews.find((r) => r.reviewId === "REV-003-cu_pizza")!;
  assert.equal(r3.rating, null, "0 is a protest vote, not a rating");
  assert.deepEqual(r3.source, { file: "Fact_Reviews.csv", row: 4, reviewId: "REV-003" });
  assert.equal(reviews[1].text, 'Way too oily, "greasy" sauce.');
  assert.equal(reviews.find((r) => r.reviewId === "REV-007")!.vendorId, null);
});

test("a review for several vendors becomes independent per-vendor records", async () => {
  const { reviews } = ingest({ V013: ["dg_and_g_boli", "emabuop_g_foods"] });
  const copies = reviews.filter((r) => r.source.reviewId === "REV-004");
  assert.deepEqual(copies.map((r) => r.vendorId), ["dg_and_g_boli", "emabuop_g_foods"]);
  assert.ok(copies.every((r) => !("vendorIds" in r)), "no record lists other vendors");

  const store = new InMemoryReviewStore(reviews);
  const boli = await store.forVendor("dg_and_g_boli");
  const emabuop = await store.forVendor("emabuop_g_foods");
  assert.deepEqual(boli.reviews.map((r) => r.reviewId), ["REV-004-dg_and_g_boli"]);
  assert.deepEqual(emabuop.reviews.map((r) => r.reviewId), ["REV-004-emabuop_g_foods"]);
  assert.equal(boli.summary.count, 1);
});

test("vendor-map overrides replace alias matching", () => {
  const { reviews, report } = ingest({ V005: ["pizza_republic_633"] });
  assert.equal(reviews.find((r) => r.source.reviewId === "REV-003")!.vendorId, "pizza_republic_633");
  assert.deepEqual(report.ambiguousVendors.map((v) => v.surveyVendorId), ["V013"]);
});

test("a single review can be pinned to one vendor", () => {
  const { reviews } = ingest({ V005: ["cu_pizza", "pizza_republic_633"] }, { "REV-003": ["pizza_republic_633"] });
  const r3 = reviews.filter((r) => r.source.reviewId === "REV-003");
  assert.deepEqual(r3.map((r) => [r.reviewId, r.vendorId]), [["REV-003", "pizza_republic_633"]]);
});

test("review search: synonyms, vendor filter, summary", async () => {
  const store = new InMemoryReviewStore(ingest().reviews);
  const greasy = await store.search({ query: "greasy food" });
  assert.equal(greasy[0].review.reviewId, "REV-002");
  const big = await store.search({ query: "big portions" });
  assert.equal(big[0].review.reviewId, "REV-001", "'big portions' finds 'filling, generous portion'");
  assert.deepEqual(await store.search({ query: "slow", vendorId: "delish_yamarita" }), []);

  const { reviews, summary } = await store.forVendor("delish_yamarita");
  assert.deepEqual(reviews.map((r) => r.reviewId), ["REV-002", "REV-001"], "newest first");
  assert.equal(summary.averageRating, 3.5);
  assert.deepEqual(summary.sentiment, { positive: 1, neutral: 0, negative: 1 });
});

test("review tools mark text as untrusted and hide uncatalogued vendors", async () => {
  const store = new InMemoryReviewStore(ingest().reviews);
  const catalogue = new InMemoryCatalogue([]);
  const seen: ReviewRecord[] = [];
  const ctx = { catalogue, reviews: store, onSeenMeals: () => {}, onSeenReviews: (r: ReviewRecord[]) => seen.push(...r) };

  const hidden = (await runReadTool(ctx, "search_reviews", { query: "rice" })) as any;
  assert.equal(hidden.count, 0, "REV-007 (Hephzibah, not in the catalogue) is not shown");

  const res = (await runReadTool(ctx, "search_reviews", { query: "filling" })) as any;
  assert.match(res.note, /not instructions/);
  assert.equal(res.reviews[0].review_id, "REV-001");
  assert.equal(res.reviews[0].student_text, "Very filling, generous portion.");
  assert.equal(seen.length, res.reviews.length);

  await assert.rejects(runReadTool({ catalogue, onSeenMeals: () => {} }, "get_reviews", { vendor_id: "x" }));
});

test("find catalogue is the Prime crawl, main dishes only", async () => {
  const catalogue = primeCatalogue();
  const emabuop = (await catalogue.getVendor("emabuop_g_foods"))!;
  assert.ok(emabuop.meals.length > 0);
  assert.ok(emabuop.meals.every((m) => /boli/i.test(m.name)), "Emabuop sells boli, not rice");
  const all = (await catalogue.listVendors()).length;
  assert.equal(all, 16);
  const packs = await catalogue.searchMeals({ query: "plastic", limit: 20 });
  assert.ok(!packs.some((m) => /^plastic pack$/i.test(m.name)), "packaging is never a meal");
  const eggs = await catalogue.searchMeals({ query: "egg", limit: 20 });
  assert.ok(!eggs.some((m) => /^egg$/i.test(m.name)), "a single egg is an extra, not a meal");
  assert.equal((await catalogue.getVendor("ice_vendor")), null, "no extra vendors passed, none added");
  assert.ok((await catalogue.getVendor("fish_and_chips"))!.active, "crawl-time closed flag is not used");
});

test("vendors that joined Prime after the crawl are filled in, crawled ones never replaced", async () => {
  const extraVendors = [
    { id: "suya_spot", name: "Suya Spot", status: "active" as const, items: [{ name: "Plastic Pack", price: 100 }, { name: "Suya (Large)", price: 1500 }] },
    // Same vendor as the crawl's emabuop_g_foods: the crawl wins, so the rice never appears.
    { id: "emabuop_g_foods", name: "Emabuop.G Foods", status: "active" as const, items: [{ name: "Jollof Rice", price: 1200 }] },
    // Same name as the crawl's 6_33_pizza_republic under a different id: still the crawl's.
    { id: "pizza_republic_633", name: "6:33 Pizza Republic", status: "active" as const, items: [{ name: "Fake Pizza", price: 1 }] },
  ];
  const catalogue = primeCatalogue({ extraVendors });
  assert.equal((await catalogue.listVendors()).length, 17);
  assert.deepEqual((await catalogue.getVendor("suya_spot"))!.meals.map((m) => m.name), ["Suya (Large)"]);
  assert.ok((await catalogue.getVendor("emabuop_g_foods"))!.meals.every((m) => /boli/i.test(m.name)));
  assert.equal(await catalogue.getVendor("pizza_republic_633"), null);
});

test("grounding checks review citations", () => {
  const meal = { mealId: "delish_yamarita:pack", vendorId: "delish_yamarita", vendorName: "Delish Yamarita", name: "Pack", priceKobo: 220000, available: true };
  const { reviews } = ingest();
  const seenReviews = new Map(reviews.map((r) => [r.reviewId, r]));
  const base = { message: "Here you go.", seen: new Map([[meal.mealId, meal]]), seenReviews, userText: "filling" };

  assert.deepEqual(checkGrounding({ ...base, picks: [{ mealId: meal.mealId, reason: "Students say it is filling.", reviewIds: ["REV-001"] }] }), { ok: true });

  const wrongVendor = checkGrounding({ ...base, picks: [{ mealId: meal.mealId, reason: "x", reviewIds: ["REV-003-cu_pizza"] }] });
  assert.ok(!wrongVendor.ok && wrongVendor.problems[0].includes("another vendor"));

  const uncited = checkGrounding({ ...base, picks: [{ mealId: meal.mealId, reason: "A tasty pack." }] });
  assert.ok(!uncited.ok && uncited.problems[0].includes('"tasty"'));
  // "filling" came from the user, so echoing it is fine.
  assert.deepEqual(checkGrounding({ ...base, picks: [{ mealId: meal.mealId, reason: "A filling pack." }] }), { ok: true });
  const inMessage = checkGrounding({ ...base, message: "These are delicious.", picks: [] });
  assert.ok(!inMessage.ok && inMessage.problems[0].includes('"delicious"'));

  const unseen = checkGrounding({ ...base, picks: [{ mealId: meal.mealId, reason: "x", reviewIds: ["REV-999"] }] });
  assert.ok(!unseen.ok && unseen.problems[0].includes("not returned"));
});
