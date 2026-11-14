import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetFrom, keywordsFrom, preSearchArgs } from "./presearch.js";

test("budget: plain, comma, k, naira and pidgin forms", () => {
  assert.equal(budgetFrom("something filling under 2000"), 2000);
  assert.equal(budgetFrom("abeg I wan chop yam, no pass 2k"), 2000);
  assert.equal(budgetFrom("I get 2.5k"), 2500);
  assert.equal(budgetFrom("₦1,500 max"), 1500);
  assert.equal(budgetFrom("wetin dey for 1500?"), 1500);
  assert.equal(budgetFrom("I want shawarma"), undefined);
  assert.equal(budgetFrom("2 plates"), undefined, "small counts are not budgets");
});

test("keywords keep the food and drop filler, English and Pidgin", () => {
  assert.equal(keywordsFrom("I want shawarma"), "shawarma");
  assert.equal(keywordsFrom("chicken and chips"), "chicken chips");
  assert.equal(keywordsFrom("abeg I wan chop yam, no pass 2k"), "yam");
  assert.equal(keywordsFrom("I dey hungry, wetin I fit chop tonight wey no cost reach 2k"), "");
  assert.equal(keywordsFrom("pizza under 3000"), "pizza");
});

test("pre-search args", () => {
  assert.deepEqual(preSearchArgs("pizza under 3000"), { query: "pizza", max_price_naira: 3000, limit: 12 });
  assert.deepEqual(preSearchArgs("wetin dey for 1500?"), { max_price_naira: 1500, limit: 12 });
  assert.equal(preSearchArgs("hi"), null);
});
