import assert from "node:assert/strict";
import { test } from "node:test";
import { primeCatalogue } from "../find/prime-catalogue.js";
import { loadPrimeMenu } from "../recommend/menu.js";
import { parseItem, profileOf } from "../recommend/profile.js";
import {
  nextMonday, planWeek, profileToConstraints, validatePlanProposal, validateProfile,
  type PlanProposal, type PreferenceProfile,
} from "./planner.js";

const menu = loadPrimeMenu();
const catalogue = primeCatalogue({ menu });
const WEEK = "2026-11-16";
const base: PreferenceProfile = { version: 1, budget_per_dinner_kobo: 300_000, dinner_days: ["mon", "tue", "wed", "thu", "fri"] };
const plan = (p: Partial<PreferenceProfile> = {}, seed?: number) => planWeek({ ...base, ...p }, WEEK, { catalogue, menu, seed });

/** Nutrition and allergen profile of a planned meal, from the same rules the engine uses. */
async function profileOfPick(mealId: string) {
  const meal = (await catalogue.getMeal(mealId))!;
  const parsed = parseItem(meal.vendorName, meal.name, meal.priceKobo / 100);
  return profileOf(parsed.parts, parsed.minHeat);
}

test("a plan has one catalogue meal per dinner day, within budget, and matches the schema", async () => {
  const r = await plan();
  assert.ok(r.proposal);
  assert.deepEqual(r.proposal.items.map((i) => i.day), ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual(validatePlanProposal(r.proposal), []);
  for (const it of r.proposal.items) {
    const meal = await catalogue.getMeal(it.meal_id);
    assert.ok(meal, `${it.meal_id} is in the catalogue`);
    assert.equal(it.quoted_price_kobo, meal.priceKobo);
    assert.ok(it.quoted_price_kobo <= base.budget_per_dinner_kobo);
  }
});

test("plans vary across the week", async () => {
  const r = await plan();
  assert.ok(new Set(r.proposal!.items.map((i) => i.meal_id)).size >= 3);
});

test("reasons never carry prices", async () => {
  const r = await plan({ goals: ["protein_rich"], cravings: ["filling"] });
  for (const it of r.proposal!.items) {
    assert.doesNotMatch(it.reason, /₦|\d{3,}/, it.reason);
    assert.ok(it.reason.length <= 140);
  }
});

test("avoided ingredients never appear", async () => {
  for (const avoid of [["egg"], ["dairy", "gluten"], ["fish"]] as const) {
    const r = await plan({ avoid_ingredients: [...avoid], budget_per_dinner_kobo: 500_000 });
    for (const it of r.proposal?.items ?? []) {
      const p = await profileOfPick(it.meal_id);
      for (const a of avoid) assert.ok(!p.allergens.has(a), `${it.meal_id} contains ${a}`);
    }
  }
});

test("vegetarian, no pork and avoided preps are enforced", async () => {
  const veg = await plan({ vegetarian: true, budget_per_dinner_kobo: 500_000 });
  for (const it of veg.proposal?.items ?? []) {
    const p = await profileOfPick(it.meal_id);
    assert.ok(!p.meat && !p.fish, `${it.meal_id} has meat or fish`);
  }
  const r = await plan({ no_pork: true, avoid_preps: ["fried"], budget_per_dinner_kobo: 500_000 });
  for (const it of r.proposal?.items ?? []) {
    const p = await profileOfPick(it.meal_id);
    assert.ok(!p.porkPossible, `${it.meal_id} may have pork`);
    assert.ok(!p.preps.has("fried"), `${it.meal_id} is fried`);
  }
});

test("a disliked vendor is never planned", async () => {
  const counts = new Map<string, number>();
  for (const it of (await plan()).proposal!.items) {
    const v = (await catalogue.getMeal(it.meal_id))!.vendorId;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const name = menu.vendors.find((v) => v.id === top)!.name;
  const r = await plan({ dislikes: [name] });
  for (const it of r.proposal?.items ?? []) assert.notEqual((await catalogue.getMeal(it.meal_id))!.vendorId, top);
});

test("a budget too small for any dinner gives no proposal and says so", async () => {
  const r = await plan({ budget_per_dinner_kobo: 50_000 });
  const cheapest = Math.min(...(await catalogue.listVendors()).map((v) => v.cheapestKobo ?? Infinity));
  if (cheapest > 50_000) {
    assert.equal(r.proposal, null);
    assert.deepEqual(r.unfilled, base.dinner_days);
    assert.ok(r.notices.some((n) => /No dinner fits/.test(n)));
  } else {
    for (const it of r.proposal?.items ?? []) assert.ok(it.quoted_price_kobo <= 50_000);
    if (new Set(r.proposal!.items.map((i) => i.meal_id)).size <= 2) assert.ok(r.notices.some((n) => /some repeat/.test(n)));
  }
});

test("profile constraints: spice level, likes and dislikes", () => {
  assert.equal(profileToConstraints({ ...base, spice_level: "none" }, menu).maxHeat, 0);
  assert.equal(profileToConstraints({ ...base, spice_level: "hot" }, menu).minHeat, 2);
  const c = profileToConstraints({ ...base, likes: ["chicken"], dislikes: ["chicken", "egg"] }, menu);
  assert.ok(c.excludeComponents.includes("chicken"));
  assert.ok(!c.preferComponents.includes("chicken"), "a food both liked and disliked is avoided");
  assert.ok(profileToConstraints({ ...base, dietary_notes: "I'm allergic to groundnut" }, menu).excludeAllergens.includes("groundnut"));
});

test("nextMonday is the Monday on or after today, Lagos time", () => {
  assert.equal(nextMonday(new Date("2026-11-14T12:00:00Z")), "2026-11-16"); // Saturday
  assert.equal(nextMonday(new Date("2026-11-16T08:00:00Z")), "2026-11-16"); // Monday
  assert.equal(nextMonday(new Date("2026-11-15T23:30:00Z")), "2026-11-16"); // Sunday 23:30 UTC is Monday 00:30 in Lagos
});

test("profile validation", async () => {
  assert.deepEqual(validateProfile(base), []);
  assert.ok(validateProfile({ ...base, budget_per_dinner_kobo: 100 }).length);
  assert.ok(validateProfile({ ...base, dinner_days: ["mon", "mon"] }).length);
  assert.ok(validateProfile({ ...base, avoid_ingredients: ["peanut"] }).length);
  assert.ok(validateProfile({ ...base, health_condition: "x" }).length, "unknown fields are rejected");
  await assert.rejects(planWeek({ ...base, version: 2 } as never, WEEK, { catalogue, menu }));
});

test("proposal validation", () => {
  const ok: PlanProposal = { week_start: WEEK, items: [{ day: "mon", meal_id: "x:y", quoted_price_kobo: 150_000, reason: "Filling" }] };
  assert.deepEqual(validatePlanProposal(ok), []);
  assert.ok(validatePlanProposal({ ...ok, items: [...ok.items, ...ok.items] }).length, "repeated day");
  assert.ok(validatePlanProposal({ ...ok, items: [{ ...ok.items[0], quoted_price_kobo: 1500.5 }] }).length);
  assert.ok(validatePlanProposal({ ...ok, week_start: "16/11/2026" }).length);
  assert.ok(validatePlanProposal({ ...ok, items: [] }).length);
});
