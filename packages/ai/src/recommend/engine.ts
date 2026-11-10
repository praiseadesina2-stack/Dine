/**
 * Deterministic recommender over two kinds of meal:
 *  - campus meals (Nigerian university foods list), sized to the per-meal
 *    budget by the spoon, wrap or piece; not orderable through Dine;
 *  - Prime meals (a main plus up to two extras from one Prime vendor), which
 *    are orderable through Dine but only sold in the evening.
 * Each meal is scored against the goals and cravings. A suitable Prime meal is
 * put forward for dinner (and among "eat now" options in the evening). No
 * model calls here; the same input gives the same output.
 */
import { CAMPUS_TEMPLATES, MAX_PROTEIN_PIECES, PROTEIN_UNITS, unitPrices, type CampusTemplate } from "./campus.js";
import { COMPONENTS, type Allergen, type Slot } from "./knowledge.js";
import { loadPrimeMenu, type PrimeMenu, type PrimeVendor } from "./menu.js";
import { parseItem, profileOf, type Part, type Profile } from "./profile.js";
import {
  DEFAULT_PRIME_HOURS, SLOTS_FOR,
  type Craving, type Day, type Goal, type MealSlot, type MealSuggestion, type NoteConstraints,
  type RecommendRequest, type RecommendResult, type TimetableMeal,
} from "./types.js";

export interface EngineOptions {
  menu?: PrimeMenu;
  /** Live open/closed status from the bot; defaults to the crawl snapshot. */
  isVendorOpen?: (vendorId: string) => boolean;
  /** Current time, for "eat now" (meal slot and whether Prime is selling). Defaults to the clock. */
  now?: Date;
  /** Hours Prime sells, Lagos time, [from, to). */
  primeHours?: { from: number; to: number };
}

interface Line { name: string; qty: number; unit?: string; price: number; parts: Part[]; minHeat?: number }
interface Meal {
  source: "prime" | "campus";
  key: string;
  name: string;
  family: string;
  /** Diversity key: vendor for Prime meals, dish family for campus meals. */
  group: string;
  lines: Line[];
  total: number;
  profile: Profile;
  vendor?: PrimeVendor;
}
interface Ctx { goals: Goal[]; cravings: Craving[]; budget: number; note: NoteConstraints; slot?: MealSlot; seed: number }
interface Ranked { m: Meal; s: number }

const MAX_EXTRAS = 2;
/** A Prime meal is "suitable" if it scores within this much of the best meal for the slot. */
const PRIME_MARGIN = 1.5;
/** How far below the top score a meal from a new group may be and still be preferred for variety. */
const SPREAD_MARGIN = 2.5;

const sat = (x: number, full: number) => Math.max(0, Math.min(x / full, 1));
const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

// ---------------------------------------------------------------- shared helpers

function allowed(p: Profile, note: NoteConstraints): boolean {
  if (note.excludeAllergens.some((a) => p.allergens.has(a))) return false;
  if (note.excludeComponents.some((c) => p.components.has(c))) return false;
  if (note.vegetarian && (p.meat || p.fish)) return false;
  if (note.noPork && p.porkPossible) return false;
  if (note.maxHeat != null && p.heat > note.maxHeat) return false;
  return true;
}

