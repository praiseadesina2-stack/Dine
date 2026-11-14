/**
 * Plan conversation helpers, and the planner eval over every demo persona
 * (demo/personas.json). Deterministic: no model, no quota.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { primeCatalogue } from "../find/prime-catalogue.js";
import { loadPrimeMenu } from "../recommend/menu.js";
import { parseItem, profileOf } from "../recommend/profile.js";
import { consentMessage, formatPlanMessage, profileFromButtons } from "./flow.js";
import { planWeek, validatePlanProposal, type PreferenceProfile } from "./planner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { personas } = JSON.parse(fs.readFileSync(path.join(here, "../../demo/personas.json"), "utf8")) as {
  personas: { id: string; profile: PreferenceProfile }[];
};
const menu = loadPrimeMenu();
const catalogue = primeCatalogue({ menu });
const WEEK = "2026-11-16";

test("buttons to profile: budget in kobo, days in week order, note exclusions become fields", () => {
  const r = profileFromButtons({
    days: ["fri", "mon"],
    goals: ["protein_rich"],
    cravings: ["spicy", "spicy"],
    budgetPerMeal: 2500,
    note: "allergic to groundnut, no pork, nothing fried, deliver by 7pm",
  });
  assert.ok(r.ok);
  assert.equal(r.profile.budget_per_dinner_kobo, 250_000);
  assert.deepEqual(r.profile.dinner_days, ["mon", "fri"]);
  assert.deepEqual(r.profile.cravings, ["spicy"]);
  assert.deepEqual(r.profile.avoid_ingredients, ["groundnut"]);
  assert.equal(r.profile.no_pork, true);
  assert.deepEqual(r.profile.avoid_preps, ["fried"]);
  assert.equal(r.profile.dietary_notes, "allergic to groundnut, no pork, nothing fried, deliver by 7pm");
  assert.ok(r.unread.some((u) => /7pm/.test(u)), "parts the rules can't apply are reported");
});

test("buttons to profile: spice from the note, and invalid input is refused", () => {
  const mild = profileFromButtons({ days: ["mon"], budgetPerMeal: 2000, note: "not spicy please" });
  assert.ok(mild.ok && mild.profile.spice_level === "mild");
  assert.ok(!profileFromButtons({ days: [], budgetPerMeal: 2000 }).ok, "at least one day");
  assert.ok(!profileFromButtons({ days: ["mon"], budgetPerMeal: 200 }).ok, "budget below ₦500");
});

test("plan message: prices from the catalogue, cautions under the day, nothing ordered until approval", async () => {
  const r = await planWeek(personas.find((p) => p.id === "tobi-allergy")!.profile, WEEK, { catalogue, menu });
  const text = await formatPlanMessage(r, catalogue);
  assert.match(text, /week of 16 Nov/);
  for (const it of r.proposal!.items) {
    const meal = (await catalogue.getMeal(it.meal_id))!;
    assert.ok(text.includes(`${meal.name} (${meal.vendorName}) - ₦${(meal.priceKobo / 100).toLocaleString("en-NG")}`));
  }
  assert.match(text, /Nothing is ordered or paid until you approve/);
  const empty = await formatPlanMessage(await planWeek({ version: 1, budget_per_dinner_kobo: 50_000, dinner_days: ["mon"], vegetarian: true, avoid_ingredients: ["gluten", "dairy", "egg"] }, WEEK, { catalogue, menu }), catalogue);
  assert.ok(/couldn't build|Mon:/.test(empty));
});

test("consent text: one consent for the chosen days of this week, policy behaviour stated", () => {
  const text = consentMessage(["fri", "mon", "wed"], WEEK, 750_000);
  assert.match(text, /Days: Mon, Wed, Fri/);
  assert.match(text, /₦7,500/);
  assert.match(text, /more than 10%/);
  assert.match(text, /skipped/);
  assert.match(text, /Next week's plan asks again/);
  assert.match(consentMessage(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], WEEK, 1), /every day this week/);
});

// ---------------------------------------------------------------- planner eval over the demo personas

for (const persona of personas) {
  test(`planner eval: ${persona.id}`, async () => {
    const p = persona.profile;
    const r = await planWeek(p, WEEK, { catalogue, menu });
    assert.ok(r.proposal, `${persona.id} gets a plan`);
    assert.deepEqual(validatePlanProposal(r.proposal), []);
    // Every dinner day is either planned or reported as unfilled.
    assert.deepEqual([...r.proposal.items.map((i) => i.day), ...r.unfilled].sort(), [...p.dinner_days].sort());
    for (const it of r.proposal.items) {
      const meal = (await catalogue.getMeal(it.meal_id))!;
      assert.ok(meal.priceKobo <= p.budget_per_dinner_kobo, `${meal.name} is within budget`);
      assert.doesNotMatch(it.reason, /₦|\d{3,}/, "no prices in reasons");
      const parsed = parseItem(meal.vendorName, meal.name, meal.priceKobo / 100);
      const prof = profileOf(parsed.parts, parsed.minHeat);
      for (const a of p.avoid_ingredients ?? []) assert.ok(!prof.allergens.has(a), `${meal.name} contains ${a}`);
      if (p.no_pork) assert.ok(!prof.porkPossible, `${meal.name} may contain pork`);
      if (p.vegetarian) assert.ok(!prof.meat && !prof.fish, `${meal.name} has meat or fish`);
    }
  });
}
