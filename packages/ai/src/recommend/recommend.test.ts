import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPUS_TEMPLATES, unitPrices } from "./campus.js";
import { runEngine, type EngineOptions } from "./engine.js";
import { COMPONENTS } from "./knowledge.js";
import { loadPrimeMenu } from "./menu.js";
import { parseNoteRules } from "./note.js";
import { parseItem } from "./profile.js";
import { EMPTY_NOTE, type MealSuggestion, type NoteConstraints, type RecommendRequest } from "./types.js";

const menu = loadPrimeMenu();
const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00+01:00`);
const LUNCH = at("13:00"), EVENING = at("19:30"), MORNING = at("08:00");
const note = (n: Partial<NoteConstraints> = {}): NoteConstraints => ({ ...structuredClone(EMPTY_NOTE), ...n });
const now = (r: Partial<RecommendRequest>, n = note(), opts: EngineOptions = {}) => {
  const res = runEngine({ mode: "now", budgetPerMeal: 2500, ...r }, n, { menu, now: EVENING, ...opts });
  assert.equal(res.mode, "now");
  return res.mode === "now" ? res : (null as never);
};
const timetable = (r: Partial<RecommendRequest>, n = note()) => {
  const res = runEngine({ mode: "timetable", days: ["mon", "tue", "wed"], mealsPerDay: 3, budgetPerMeal: 2500, ...r }, n, { menu });
  assert.equal(res.mode, "timetable");
  return res.mode === "timetable" ? res : (null as never);
};
const primePrice = (vendorId: string, name: string) => menu.vendors.find((v) => v.id === vendorId)!.items.find((i) => i.name === name)?.price;
const label = (o: MealSuggestion) => `${o.name}: ${o.items.map((i) => i.name).join(" + ")}`;

test("every Prime item is understood", () => {
  for (const v of menu.vendors) for (const i of v.items) assert.notEqual(parseItem(v.name, i.name, i.price).role, "unknown", `${v.name}: ${i.name}`);
});

test("every campus template uses known foods with a price", () => {
  const prices = unitPrices(menu);
  for (const t of CAMPUS_TEMPLATES) for (const u of t.parts) {
    assert.ok(COMPONENTS[u.component], `${t.id}: ${u.component}`);
    assert.ok(prices[u.component] > 0, `${t.id}: no price for ${u.component}`);
  }
});

test("shared foods take Prime's price; akara is ₦100", () => {
  const p = unitPrices(menu);
  assert.equal(p.akara, 100);
  assert.equal(p.beef, 200);
  assert.equal(p.egg, 300);
  assert.equal(p.plantain_fried, 200);
});

test("only Prime meals are labelled orderable; campus meals carry no label or vendor", () => {
  for (const o of now({ goals: ["protein_rich"] }).options) {
    if (o.orderable) {
      assert.equal(o.orderLabel, "Order on Dine");
      assert.ok(o.vendorId && o.vendorName);
      for (const i of o.items) assert.equal(i.price, primePrice(o.vendorId!, i.name), `${o.vendorName}: ${i.name}`);
    } else {
      assert.equal(o.orderLabel, undefined);
      assert.equal(o.vendorId, undefined);
      assert.equal(o.vendorName, undefined);
      assert.equal(o.totalPrice, undefined);
      assert.ok(o.items.every((i) => i.price === undefined), "campus items carry no price or quantity");
      assert.ok(!/\d/.test(o.name), o.name);
    }
  }
});

test("Prime meals stay within the per-meal budget and totals add up", () => {
  for (const budget of [800, 1500, 2500, 4000]) {
    for (const o of now({ budgetPerMeal: budget, goals: ["protein_rich"] }).options.filter((x) => x.orderable)) {
      assert.ok(o.totalPrice! <= budget, label(o));
      assert.equal(o.totalPrice, o.items.reduce((s, i) => s + i.price!, 0));
    }
  }
});

test("campus meals are sized to the budget (a bigger budget means more food)", () => {
  const kcal = (budget: number) => {
    // Exclude every other campus meal so rice and beans is the one returned (no Prime at lunch).
    const others = CAMPUS_TEMPLATES.filter((t) => t.id !== "rice_beans").map((t) => `campus|${t.id}`);
    const o = now({ budgetPerMeal: budget, cravings: ["filling"], excludeMealKeys: others }, note(), { now: LUNCH }).options.find((x) => x.key === "campus|rice_beans");
    return o?.estimates.kcal ?? 0;
  };
  assert.ok(kcal(3000) > kcal(1200) && kcal(1200) > 0);
});

test("Prime is never suggested outside its evening hours", () => {
  for (const time of [MORNING, LUNCH]) assert.ok(now({ goals: ["protein_rich"] }, note(), { now: time }).options.every((o) => !o.orderable));
});

test("in the evening a suitable Prime meal is included", () => {
  const opts = now({ budgetPerMeal: 3000, goals: ["protein_rich"] }).options;
  assert.ok(opts.some((o) => o.orderable));
});

test("an unsuitable Prime meal is not forced in", () => {
  // Vegetarian and dairy-free leaves Prime with only boli and chips, far behind beans and moi moi for protein.
  const opts = now({ budgetPerMeal: 2500, goals: ["protein_rich"] }, note({ vegetarian: true, excludeAllergens: ["dairy"] })).options;
  assert.ok(opts.length > 0 && opts.every((o) => !o.orderable), opts.map(label).join(" | "));
});

test("live vendor status overrides the crawl snapshot", () => {
  const opts = now({ budgetPerMeal: 3000, goals: ["protein_rich"] }, note(), { isVendorOpen: (id) => id === "slash_shawarma" }).options;
  for (const o of opts.filter((x) => x.orderable)) assert.equal(o.vendorId, "slash_shawarma");
});

test("sweet craving returns sweet food, morning and evening", () => {
  for (const time of [MORNING, EVENING])
    for (const o of now({ budgetPerMeal: 1500, cravings: ["sweet"] }, note(), { now: time }).options) assert.ok(o.reasons.includes("Sweet"), label(o));
});

test("protein goal ranks protein above a sweet craving", () => {
  const avg = (os: MealSuggestion[]) => os.reduce((s, o) => s + o.estimates.proteinG, 0) / os.length;
  assert.ok(avg(now({ goals: ["protein_rich"] }).options) > avg(now({ cravings: ["sweet"] }).options));
});

test("allergen and food exclusions are hard filters for both kinds of meal", () => {
  const res = now({ budgetPerMeal: 4000, goals: ["protein_rich"] }, note({ excludeAllergens: ["groundnut", "egg", "fish"], excludeComponents: ["sausage", "beef"] }));
  assert.ok(res.options.length > 0);
  for (const o of res.options) {
    assert.ok(!o.warnings.join(" ").match(/groundnut|egg|fish/), label(o));
    assert.ok(!o.items.some((i) => /sausage|beef|fish|egg/i.test(i.name)), label(o));
  }
});

test("mild note excludes hot food", () => {
  for (const o of now({ cravings: ["filling"] }, note({ maxHeat: 1 })).options) assert.ok(o.estimates.heat <= 1, label(o));
});

test("rerolling with excludeMealKeys gives new picks", () => {
  const first = now({ goals: ["protein_rich"] }).options;
  const second = now({ goals: ["protein_rich"], excludeMealKeys: first.map((o) => o.key) }).options;
  for (const o of second) assert.ok(!first.some((f) => f.key === o.key));
});

test("impossible budget returns no options and says why", () => {
  const res = now({ budgetPerMeal: 50 });
  assert.equal(res.options.length, 0);
  assert.ok(res.notices.some((n) => n.includes("Nothing fits")));
});

test("timetable: days x slots, no repeats, Prime only at dinner", () => {
  const res = timetable({ goals: ["protein_rich"] });
  assert.deepEqual(res.days.map((d) => d.day), ["mon", "tue", "wed"]);
  const picks = res.days.flatMap((d) => d.meals.map((m) => m.pick!));
  assert.equal(picks.length, 9);
  assert.equal(new Set(picks.map((p) => p.key)).size, 9, "no meal repeats");
  for (const d of res.days) {
    assert.deepEqual(d.meals.map((m) => m.slot), ["breakfast", "lunch", "dinner"]);
    for (const m of d.meals.filter((x) => x.slot !== "dinner")) {
      assert.ok(!m.pick!.orderable && m.alternatives.every((a) => !a.orderable), `${d.day} ${m.slot}`);
    }
  }
  assert.ok(res.days.some((d) => d.meals.find((m) => m.slot === "dinner")!.pick!.orderable), "a suitable Prime dinner is used");
});

test("meals per day maps to slots", () => {
  for (const [n, slots] of [[1, ["dinner"]], [2, ["lunch", "dinner"]]] as const) {
    const res = timetable({ days: ["fri"], mealsPerDay: n, budgetPerMeal: 2000 });
    assert.deepEqual(res.days[0].meals.map((m) => m.slot), slots);
  }
});

test("note keyword reader", () => {
  const n = parseNoteRules("I'm allergic to groundnut. No sausage please, not too spicy, and I love chicken. Deliver by 7pm", menu);
  assert.deepEqual(n.excludeAllergens, ["groundnut"]);
  assert.ok(n.excludeComponents.includes("sausage"));
  assert.equal(n.maxHeat, 1);
  assert.ok(n.preferComponents.includes("chicken"));
  assert.deepEqual(n.unhandled, ["deliver by 7pm"]);
  assert.equal(parseNoteRules("nothing else, thanks", menu).unhandled.length, 0);
  assert.ok(parseNoteRules("I'm muslim so no pork", menu).noPork);
  assert.ok(parseNoteRules("not slash shawarma", menu).excludeVendors.includes("slash_shawarma"));
  const nothingFrom = parseNoteRules("nothing from Slash Shawarma", menu);
  assert.ok(nothingFrom.excludeVendors.includes("slash_shawarma") && !nothingFrom.preferVendors.length);
  assert.deepEqual(parseNoteRules("I'd like fish", menu).preferComponents.sort(), ["fish", "fish_roasted"]);
  assert.ok(parseNoteRules("no amala please", menu).excludeComponents.includes("amala"));
});
