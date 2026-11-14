import { test } from "node:test";
import assert from "node:assert/strict";
import type { Catalogue, MealRecord } from "./catalogue.js";
import type { FindResult, FindTrace } from "./find-agent.js";
import { CachedFinder, MemoryFindCacheStore, normalizeRequest, type FindCacheStore } from "./cache.js";
import { buildSystemPrompt } from "./find-agent.js";
import { declarationsFor } from "./tools.js";

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

function poolSetup(message = "Here are some options.") {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const meals = new Map(ids.map((id) => [id, meal(id + "-meal", 1000)] as const));
  const catalogue = { getMeal: async (id: string) => [...meals.values()].find((m) => m.mealId === id) ?? null } as unknown as Catalogue;
  let calls = 0;
  const agent = {
    async find(): Promise<FindResult> {
      calls++;
      return { ok: true, message, picks: [...meals.values()].map((m) => ({ meal: m, reason: "fits", reviews: [] })), trace: trace() };
    },
  };
  const finder = new CachedFinder({ agent, catalogue, version: "t" });
  const names = (r: FindResult) => (r.ok ? r.picks.map((p) => p.meal.mealId[0]).join("") : "");
  return { finder, meals, names, calls: () => calls };
}

test("a bigger pool is cached whole and rotated 3 at a time", async () => {
  const { finder, names, calls } = poolSetup();
  assert.equal(names(await finder.find("rice")), "abc");
  assert.equal(names(await finder.find("rice")), "def");
  assert.equal(names(await finder.find("rice")), "abc");
  assert.equal(calls(), 1);
});

test("no rotation when the message names a specific meal", async () => {
  const { finder, names } = poolSetup("The a-meal is a good start.");
  await finder.find("rice");
  assert.equal(names(await finder.find("rice")), "abc");
});

test("dropped picks shrink the pool instead of discarding it", async () => {
  const { finder, meals, names, calls } = poolSetup();
  await finder.find("rice");
  meals.set("b", { ...meals.get("b")!, available: false });
  meals.set("e", { ...meals.get("e")!, priceKobo: 99_900 });
  const r = await finder.find("rice");
  assert.equal(r.cache, "hit");
  assert.equal(names(r), "fac"); // pool is now a,c,d,f; window starts at index 3
  assert.equal(calls(), 1);
});

test("pool too small to fill a reply goes back to the agent", async () => {
  const { finder, meals, calls } = poolSetup();
  await finder.find("rice");
  for (const id of ["a", "b", "c", "d"]) meals.set(id, { ...meals.get(id)!, available: false });
  assert.equal((await finder.find("rice")).cache, "miss");
  assert.equal(calls(), 2);
});

test("agent pool mode widens final_answer and the prompt only above 3", () => {
  const picksMax = (d: ReturnType<typeof declarationsFor>) => (d.at(-1)!.parametersJsonSchema as any).properties.picks.maxItems;
  assert.equal(picksMax(declarationsFor({ reviews: true })), 3);
  assert.equal(picksMax(declarationsFor({ reviews: true, maxPicks: 6 })), 6);
  assert.equal(picksMax(declarationsFor({ reviews: false })), 3, "shared declaration not mutated");
  assert.doesNotMatch(buildSystemPrompt({ reviews: true }), /Pool mode/);
  assert.match(buildSystemPrompt({ reviews: true, maxPicks: 6 }), /up to 6 meals/);
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
