import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCatalogue } from "./catalogue.js";
import { FindAgent, formatFindResult } from "./find-agent.js";

const catalogue = new InMemoryCatalogue([
  {
    id: "slash", name: "Slash Shawarma", status: "active",
    items: [{ name: "Shawarma (Regular)", price: 2000 }, { name: "Jumbo Shawarma", price: 3500 }],
  },
  { id: "closed", name: "Closed Grill", status: "closed", items: [{ name: "Shawarma Special", price: 1800 }] },
  { id: "yam", name: "Yam Place", status: "active", items: [{ name: "Fried Yam", price: 1500 }] },
]);

function keylessAgent() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_PROVIDER_API_KEY;
  return new FindAgent({ catalogue, reviews: null, apiKey: "" });
}

test("no model: keyword fallback lists matching open meals with stored prices", async () => {
  const result = await keylessAgent().find("I want shawarma under 3000");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_configured");
  const text = formatFindResult(result);
  assert.match(text, /Shawarma \(Regular\) \(Slash Shawarma\) - ₦2,000/);
  assert.doesNotMatch(text, /Jumbo/, "over budget");
  assert.doesNotMatch(text, /Closed Grill/, "closed vendor");
});

test("no model and no matches: points to the menu, names no meal", async () => {
  const text = formatFindResult(await keylessAgent().find("hello there"));
  assert.match(text, /Browse/);
  assert.doesNotMatch(text, /₦/);
});

test("no model, food word not on the menu: budget picks are labelled as budget picks", async () => {
  const text = formatFindResult(await keylessAgent().find("cheap rice under 1600"));
  assert.match(text, /within your budget/);
  assert.match(text, /Fried Yam/);
});