function profileOfLines(lines: Line[], slots?: Slot[]): Profile {
  const minHeat = Math.max(0, ...lines.map((l) => l.minHeat ?? 0));
  const p = profileOf(lines.flatMap((l) => l.parts), minHeat);
  if (slots) p.slots = new Set(slots);
  return p;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- scoring

function score(meal: Pick<Meal, "key" | "total" | "profile" | "vendor">, ctx: Ctx): { value: number; reasons: string[] } {
  const p = meal.profile;
  const reasons: string[] = [];
  let v = 0;
  const P = Math.round(p.proteinG), K = Math.round(p.kcal);

  for (const g of ctx.goals) {
    switch (g) {
      case "protein_rich":
        v += 3 * sat(p.proteinG, 45) - (p.proteinG < 15 ? 1 : 0);
        if (p.proteinG >= 30) reasons.push(`High in protein (est. ~${P} g)`);
        break;
      case "high_fibre": {
        const density = p.kcal ? (p.fibreG / p.kcal) * 1000 : 0;
        v += 1.5 * sat(p.fibreG, 10) + 1.5 * sat(density, 16);
        if (p.fibreG >= 7) reasons.push("Good source of fibre");
        break;
      }
      case "healthy":
        v += 1.2 * (p.roasted + p.boiled) - 1.2 * p.fried - 0.5 * Math.min(p.processed, 3) + 0.8 * sat(p.proteinG, 35) + 0.6 * sat(p.fibreG, 8)
          - (p.kcal > 1000 ? 1 : 0) - (p.highSodium ? 0.3 : 0);
        if (p.fried < 0.25 && p.processed === 0) reasons.push(p.roasted >= 0.5 ? "Roasted or grilled, not fried" : "Not fried, no processed meat");
        break;
      case "light":
        v += 2 * (1 - sat(p.kcal, 900)) + 0.6 * sat(p.proteinG, 30);
        if (p.kcal <= 550) reasons.push(`Lighter meal (est. ~${K} kcal)`);
        break;
      case "bulk":
        v += 2 * sat(p.kcal, 1100) + sat(p.proteinG, 50);
        if (p.kcal >= 850) reasons.push(`Big, calorie-dense plate (est. ~${K} kcal)`);
        break;
    }
  }

  for (const c of ctx.cravings) {
    switch (c) {
      case "sweet":
        v += p.sweet >= 0.5 ? 3 * p.sweet : -2 + 2 * p.sweet;
        if (p.sweet >= 0.5) reasons.push("Sweet");
        break;
      case "filling":
        v += 3 * sat(p.kcal, 900) - (p.kcal < 350 ? 1 : 0);
        if (p.kcal >= 700) reasons.push("Filling");
        break;
      case "spicy":
        v += p.heat >= 2 ? 1.5 + 0.5 * (p.heat - 2) : -1.5;
        if (p.heat >= 2) reasons.push(p.heat >= 3 ? "Hot and peppery" : "Spicy");
        break;
      case "savoury":
        v += p.sweet < 0.3 ? 1 : -1.5;
        break;
      case "snack":
        v += p.kcal <= 650 ? 1.5 : -0.5 * ((p.kcal - 650) / 300);
        if (p.kcal <= 650) reasons.push("Snack-sized");
        break;
      case "surprise":
        v += 2 * hash(`${meal.key}|${ctx.seed}`);
        break;
    }
  }
  if (!ctx.goals.length && !ctx.cravings.length) v += sat(p.kcal, 800);

  if (ctx.note.minHeat != null) v += p.heat >= ctx.note.minHeat ? 1 : -1;
  const liked = ctx.note.preferComponents.filter((c) => p.components.has(c));
  if (liked.length) {
    v += 1.5;
    reasons.push(`Has ${[...new Set(liked.map((c) => COMPONENTS[c].label))].join(" and ")}, as you asked`);
  }
  if (meal.vendor && ctx.note.preferVendors.includes(meal.vendor.id)) v += 1.5;

  if (ctx.slot) {
    const s = ctx.slot;
    // Breakfast is the slot where the wrong kind of food feels most wrong.
    v += p.slots.has(s) ? 0.8 : s === "breakfast" ? -3 : -1.2;
    if (s === "breakfast" && p.kcal > 900) v -= 1;
  }

  v += 0.5 * sat(meal.total, ctx.budget);
  return { value: v, reasons };
}

// ---------------------------------------------------------------- Prime meals

interface Entry { line: Line; family?: string; profile: Profile; isTopping: boolean }
const primeCache = new WeakMap<PrimeMenu, Map<string, { mains: Entry[]; extras: Entry[] }>>();

function primeEntries(menu: PrimeMenu) {
  let byVendor = primeCache.get(menu);
  if (!byVendor) {
    byVendor = new Map();
    for (const v of menu.vendors) {
      const mains: Entry[] = [], extras: Entry[] = [];
      for (const item of v.items) {
        const parsed = parseItem(v.name, item.name, item.price);
        const line: Line = { name: item.name, qty: 1, price: item.price, parts: parsed.parts, minHeat: parsed.minHeat };
        const entry: Entry = {
          line, family: parsed.family, profile: profileOf(parsed.parts, parsed.minHeat),
          isTopping: parsed.parts.some((p) => COMPONENTS[p.component].prep === "topping"),
        };
        if (parsed.role === "main") mains.push(entry);
        else if (parsed.role === "extra") extras.push(entry);
      }
      byVendor.set(v.id, { mains, extras });
    }
    primeCache.set(menu, byVendor);
  }
  return byVendor;
}

/** Sweet toppings only go on sweet mains; sweet mains only take egg or sausage as savoury extras. */
function compatible(main: Entry, extra: Entry): boolean {
  const sweetMain = main.family === "waffle";
  if (extra.isTopping && extra.profile.sweet >= 0.5) return sweetMain;
  if (sweetMain) return [...extra.profile.components].every((c) => c === "egg" || c === "sausage");
  if (extra.profile.components.has("cheese")) return ["pizza", "burger", "pizza_burger"].includes(main.family ?? "");
  return true;
}

function primeMeal(vendor: PrimeVendor, main: Entry, extras: Entry[]): Meal {
  const lines = [main.line, ...extras.map((e) => e.line)];
  return {
    source: "prime",
    key: ["prime", vendor.id, main.line.name, ...extras.map((e) => e.line.name).sort()].join("|"),
    name: main.line.name,
    family: main.family ?? "prime",
    group: vendor.id,
    lines,
    total: lines.reduce((s, l) => s + l.price, 0),
    profile: profileOfLines(lines),
    vendor,
  };
}

/** One best meal per (vendor, main): greedily add extras while they raise the score. */
function buildPrimeMeals(menu: PrimeMenu, ctx: Ctx, isOpen: (id: string) => boolean): Meal[] {
  const out: Meal[] = [];
  for (const [vendorId, { mains, extras }] of primeEntries(menu)) {
    const vendor = menu.vendors.find((v) => v.id === vendorId)!;
    if (!isOpen(vendorId) || ctx.note.excludeVendors.includes(vendorId)) continue;
    for (const main of mains) {
      if (main.line.price > ctx.budget) continue;
      let chosen: Entry[] = [];
      let current = primeMeal(vendor, main, chosen);
      if (!allowed(current.profile, ctx.note)) continue;
      let best = score(current, ctx).value;
      for (let round = 0; round < MAX_EXTRAS; round++) {
        let pick: { chosen: Entry[]; meal: Meal; value: number } | null = null;
        for (const extra of extras) {
          if (chosen.includes(extra) || !compatible(main, extra) || current.total + extra.line.price > ctx.budget) continue;
          const meal = primeMeal(vendor, main, [...chosen, extra]);
          if (!allowed(meal.profile, ctx.note)) continue;
          const value = score(meal, ctx).value;
          if (value > best + 0.15 && (!pick || value > pick.value)) pick = { chosen: [...chosen, extra], meal, value };
        }
        if (!pick) break;
        ({ chosen, meal: current, value: best } = pick);
      }
      out.push(current);
    }
  }
  return out;
}

// ---------------------------------------------------------------- campus meals

/**
 * Sizes a campus meal to the budget: start from the minimum portion, then keep
 * adding the spoon, wrap or protein piece that most improves the score, while
 * it fits the budget and each item's cap.
 */
function buildCampusMeal(t: CampusTemplate, ctx: Ctx, prices: Record<string, number>): Meal | null {
  if (t.parts.some((u) => prices[u.component] == null)) return null;
  const proteins = t.proteins.filter((c) => prices[c] != null && PROTEIN_UNITS[c]);
  const proteinPrice = (c: string) => Math.max(50, Math.round((prices[c] * PROTEIN_UNITS[c].qty) / 50) * 50);
  const units = t.parts.map((u) => u.min);
  const pieces = new Map<string, number>();

  const make = (): Meal => {
    const lines: Line[] = [];
    t.parts.forEach((u, i) => {
      if (units[i] > 0)
        lines.push({ name: u.label, qty: units[i], unit: u.unit, price: units[i] * prices[u.component] * u.qty, parts: [{ component: u.component, qty: units[i] * u.qty }] });
    });
    for (const [c, n] of pieces)
      if (n > 0) lines.push({ name: PROTEIN_UNITS[c].label, qty: n, unit: "piece", price: n * proteinPrice(c), parts: [{ component: c, qty: n * PROTEIN_UNITS[c].qty }] });
    return {
      source: "campus", key: `campus|${t.id}`, name: t.name, family: t.family, group: t.family, lines,
      total: lines.reduce((s, l) => s + l.price, 0), profile: profileOfLines(lines, t.slots),
    };
  };

  // Required protein (e.g. the egg in bread and egg): cheapest allowed option.
  for (let i = 0; i < (t.minProtein ?? 0); i++) {
    const options = proteins
      .map((c) => { pieces.set(c, (pieces.get(c) ?? 0) + 1); const m = make(); pieces.set(c, pieces.get(c)! - 1); return { c, m }; })
      .filter(({ m }) => allowed(m.profile, ctx.note))
      .sort((a, b) => a.m.total - b.m.total);
    if (!options.length) return null;
    pieces.set(options[0].c, (pieces.get(options[0].c) ?? 0) + 1);
  }

  let current = make();
  if (current.total > ctx.budget || !allowed(current.profile, ctx.note)) return null;
  let best = score(current, ctx).value;

  for (;;) {
    let pick: { apply: () => void; undo: () => void; meal: Meal; value: number } | null = null;
    const tryStep = (apply: () => void, undo: () => void) => {
      apply();
      const meal = make();
      undo();
      if (meal.total > ctx.budget || !allowed(meal.profile, ctx.note)) return;
      const value = score(meal, ctx).value;
      if (value > best && (!pick || value > pick.value)) pick = { apply, undo, meal, value };
    };
    t.parts.forEach((u, i) => {
      if (units[i] < u.max) tryStep(() => units[i]++, () => units[i]--);
    });
    const totalPieces = [...pieces.values()].reduce((s, n) => s + n, 0);
    if (totalPieces < MAX_PROTEIN_PIECES)
      for (const c of proteins)
        if ((pieces.get(c) ?? 0) < PROTEIN_UNITS[c].max)
          tryStep(() => pieces.set(c, (pieces.get(c) ?? 0) + 1), () => pieces.set(c, pieces.get(c)! - 1));
    if (!pick) break;
    const chosen: { apply: () => void; meal: Meal; value: number } = pick;
    chosen.apply();
    current = chosen.meal;
    best = chosen.value;
  }
  return current;
}

function buildCampusMeals(ctx: Ctx, prices: Record<string, number>): Meal[] {
  return CAMPUS_TEMPLATES.map((t) => buildCampusMeal(t, ctx, prices)).filter((m): m is Meal => m !== null);
}

// ---------------------------------------------------------------- selection

function rank(meals: Meal[], ctx: Ctx, exclude: Set<string>): Ranked[] {
  return meals
    .filter((m) => !exclude.has(m.key))
    .map((m) => ({ m, s: score(m, ctx).value }))
    .sort((a, b) => b.s - a.s || a.m.total - b.m.total || a.m.key.localeCompare(b.m.key));
}

/** Take n: one per group among the close contenders first, then fill by rank. */
function spread(ranked: Ranked[], n: number): Meal[] {
  const out: Meal[] = [];
  const groups = new Set<string>();
  const floor = (ranked[0]?.s ?? 0) - SPREAD_MARGIN;
  for (const r of ranked) {
    if (out.length >= n || r.s < floor) break;
    if (!groups.has(r.m.group)) { out.push(r.m); groups.add(r.m.group); }
  }
  for (const r of ranked) if (out.length < n && !out.includes(r.m)) out.push(r.m);
  return out;
}

/** The best Prime meal, if it is close enough to the best meal overall to be a fair suggestion. */
function suitablePrime(ranked: Ranked[]): Meal | undefined {
  const top = ranked[0]?.s;
  return top == null ? undefined : ranked.find((r) => r.m.source === "prime" && r.s >= top - PRIME_MARGIN)?.m;
}

const ALLERGEN_LABEL: Record<Allergen, string> = {
  groundnut: "groundnut", tree_nut: "tree nuts", egg: "egg", fish: "fish", shellfish: "shellfish", dairy: "dairy", gluten: "gluten (wheat)",
};

function toSuggestion(meal: Meal, ctx: Ctx): MealSuggestion {
  const p = meal.profile;
  const prime = meal.source === "prime";
  const reasons = score(meal, ctx).reasons;
  if (prime) reasons.push(`${naira(meal.total)} of your ${naira(ctx.budget)} budget`);
  const warnings: string[] = [];
  if (p.allergens.size) warnings.push(`May contain: ${[...p.allergens].map((a) => ALLERGEN_LABEL[a]).join(", ")}`);
  if (p.porkPossible) warnings.push("Has sausage or pepperoni; ask the vendor if it contains pork");
  return {
    key: meal.key,
    name: prime ? meal.name : campusTitle(meal),
    orderable: prime,
    ...(prime
      ? {
          orderLabel: "Order on Dine" as const, vendorId: meal.vendor!.id, vendorName: meal.vendor!.name, location: meal.vendor!.location,
          items: meal.lines.map(({ name, price }) => ({ name, price })),
          totalPrice: meal.total,
        }
      : { items: meal.lines.map(({ name }) => ({ name })) }),
    reasons: [...new Set(reasons)],
    estimates: {
      proteinG: Math.round(p.proteinG), fibreG: Math.round(p.fibreG), kcal: Math.round(p.kcal / 10) * 10, heat: p.heat, confidence: p.confidence,
    },
    warnings,
  };
}

/** "Rice and beans with fish and dodo": the dish plus whatever protein and sides were added to it. */
function campusTitle(meal: Meal): string {
  const lower = meal.name.toLowerCase();
  const extras = meal.lines.map((l) => l.name.toLowerCase()).filter((n) => !lower.includes(n));
  if (!extras.length) return meal.name;
  const list = extras.length === 1 ? extras[0] : `${extras.slice(0, -1).join(", ")} and ${extras[extras.length - 1]}`;
  return `${meal.name} with ${list}`;
}

const lagosHour =(d: Date) => (d.getUTCHours() + 1) % 24; // WAT is UTC+1, no daylight saving
const slotAt = (hour: number): MealSlot => (hour < 11 ? "breakfast" : hour < 16 ? "lunch" : "dinner");

// ---------------------------------------------------------------- entry point

export function runEngine(req: RecommendRequest, note: NoteConstraints, opts: EngineOptions = {}): RecommendResult {
  const menu = opts.menu ?? loadPrimeMenu();
  const openSnapshot = new Map(menu.vendors.map((v) => [v.id, v.open]));
  const isOpen = opts.isVendorOpen ?? ((id: string) => openSnapshot.get(id) ?? false);
  const hours = opts.primeHours ?? DEFAULT_PRIME_HOURS;
  const prices = unitPrices(menu);
  const base: Ctx = {
    goals: [...new Set(req.goals ?? [])], cravings: [...new Set(req.cravings ?? [])],
    budget: Math.max(0, Math.round(req.budgetPerMeal)), note, seed: req.seed ?? 0,
  };
  const exclude = new Set(req.excludeMealKeys ?? []);
  const notices = baseNotices(note);
  const menuAsOf = menu.source.crawledAt;
  const mealsFor = (ctx: Ctx, withPrime: boolean) => [...buildCampusMeals(ctx, prices), ...(withPrime ? buildPrimeMeals(menu, ctx, isOpen) : [])];
  const finish = (_shown: Meal[]) => {
    notices.push("Nutrition figures are rough estimates.");
  };

  if (req.mode === "now") {
    const hour = lagosHour(opts.now ?? new Date());
    const ctx = { ...base, slot: slotAt(hour) };
    const primeSelling = hour >= hours.from && hour < hours.to;
    const ranked = rank(mealsFor(ctx, primeSelling), ctx, exclude);
    let chosen = spread(ranked, 3);
    const prime = suitablePrime(ranked);
    if (prime && !chosen.some((m) => m.source === "prime")) chosen = [...chosen.slice(0, 2), prime];
    if (chosen.length === 0) notices.push(`Nothing fits ${naira(base.budget)} with these choices. Try a higher budget or fewer restrictions.`);
    finish(chosen);
    return { mode: "now", options: chosen.map((m) => toSuggestion(m, ctx)), note, notices, menuAsOf };
  }

  const days: Day[] = req.days?.length ? [...new Set(req.days)] : ["mon"];
  const slots = SLOTS_FOR[req.mealsPerDay ?? 3] ?? SLOTS_FOR[3];
  // Prime only sells in the evening, so it is only considered for dinner.
  const mealsBySlot = new Map(slots.map((slot) => [slot, mealsFor({ ...base, slot }, slot === "dinner")] as const));

  const used = new Map<string, number>();
  const groupUse = new Map<string, number>();
  let prevFamily: string | undefined;
  const shown: Meal[] = [];
  const plan: { day: Day; meals: TimetableMeal[] }[] = [];
  let empty = 0;

  for (const day of days) {
    const today = { groups: new Set<string>(), families: new Set<string>() };
    const meals: TimetableMeal[] = [];
    for (const slot of slots) {
      const ctx = { ...base, slot };
      let candidates = mealsBySlot.get(slot)!;
      // Breakfast should be breakfast food (no pepper soup at 8am) whenever there is enough of it.
      const fitting = candidates.filter((m) => m.profile.slots.has(slot));
      if (fitting.length >= 3) candidates = fitting;
      const ranked = rank(candidates, ctx, exclude)
        .map(({ m, s }) => {
          let adj = s - 4 * (used.get(m.key) ?? 0) - 0.3 * (groupUse.get(m.group) ?? 0);
          if (m.family === prevFamily) adj -= 1;
          if (today.groups.has(m.group)) adj -= 1.5;
          if (today.families.has(m.family)) adj -= 1.5;
          return { m, s: adj };
        })
        .sort((a, b) => b.s - a.s || a.m.key.localeCompare(b.m.key));
      const prime = slot === "dinner" ? suitablePrime(ranked) : undefined;
      const order = prime ? [prime, ...spread(ranked.filter((r) => r.m !== prime), 2)] : spread(ranked, 3);
      const [pick, ...rest] = order;
      if (!pick) { empty++; meals.push({ slot, pick: null, alternatives: [] }); continue; }
      used.set(pick.key, (used.get(pick.key) ?? 0) + 1);
      groupUse.set(pick.group, (groupUse.get(pick.group) ?? 0) + 1);
      today.groups.add(pick.group);
      today.families.add(pick.family);
      prevFamily = pick.family;
      shown.push(...order);
      meals.push({ slot, pick: toSuggestion(pick, ctx), alternatives: rest.map((m) => toSuggestion(m, ctx)) });
    }
    plan.push({ day, meals });
  }
  if (empty) notices.push(`${empty} meal(s) could not be filled within ${naira(base.budget)} and your preferences.`);
  finish(shown);
  return { mode: "timetable", days: plan, note, notices, menuAsOf };
}

function baseNotices(note: NoteConstraints): string[] {
  return note.unhandled.length ? [`Couldn't apply from your note: ${note.unhandled.map((u) => `"${u}"`).join(", ")}.`] : [];
}
