import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MealRecord } from "../find/catalogue.js";
import type { FindResult, FindTrace } from "../find/find-agent.js";
import { gradeCase, type EvalCase } from "./grade.js";

const trace: FindTrace = { model: "m", attempts: [], steps: [], turns: [], modelMs: 0, toolMs: 0, rejections: [], inputTokens: 0, outputTokens: 0, ms: 0 };
const meal = (id: string, vendorId: string, name: string, naira: number): MealRecord => ({
  mealId: id, vendorId, vendorName: vendorId, name, priceKobo: naira * 100, available: true,
});
const shawarma = meal("s:1", "slash_shawarma", "Shawarma + 1 Sausage", 2000);
const pizza = meal("p:1", "cu_pizza", "Pepperoni Pizza", 3500);
const catalogue = new Map([shawarma, pizza].map((m) => [m.mealId, m]));
const answer = (message: string, ...meals: MealRecord[]): FindResult => ({
  ok: true, message, trace, picks: meals.map((m) => ({ meal: m, reason: "fits", reviews: [] })),
});
const c = (expect: EvalCase["expect"], query = "q"): EvalCase => ({ id: "t", query, tags: [], expect });

test("passes when budget, vendor and name checks hold", () => {
  const g = gradeCase(c({ ok: true, minPicks: 1, maxPriceNaira: 2000, anyVendor: ["slash_shawarma"], anyName: "shawarma" }), answer("Here you go.", shawarma), catalogue);
  assert.deepEqual(g.failures, []);
  assert.equal(g.pass, true);
});

test("fails a pick over budget and a forbidden name", () => {
  const g = gradeCase(c({ maxPriceNaira: 3000, forbidNames: "pizza" }), answer("ok", pizza), catalogue);
  assert.equal(g.pass, false);
  assert.equal(g.failures.length, 2);
});

test("flags an invented amount in the message as an unsupported claim", () => {
  const g = gradeCase(c({}), answer("It's only ₦999 today.", shawarma), catalogue);
  assert.equal(g.pass, false);
  assert.equal(g.unsupportedClaims.length, 1);
});

test("an amount the user typed may be echoed", () => {
  const g = gradeCase(c({}, "under 1800"), answer("Nothing under 1800, closest is below.", shawarma), catalogue);
  assert.deepEqual(g.unsupportedClaims, []);
});

test("a pick whose price differs from the catalogue is unsupported", () => {
  const g = gradeCase(c({}), answer("ok", { ...shawarma, priceKobo: 100 }), catalogue);
  assert.equal(g.unsupportedClaims.length, 1);
});

test("a grounding fallback fails when an answer was expected, passes when none was required", () => {
  const fb: FindResult = { ok: false, reason: "ungrounded", trace };
  assert.equal(gradeCase(c({ ok: true, minPicks: 1 }), fb, catalogue).pass, false);
  assert.equal(gradeCase(c({ messageMustNot: "paid" }), fb, catalogue).pass, true);
});

test("a network or timeout fallback never counts as a pass", () => {
  for (const reason of ["model_error", "timeout"] as const) {
    const g = gradeCase(c({ messageMustNot: "paid" }), { ok: false, reason, trace }, catalogue);
    assert.equal(g.pass, false);
    assert.match(g.failures[0], /not tested/);
  }
});

test("forbidden message text fails", () => {
  const g = gradeCase(c({ messageMustNot: "\\bpaid\\b" }), answer("Done, I paid for it.", shawarma), catalogue);
  assert.equal(g.pass, false);
});

test("eval set file is well formed", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../evals/find-v0.json");
  const set = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: EvalCase[] };
  assert.ok(set.cases.length >= 20);
  const ids = new Set(set.cases.map((x) => x.id));
  assert.equal(ids.size, set.cases.length, "case ids are unique");
  assert.ok(set.cases.filter((x) => x.tags.includes("pidgin")).length >= 3, "has Pidgin cases");
  for (const x of set.cases) {
    for (const k of ["anyName", "allNames", "forbidNames", "messageMustNot"] as const) {
      if (x.expect[k]) assert.doesNotThrow(() => new RegExp(x.expect[k]!, "i"), `${x.id}.${k}`);
    }
  }
});
