/**
 * Campus meals from the Nigerian university foods list that are NOT ordered
 * through Dine: buka, cafeteria and street food bought by the spoon, wrap or
 * piece. The engine sizes each one to the user's per-meal budget.
 *
 * Prices: anything Prime also sells (beef, egg, ponmo, chicken, fish, gizzard,
 * dodo, egg sauce) uses Prime's price, since those are the same everywhere on
 * campus. The rest come from CAMPUS_PRICES below. Akara at ₦100 is confirmed;
 * the others are typical-price estimates to correct as real prices come in.
 */
import type { PrimeMenu } from "./menu.js";
import { parseItem } from "./profile.js";
import type { Slot } from "./knowledge.js";

export interface Unit {
  component: string;
  /** Display name of one unit, e.g. "Jollof rice". */
  label: string;
  unit: string;
  /** Multiple of the component serving per unit (1 unless a smaller piece is sold). */
  qty: number;
  min: number;
  max: number;
}

export interface CampusTemplate {
  id: string;
  name: string;
  family: string;
  slots: Slot[];
  /** Always included, from `min` up to `max` units. */
  parts: Unit[];
  /** Proteins that may be added (component ids), each up to its own cap. */
  proteins: string[];
  /** Minimum protein pieces (e.g. bread and egg needs an egg). */
  minProtein?: number;
}

/** Naira per unit for foods Prime does not sell. Only akara is confirmed. */
export const CAMPUS_PRICES: Record<string, { price: number; unit: string; confirmed?: boolean }> = {
  akara: { price: 100, unit: "piece", confirmed: true },
  rice_white: { price: 200, unit: "spoon" },
  jollof_rice: { price: 250, unit: "spoon" },
  fried_rice: { price: 300, unit: "spoon" },
  rice_beans: { price: 200, unit: "spoon" },
  beans: { price: 200, unit: "spoon" },
  beans_porridge: { price: 300, unit: "spoon" },
  spaghetti: { price: 200, unit: "spoon" },
  stew: { price: 100, unit: "spoon" },
  ewa_agoyin: { price: 500, unit: "portion" },
  yam_porridge: { price: 1000, unit: "portion" },
  yam_boiled: { price: 200, unit: "slice" },
  indomie: { price: 700, unit: "pack" },
  eba: { price: 200, unit: "wrap" },
  amala: { price: 200, unit: "wrap" },
  fufu: { price: 200, unit: "wrap" },
  semo: { price: 200, unit: "wrap" },
  pounded_yam: { price: 400, unit: "wrap" },
  egusi: { price: 400, unit: "portion" },
  efo_riro: { price: 400, unit: "portion" },
  ewedu: { price: 200, unit: "portion" },
  gbegiri: { price: 200, unit: "portion" },
  ofada_ayamase: { price: 1500, unit: "plate" },
  bread: { price: 300, unit: "portion" },
  moi_moi: { price: 500, unit: "wrap" },
  abacha: { price: 1000, unit: "portion" },
  pepper_soup: { price: 1500, unit: "bowl" },
  shaki: { price: 300, unit: "piece" },
  puff_puff: { price: 100, unit: "ball" },
  doughnut: { price: 400, unit: "piece" },
  meat_pie: { price: 700, unit: "piece" },
  sausage_roll: { price: 500, unit: "piece" },
  suya: { price: 1000, unit: "portion" },
};

/** Used when Prime has no clean single-serving item for a shared food. */
const PRIME_FALLBACK: Record<string, number> = {
  beef: 200, egg: 300, ponmo: 200, chicken: 1500, fish: 1800, gizzard: 500, plantain_fried: 200, egg_sauce: 700,
};

/** Protein pieces as sold at a buka: component, how much of a serving one piece is, and how many may be added. */
export const PROTEIN_UNITS: Record<string, { label: string; qty: number; max: number }> = {
  beef: { label: "Beef", qty: 1, max: 4 },
  ponmo: { label: "Ponmo", qty: 1, max: 3 },
  shaki: { label: "Shaki", qty: 1, max: 3 },
  egg: { label: "Egg", qty: 1, max: 3 },
  gizzard: { label: "Gizzard", qty: 1, max: 2 },
  chicken: { label: "Chicken", qty: 1, max: 1 },
  fish: { label: "Fish", qty: 0.5, max: 2 },
};
export const MAX_PROTEIN_PIECES = 5;

/**
 * Price of one serving of `component`, from Prime when Prime sells a plain
 * single serving of it (median across vendors), else CAMPUS_PRICES.
 */
