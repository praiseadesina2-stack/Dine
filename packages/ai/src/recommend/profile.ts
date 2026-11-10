/**
 * Turns a Prime menu item name ("Shawarma + 2 Sausages & Extra Chicken") into
 * the components it is made of, then into a nutrition and taste profile.
 *
 * Rules are keyed to the names on Prime today. An item no rule understands is
 * returned with role "unknown" and is never recommended, so a new menu item
 * fails closed until a rule is added (run `pnpm --filter @dine/ai menu:check`).
 */
import { COMPONENTS, type Allergen, type Component, type Confidence, type Prep, type Slot } from "./knowledge.js";

export type ItemRole = "main" | "extra" | "packaging" | "unknown";

export interface Part {
  component: string;
  /** Multiple of the component's typical serving. */
  qty: number;
  prep?: Prep;
}

export interface ParsedItem {
  role: ItemRole;
  parts: Part[];
  /** Main dish family, used to keep timetables varied. */
  family?: string;
  /** Vendor-specific extra heat (e.g. "CU Spicy"). */
  minHeat?: number;
}

export interface Profile {
  proteinG: number;
  fibreG: number;
  kcal: number;
  heat: number;
  /** Share of calories from sweet components, 0-1. */
  sweet: number;
  /** Share of calories from fried components, 0-1. */
  fried: number;
  /** Share of calories from roasted or grilled components, 0-1. */
  roasted: number;
  /** Share of calories from boiled components, 0-1. */
  boiled: number;
  processed: number;
  allergens: Set<Allergen>;
  meat: boolean;
  fish: boolean;
  porkPossible: boolean;
  highSodium: boolean;
  slots: Set<Slot>;
  components: Set<string>;
  confidence: Confidence;
}

const SIZES: [RegExp, number][] = [
  [/extra large/, 1.6],
  [/\bbig dough\b/, 1.25],
  [/\bjumbo\b/, 1.4],
  [/\bmega\b/, 1.8],
  [/\bsuper\b/, 1.35],
  [/\bbig\b/, 1.9],
  [/\blarge\b/, 1.4],
  [/\bmedium\b/, 1.3],
  [/\bsmall\b/, 0.7],
];
const sizeOf = (n: string) => SIZES.find(([re]) => re.test(n))?.[1] ?? 1;

