import { test } from "node:test";
import assert from "node:assert/strict";
import type { Catalogue, MealRecord } from "./catalogue.js";
import type { FindResult, FindTrace } from "./find-agent.js";
import { CachedFinder, MemoryFindCacheStore, normalizeRequest, type FindCacheStore } from "./cache.js";

const trace = (): FindTrace => ({ model: "m", attempts: [], steps: [], turns: [], modelMs: 900, toolMs: 0, rejections: [], inputTokens: 10, outputTokens: 5, ms: 900 });
const meal = (id: string, naira: number, available = true): MealRecord => ({
  mealId: id, vendorId: "v", vendorName: "V", name: id, priceKobo: naira * 100, available,
});

function setup(opts: { result?: (text: string) => FindResult; store?: FindCacheStore; now?: () => number } = {}) {
  const meals = new Map<string, MealRecord>([["rice", meal("rice", 1500)], ["yam", meal("yam", 1200)]]);
  const catalogue = { getMeal: async (id: string) => meals.get(id) ?? null } as unknown as Catalogue;
  let calls = 0;
  const agent = {
    async find(text: string): Promise<FindResult> {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return opts.result?.(text) ?? { ok: true, message: "Try these.", picks: [{ meal: (meals.get("rice") ?? meals.get("yam"))!, reason: "fits", reviews: [] }], trace: trace() };
    },
  };
  const finder = new CachedFinder({ agent, catalogue, version: "t", store: opts.store, now: opts.now });
  return { finder, meals, calls: () => calls };
}

test("normalizes case, spacing, punctuation and money formats", () => {
  assert.equal(normalizeRequest("  Rice,  under ₦2,000!! "), "rice under 2000");
  assert.equal(normalizeRequest("rice under 2k"), "rice under 2000");
  assert.equal(normalizeRequest("Rice under 2000 naira"), "rice under 2000");
  assert.equal(normalizeRequest("2.5k shawarma"), "2500 shawarma");
});

test("second identical request is a hit and skips the agent", async () => {
  const { finder, calls } = setup();
  const a = await finder.find("rice under 2k");
  const b = await finder.find("Rice under ₦2,000");
  assert.equal(a.cache, "miss");
  assert.equal(b.cache, "hit");
  assert.equal(calls(), 1);
  assert.ok(b.ok && b.picks[0].meal.mealId === "rice");
  assert.equal(b.trace.turns.length, 0);
});

test("hit returns the current catalogue record", async () => {
  const { finder, meals } = setup();
  await finder.find("rice");
  meals.set("rice", { ...meals.get("rice")!, name: "Jollof Rice" });
  const r = await finder.find("rice");
  assert.equal(r.cache, "hit");
  assert.ok(r.ok && r.picks[0].meal.name === "Jollof Rice");
});

test("a pick that became unavailable, vanished or changed price makes the entry stale", async () => {
  for (const change of [
    (m: Map<string, MealRecord>) => m.set("rice", meal("rice", 1500, false)),
    (m: Map<string, MealRecord>) => m.delete("rice"),
    (m: Map<string, MealRecord>) => m.set("rice", meal("rice", 2500)),
  ]) {
    const { finder, meals, calls } = setup();
    await finder.find("rice");
    change(meals);
    const r = await finder.find("rice");
    assert.equal(r.cache, "miss");
    assert.equal(calls(), 2);
    assert.equal(finder.stats.stale, 1);
  }
});

test("fallbacks are never cached", async () => {
  const { finder, calls } = setup({ result: () => ({ ok: false, reason: "timeout", trace: trace() }) });
  await finder.find("rice");
  const r = await finder.find("rice");
  assert.equal(r.cache, "miss");
  assert.equal(calls(), 2);
});

test("concurrent identical requests share one agent call", async () => {
  const { finder, calls } = setup();
  const [a, b, c] = await Promise.all([finder.find("yam"), finder.find("yam"), finder.find("YAM")]);
  assert.equal(calls(), 1);
  assert.deepEqual([a.cache, b.cache, c.cache].sort(), ["miss", "shared", "shared"]);
});

test("scope and version separate entries; long notes bypass", async () => {
  const { finder, calls } = setup();
  await finder.find("rice", { scope: "lunch" });
  await finder.find("rice", { scope: "dinner" });
  assert.equal(calls(), 2);
  const long = await finder.find("rice ".repeat(50));
  assert.equal(long.cache, "bypass");
  assert.notEqual(finder.keyFor("rice"), new CachedFinder({ agent: { find: async () => ({}) as FindResult }, catalogue: {} as Catalogue, version: "other" }).keyFor("rice"));
});

test("entries expire after the TTL", async () => {
  let t = 0;
  const now = () => t;
  const { finder, calls } = setup({ store: new MemoryFindCacheStore(10, now), now });
  await finder.find("rice");
  t += 29 * 60_000;
  assert.equal((await finder.find("rice")).cache, "hit");
  t += 2 * 60_000;
  assert.equal((await finder.find("rice")).cache, "miss");
  assert.equal(calls(), 2);
});

test("memory store evicts the least recently used entry", async () => {
  const store = new MemoryFindCacheStore(2);
  const v = { message: "", picks: [], model: "", createdAt: 0 };
  await store.set("a", v, 60_000);
  await store.set("b", v, 60_000);
  await store.get("a");
  await store.set("c", v, 60_000);
  assert.ok(await store.get("a"));
  assert.equal(await store.get("b"), undefined);
});

test("a failing store never breaks /find", async () => {
  const broken: FindCacheStore = {
    get: async () => { throw new Error("redis down"); },
    set: async () => { throw new Error("redis down"); },
    delete: async () => { throw new Error("redis down"); },
  };
  const { finder } = setup({ store: broken });
  const r = await finder.find("rice");
  assert.ok(r.ok);
});