export function unitPrices(menu: PrimeMenu): Record<string, number> {
  const seen = new Map<string, number[]>();
  // Open vendors only: a closed specialist (whole croaker at Fish and Chips) is not a typical campus price.
  for (const v of menu.vendors.filter((x) => x.open)) {
    for (const item of v.items) {
      const parsed = parseItem(v.name, item.name, item.price);
      if (parsed.role !== "extra" || parsed.parts.length !== 1) continue;
      const [part] = parsed.parts;
      if (part.qty < 0.7 || part.qty > 1.4) continue;
      const list = seen.get(part.component) ?? [];
      list.push(item.price / part.qty);
      seen.set(part.component, list);
    }
  }
  const out: Record<string, number> = {};
  for (const [c, { price }] of Object.entries(CAMPUS_PRICES)) out[c] = price;
  for (const [c, fallback] of Object.entries(PRIME_FALLBACK)) {
    const list = (seen.get(c) ?? []).sort((a, b) => a - b);
    out[c] = list.length ? Math.round(list[Math.floor((list.length - 1) / 2)] / 50) * 50 : fallback;
  }
  return out;
}

const U = (component: string, label: string, unit: string, min: number, max: number, qty = 1): Unit => ({ component, label, unit, qty, min, max });
const ALL_PROTEIN = ["beef", "ponmo", "shaki", "egg", "gizzard", "chicken", "fish"];
const SWALLOW_PROTEIN = ["beef", "ponmo", "shaki", "fish", "chicken"];
const dodo = (max = 2) => U("plantain_fried", "Dodo", "portion", 0, max);

const swallows: [string, string, number][] = [
  ["eba", "Eba", 3], ["amala", "Amala", 3], ["pounded_yam", "Pounded yam", 2], ["fufu", "Fufu", 3], ["semo", "Semo", 3],
];
const soups: Record<string, [string, string][][]> = {
  eba: [[["egusi", "Egusi soup"]], [["efo_riro", "Efo riro"]]],
  amala: [[["ewedu", "Ewedu"], ["gbegiri", "Gbegiri"]], [["efo_riro", "Efo riro"]]],
  pounded_yam: [[["egusi", "Egusi soup"]], [["efo_riro", "Efo riro"]]],
  fufu: [[["egusi", "Egusi soup"]]],
  semo: [[["efo_riro", "Efo riro"]], [["egusi", "Egusi soup"]]],
};