/** Reference prices (naira) for one typical serving, used to size single-component items by price. */
const REF_PRICE: Record<string, number> = {
  chicken: 1500, fish: 1800, fish_roasted: 600, beef: 200, ponmo: 200, gizzard: 500,
  egg_sauce: 600, pepper_sauce: 300, fish_sauce: 400, tomato_sauce: 250, pepper_stew: 300,
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const byPrice = (component: string, price: number) => clamp(price / (REF_PRICE[component] ?? price), 0.15, 2.5);

const count = (n: string, word: string): number => {
  const m = n.match(new RegExp(`(\\d+)\\s*${word}`));
  if (m) return Number(m[1]);
  return new RegExp(`\\b${word}`).test(n) ? 1 : 0;
};

/** Vendors that roast or grill rather than fry (boli spots). */
const ROAST_VENDOR = /boli|emabuop|cu spicy/i;

export function parseItem(vendorName: string, itemName: string, price: number): ParsedItem {
  const n = itemName.toLowerCase();
  const roastVendor = ROAST_VENDOR.test(vendorName);
  const minHeat = /spicy/i.test(vendorName) ? 2 : undefined;
  const P = (component: string, qty = 1, prep?: Prep): Part => ({ component, qty, prep });
  const extras = (): Part[] => {
    const parts: Part[] = [];
    const s = count(n, "(?:extra )?sausages?");
    if (s) parts.push(P("sausage", s));
    if (/extra chicken|with chicken|chicken lover/.test(n)) parts.push(P("chicken", /lover/.test(n) ? 0.6 : 0.35));
    if (/\begg\b|& egg/.test(n) && !/egg sauce/.test(n)) parts.push(P("egg"));
    if (/cheese|cheesy/.test(n)) parts.push(P("cheese"));
    return parts;
  };

  if (/plastic pack/.test(n)) return { role: "packaging", parts: [] };

  // ---- sweet and savoury toppings ----
  if (/\(topping\)/.test(n) || /^extra cheese$/.test(n)) {
    const t: [RegExp, Part][] = [
      [/ice cream/, P("ice_cream")], [/jam/, P("jam")], [/m&m|chocolate chips/, P("chocolate")],
      [/nutella/, P("nutella")], [/peanut butter/, P("peanut_butter")], [/marshmallow|oreo|sprinkles/, P("sweet_topping")],
      [/cheese/, P("cheese")], [/chicken/, P("chicken", 0.35)],
    ];
    const hit = t.find(([re]) => re.test(n));
    return hit ? { role: "extra", parts: [hit[1]] } : { role: "unknown", parts: [] };
  }

  // ---- sauces ----
  if (/sauce|pepper stew/.test(n)) {
    const c = /egg sauce/.test(n) ? "egg_sauce" : /fish sauce/.test(n) ? "fish_sauce" : /pepper sauce/.test(n) ? "pepper_sauce"
      : /pepper stew/.test(n) ? "pepper_stew" : "tomato_sauce";
    return { role: "extra", parts: [P(c, byPrice(c, price))], minHeat };
  }

  // ---- complete dishes ----
  if (/shawarma/.test(n)) return { role: "main", family: "shawarma", parts: [P("shawarma", sizeOf(n)), ...extras()] };
  if (/pizza burger/.test(n)) return { role: "main", family: "pizza_burger", parts: [P("pizza_burger", sizeOf(n)), ...extras()] };
  if (/pizza/.test(n)) {
    const size = SIZES.some(([re]) => re.test(n)) ? sizeOf(n) : clamp(price / 3500, 0.8, 2.2);
    const parts = [P("pizza", size), ...extras()];
    if (/pepperoni|supreme/.test(n)) parts.push(P("pepperoni", 0.5 * size));
    if (/suya/.test(n)) parts.push(P("kebab", 0.5 * size, "grilled"));
    if (/bbq|deluxe/.test(n)) parts.push(P("chicken", 0.4 * size, "grilled"));
    return { role: "main", family: "pizza", parts };
  }
  if (/burger/.test(n)) return { role: "main", family: "burger", parts: [P("burger"), ...extras()] };
  if (/^burrito$/.test(n)) return { role: "main", family: "burrito", parts: [P("burrito")] };
  if (/(regular|super|mega) pack: chicken/.test(n)) {
    const tier = /mega/.test(n) ? 1.8 : /super/.test(n) ? 1.35 : 1;
    return { role: "main", family: "chicken_pack", parts: [P("chicken", tier), ...extras()] };
  }
  if (/bread warmer/.test(n)) return { role: "main", family: "bread_warmer", parts: [P("bread_warmer", sizeOf(n)), ...extras()] };
  if (/waffle/.test(n)) {
    const parts = [P("waffle", clamp(price / 700, 0.6, 1.2))];
    if (/chocolate/.test(n)) parts.push(P("chocolate", 0.5));
    if (/strawberry/.test(n)) parts.push(P("jam", 0.5));
    return { role: "main", family: "waffle", parts };
  }
  if (/(delish|kings|royal) pack/.test(n)) {
    const tier = /kings/.test(n) ? 1.5 : /royal/.test(n) ? 1.25 : 1;
    return { role: "main", family: "yamarita", parts: [P("yamarita", tier), P("kebab", count(n, "kebabs?"))] };
  }
  if (/boli/.test(n)) {
    const s = sizeOf(n);
    if (/yam & potato/.test(n)) return { role: "main", family: "boli", parts: [P("plantain_roasted", 0.4 * s), P("yam_roasted", 0.4 * s), P("potato_roasted", 0.4 * s)], minHeat };
    if (/potato & egg/.test(n)) return { role: "main", family: "boli", parts: [P("plantain_roasted", 0.6), P("potato_roasted", 0.5), P("egg")], minHeat };
    return { role: "main", family: "boli", parts: [P("plantain_roasted", s)], minHeat };
  }
  if (/(catfish|croaker|tilapia)/.test(n)) {
    const fish = P("fish", sizeOf(n));
    return /no chips/.test(n) ? { role: "extra", parts: [fish] } : { role: "main", family: "fish_chips", parts: [fish, P("potato_fried", 0.8)] };
  }
  if (/yam & potato chips/.test(n)) return { role: "main", family: "chips", parts: [P("yam_fried", 0.5 * sizeOf(n)), P("potato_fried", 0.5 * sizeOf(n))] };
  if (/fried yam/.test(n)) return { role: "main", family: "chips", parts: [P("yam_fried", sizeOf(n))] };
  if (/chips|potato/.test(n)) return { role: "main", family: "chips", parts: [P("potato_fried", sizeOf(n))] };

  // ---- single proteins and sides ----
  if (/chicken/.test(n)) return { role: "extra", parts: [P("chicken", byPrice("chicken", price), roastVendor ? "roasted" : undefined)], minHeat };
  if (/fish/.test(n)) {
    const c = roastVendor ? "fish_roasted" : "fish";
    return { role: "extra", parts: [P(c, byPrice(c, price))], minHeat };
  }
  if (/sausage/.test(n)) return { role: "extra", parts: [P("sausage", 1)], minHeat: /pepper/.test(n) ? 2 : undefined };
  if (/^(fried )?egg$/.test(n)) return { role: "extra", parts: [P("egg")] };
  if (/beef/.test(n)) return { role: "extra", parts: [P("beef", byPrice("beef", price))] };
  if (/ponmo/.test(n)) return { role: "extra", parts: [P("ponmo", byPrice("ponmo", price))] };
  if (/gizzard/.test(n)) return { role: "extra", parts: [P("gizzard", byPrice("gizzard", price))] };
  if (/^plantain$/.test(n)) return { role: "extra", parts: [P("plantain_fried", byPrice("plantain_fried", price) || 1)] };

  return { role: "unknown", parts: [] };
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function profileOf(parts: Part[], minHeat = 0): Profile {
  const p: Profile = {
    proteinG: 0, fibreG: 0, kcal: 0, heat: minHeat, sweet: 0, fried: 0, roasted: 0, boiled: 0, processed: 0,
    allergens: new Set(), meat: false, fish: false, porkPossible: false, highSodium: false,
    slots: new Set(), components: new Set(), confidence: "high",
  };
  let sweetK = 0, friedK = 0, roastedK = 0, boiledK = 0;
  const baseSlots: Slot[][] = [];
  for (const part of parts) {
    const c: Component | undefined = COMPONENTS[part.component];
    if (!c) throw new Error(`Unknown component ${part.component}`);
    const k = c.kcal * part.qty;
    const prep = part.prep ?? c.prep;
    p.proteinG += c.proteinG * part.qty;
    p.fibreG += c.fibreG * part.qty;
    p.kcal += k;
    p.heat = Math.max(p.heat, c.heat);
    if (c.sweet) sweetK += k;
    if (prep === "fried") friedK += k;
    if (prep === "roasted" || prep === "grilled") roastedK += k;
    if (prep === "boiled") boiledK += k;
    if (c.processed) { p.processed += part.qty; p.porkPossible = true; }
    for (const a of [...c.allergens, ...(c.mayContain ?? [])]) p.allergens.add(a);
    p.meat ||= Boolean(c.meat);
    p.fish ||= Boolean(c.fish);
    p.highSodium ||= Boolean(c.highSodium);
    p.components.add(c.id);
    if (c.base) baseSlots.push(c.slots);
    if (CONF_RANK[c.confidence] < CONF_RANK[p.confidence]) p.confidence = c.confidence;
  }
  // A meal's slots come from its base dish, or failing that its first (main) part;
  // extras do not make pizza or a chicken pack a breakfast.
  for (const s of baseSlots[0] ?? (parts[0] ? COMPONENTS[parts[0].component].slots : [])) p.slots.add(s);
  if (p.kcal > 0) {
    p.sweet = sweetK / p.kcal;
    p.fried = friedK / p.kcal;
    p.roasted = roastedK / p.kcal;
    p.boiled = boiledK / p.kcal;
  }
  return p;
}