export const CAMPUS_TEMPLATES: CampusTemplate[] = [
  { id: "rice_stew", name: "Rice and stew", family: "rice", slots: ["lunch", "dinner"],
    parts: [U("rice_white", "White rice", "spoon", 2, 5), U("stew", "Stew", "spoon", 1, 2), dodo()], proteins: ALL_PROTEIN },
  { id: "jollof", name: "Jollof rice", family: "rice", slots: ["lunch", "dinner"],
    parts: [U("jollof_rice", "Jollof rice", "spoon", 2, 5), dodo()], proteins: ALL_PROTEIN },
  { id: "fried_rice", name: "Fried rice", family: "rice", slots: ["lunch", "dinner"],
    parts: [U("fried_rice", "Fried rice", "spoon", 2, 5), dodo()], proteins: ["chicken", "beef", "egg", "fish", "gizzard"] },
  { id: "rice_beans", name: "Rice and beans", family: "beans", slots: ["lunch", "dinner"],
    parts: [U("rice_beans", "Rice and beans", "spoon", 2, 5), U("stew", "Stew", "spoon", 1, 2), dodo()], proteins: ALL_PROTEIN },
  { id: "ofada", name: "Ofada rice and ayamase", family: "rice", slots: ["lunch"],
    parts: [U("ofada_ayamase", "Ofada rice and ayamase", "plate", 1, 1)], proteins: ["beef", "ponmo", "shaki", "egg"] },
  { id: "agoyin", name: "Ewa agoyin and bread", family: "beans", slots: ["breakfast", "lunch"],
    parts: [U("ewa_agoyin", "Ewa agoyin", "portion", 1, 2), U("bread", "Bread", "portion", 1, 2), dodo()], proteins: ["egg", "fish"] },
  { id: "beans_porridge", name: "Beans porridge", family: "beans", slots: ["lunch", "dinner"],
    parts: [U("beans_porridge", "Beans porridge", "spoon", 2, 4), dodo()], proteins: ["fish", "egg", "beef", "ponmo"] },
  { id: "yam_porridge", name: "Yam porridge", family: "yam", slots: ["lunch", "dinner"],
    parts: [U("yam_porridge", "Yam porridge", "portion", 1, 2)], proteins: ["fish", "beef", "egg", "ponmo"] },
  { id: "yam_egg", name: "Boiled yam and egg sauce", family: "yam", slots: ["breakfast", "lunch"],
    parts: [U("yam_boiled", "Boiled yam", "slice", 2, 5), U("egg_sauce", "Egg sauce", "portion", 1, 2)], proteins: ["egg", "fish"] },
  { id: "spaghetti", name: "Spaghetti", family: "pasta", slots: ["lunch", "dinner"],
    parts: [U("spaghetti", "Spaghetti", "spoon", 2, 4)], proteins: ["chicken", "beef", "egg", "fish"] },
  { id: "indomie", name: "Indomie and egg", family: "noodles", slots: ["breakfast", "lunch", "dinner", "snack"],
    parts: [U("indomie", "Indomie", "pack", 1, 2)], proteins: ["egg", "beef"], minProtein: 1 },
  { id: "akara_bread", name: "Akara and bread", family: "akara", slots: ["breakfast", "snack"],
    parts: [U("akara", "Akara", "piece", 4, 10), U("bread", "Bread", "portion", 1, 1)], proteins: [] },
  { id: "moi_moi", name: "Moi moi", family: "moi_moi", slots: ["breakfast", "lunch", "snack"],
    parts: [U("moi_moi", "Moi moi", "wrap", 1, 2), U("bread", "Bread", "portion", 0, 1)], proteins: ["egg", "fish"] },
  { id: "bread_egg", name: "Bread and egg", family: "bread", slots: ["breakfast"],
    parts: [U("bread", "Bread", "portion", 1, 1)], proteins: ["egg"], minProtein: 1 },
  { id: "abacha", name: "Abacha", family: "abacha", slots: ["lunch", "snack"],
    parts: [U("abacha", "Abacha", "portion", 1, 1)], proteins: ["fish", "ponmo"] },
  { id: "pepper_soup", name: "Pepper soup", family: "pepper_soup", slots: ["dinner"],
    parts: [U("pepper_soup", "Pepper soup", "bowl", 1, 2), U("yam_boiled", "Boiled yam", "slice", 0, 3), U("moi_moi", "Moi moi", "wrap", 0, 1)], proteins: [] },
  { id: "puff_puff", name: "Puff puff", family: "pastry", slots: ["breakfast", "snack"],
    parts: [U("puff_puff", "Puff puff", "ball", 5, 10)], proteins: [] },
  { id: "doughnut", name: "Doughnut", family: "pastry", slots: ["breakfast", "snack"],
    parts: [U("doughnut", "Doughnut", "piece", 1, 3)], proteins: [] },
  { id: "meat_pie", name: "Meat pie", family: "pastry", slots: ["breakfast", "lunch", "snack"],
    parts: [U("meat_pie", "Meat pie", "piece", 1, 2)], proteins: [] },
  { id: "sausage_roll", name: "Sausage roll", family: "pastry", slots: ["breakfast", "snack"],
    parts: [U("sausage_roll", "Sausage roll", "piece", 1, 3)], proteins: [] },
  { id: "suya", name: "Suya", family: "suya", slots: ["dinner", "snack"],
    parts: [U("suya", "Suya", "portion", 1, 3)], proteins: [] },
  { id: "gizdodo", name: "Gizdodo", family: "plantain", slots: ["lunch", "dinner", "snack"],
    parts: [U("plantain_fried", "Dodo", "portion", 2, 4), U("gizzard", "Gizzard", "portion", 1, 2)], proteins: [] },
  { id: "dodo_egg", name: "Dodo and egg sauce", family: "plantain", slots: ["breakfast", "lunch"],
    parts: [U("plantain_fried", "Dodo", "portion", 2, 4), U("egg_sauce", "Egg sauce", "portion", 1, 2)], proteins: ["egg"] },
  ...swallows.flatMap(([id, label, max]) =>
    soups[id].map((soup): CampusTemplate => ({
      id: `${id}_${soup.map(([s]) => s).join("_")}`,
      name: `${label} and ${soup.map(([, l]) => l.toLowerCase()).join(" and ")}`,
      family: "swallow",
      slots: ["lunch", "dinner"],
      parts: [U(id, label, "wrap", 1, max), ...soup.map(([s, l]) => U(s, l, "portion", 1, 1))],
      proteins: SWALLOW_PROTEIN,
    })),
  ),
];
