/**
 * Food component knowledge, per typical campus serving of that component.
 *
 * Values come from "Nigerian University Foods: Nutrition and Attribute Dataset"
 * (9 Nov 2026) where it covers the food, scaled from per-100 g to a serving.
 * Prime's menu is mostly street and fast food the dataset does not cover
 * (chips, pizza, burgers, waffles, sausages), so those are marked EST: rough
 * estimates to be replaced with real data. Treat every number as a ranking
 * signal, never as a nutrition claim shown to users.
 */

export const ALLERGENS = ["groundnut", "tree_nut", "egg", "fish", "shellfish", "dairy", "gluten"] as const;
export type Allergen = (typeof ALLERGENS)[number];

export type Prep = "fried" | "roasted" | "grilled" | "baked" | "boiled" | "sauce" | "topping";
export type Slot = "breakfast" | "lunch" | "dinner" | "snack";
export type Confidence = "high" | "medium" | "low";

export interface Component {
  id: string;
  label: string;
  /** Per serving. Protein is "effective" protein (ponmo collagen counted at half, per the dataset). */
  proteinG: number;
  fibreG: number;
  kcal: number;
  /** Pepper heat 0-4, dataset scale. */
  heat: number;
  sweet: boolean;
  prep: Prep;
  /** A starchy base or a complete dish, i.e. something a meal can be built on. */
  base: boolean;
  allergens: Allergen[];
  /** Allergens that depend on the vendor's recipe. Treated as present when the user excludes them. */
  mayContain?: Allergen[];
  meat?: boolean;
  fish?: boolean;
  /** Processed meat (sausage, pepperoni); also flagged as possibly pork. */
  processed?: boolean;
  highSodium?: boolean;
  slots: Slot[];
  /** Words a user might use for this food in a free-text note. */
  aliases: string[];
  source: string;
  confidence: Confidence;
}

const C = (c: Component) => c;

export const COMPONENTS: Record<string, Component> = {
  // ---- starchy bases ----
  potato_fried: C({
    id: "potato_fried", label: "chips", proteinG: 7, fibreG: 7, kcal: 620, heat: 0, sweet: false, prep: "fried", base: true,
    allergens: [], highSodium: false, slots: ["lunch", "dinner", "snack"], aliases: ["chips", "fries", "potato", "potatoes"],
    source: "EST (not in dataset; ~200 g fries)", confidence: "low",
  }),
  potato_roasted: C({
    id: "potato_roasted", label: "roasted potato", proteinG: 4, fibreG: 4, kcal: 190, heat: 0, sweet: false, prep: "roasted", base: true,
    allergens: [], slots: ["lunch", "dinner", "snack"], aliases: ["potato", "potatoes"],
    source: "EST (not in dataset)", confidence: "low",
  }),
  yam_fried: C({
    id: "yam_fried", label: "fried yam", proteinG: 3, fibreG: 6, kcal: 400, heat: 0, sweet: false, prep: "fried", base: true,
    allergens: [], slots: ["breakfast", "lunch", "dinner"], aliases: ["yam", "dundun", "fried yam"],
    source: "dataset boiled yam 116 kcal/100 g (FS, medium) + frying oil, EST", confidence: "low",
  }),
  yam_roasted: C({
    id: "yam_roasted", label: "roasted yam", proteinG: 3, fibreG: 5, kcal: 240, heat: 0, sweet: false, prep: "roasted", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["yam", "roasted yam"],
    source: "dataset boiled yam 116 kcal/100 g (FS, medium), EST", confidence: "low",
  }),
  plantain_roasted: C({
    id: "plantain_roasted", label: "boli (roasted plantain)", proteinG: 2.5, fibreG: 4.6, kcal: 270, heat: 0, sweet: true, prep: "roasted", base: true,
    allergens: [], slots: ["lunch", "dinner", "snack"], aliases: ["boli", "bole", "plantain", "roasted plantain"],
    source: "dataset bole 120-150 kcal/100 g (EST, low); plantain fibre 2.3 g/100 g (FS/USDA, medium)", confidence: "low",
  }),
  plantain_fried: C({
    id: "plantain_fried", label: "dodo (fried plantain)", proteinG: 1.2, fibreG: 4.6, kcal: 235, heat: 0, sweet: true, prep: "fried", base: false,
    allergens: [], slots: ["lunch", "dinner", "snack"], aliases: ["dodo", "plantain", "fried plantain"],
    source: "dataset dodo 292 kcal, 5.8 g fibre/100 g (FN, high), ~80 g side", confidence: "medium",
  }),
  yamarita: C({
    id: "yamarita", label: "yamarita (egg-battered fried yam)", proteinG: 9, fibreG: 6, kcal: 520, heat: 1, sweet: false, prep: "fried", base: true,
    allergens: ["egg"], mayContain: ["gluten"], slots: ["breakfast", "lunch", "dinner"], aliases: ["yamarita", "yam", "egg"],
    source: "dataset boiled yam (FS, medium) + egg (EST), fried, EST", confidence: "low",
  }),
  bread_warmer: C({
    id: "bread_warmer", label: "bread warmer (toasted bread)", proteinG: 12, fibreG: 3, kcal: 420, heat: 1, sweet: false, prep: "baked", base: true,
    allergens: ["gluten"], mayContain: ["egg", "dairy"], slots: ["breakfast", "snack", "dinner"], aliases: ["bread", "bread warmer", "toast"],
    source: "dataset white bread ~265 kcal/100 g (EST, low)", confidence: "low",
  }),

  // ---- complete dishes ----
  shawarma: C({
    id: "shawarma", label: "shawarma", proteinG: 30, fibreG: 3, kcal: 650, heat: 1, sweet: false, prep: "grilled", base: true,
    allergens: ["gluten", "dairy", "egg"], meat: true, slots: ["snack", "lunch", "dinner"], aliases: ["shawarma", "wrap"],
    source: "dataset whole wrap 500-800 kcal, 9-13 g protein/100 g (EST, low)", confidence: "low",
  }),
  pizza: C({
    id: "pizza", label: "pizza", proteinG: 28, fibreG: 3, kcal: 650, heat: 0, sweet: false, prep: "baked", base: true,
    allergens: ["gluten", "dairy"], meat: true, slots: ["lunch", "dinner"], aliases: ["pizza"],
    source: "EST (not in dataset; ~8 inch pizza)", confidence: "low",
  }),
  pizza_burger: C({
    id: "pizza_burger", label: "pizza burger", proteinG: 18, fibreG: 2, kcal: 450, heat: 0, sweet: false, prep: "baked", base: true,
    allergens: ["gluten", "dairy"], meat: true, slots: ["lunch", "dinner", "snack"], aliases: ["pizza burger", "burger"],
    source: "EST (not in dataset)", confidence: "low",
  }),
  burger: C({
    id: "burger", label: "burger", proteinG: 22, fibreG: 2, kcal: 500, heat: 0, sweet: false, prep: "grilled", base: true,
    allergens: ["gluten"], mayContain: ["egg", "dairy"], meat: true, slots: ["lunch", "dinner", "snack"], aliases: ["burger"],
    source: "EST (not in dataset)", confidence: "low",
  }),
  burrito: C({
    id: "burrito", label: "burrito", proteinG: 20, fibreG: 4, kcal: 450, heat: 1, sweet: false, prep: "fried", base: true,
    allergens: ["gluten"], mayContain: ["dairy"], meat: true, slots: ["lunch", "dinner", "snack"], aliases: ["burrito", "wrap"],
    source: "EST (not in dataset)", confidence: "low",
  }),
  waffle: C({
    id: "waffle", label: "waffle", proteinG: 7, fibreG: 1, kcal: 300, heat: 0, sweet: true, prep: "baked", base: true,
    allergens: ["gluten", "egg", "dairy"], slots: ["breakfast", "snack"], aliases: ["waffle", "waffles"],
    source: "EST (not in dataset)", confidence: "low",
  }),

  // ---- proteins ----
  chicken: C({
    id: "chicken", label: "chicken", proteinG: 32, fibreG: 0, kcal: 360, heat: 1, sweet: false, prep: "fried", base: false,
    allergens: [], meat: true, slots: ["lunch", "dinner"], aliases: ["chicken"],
    source: "dataset fried chicken ~27 g protein/100 g (AR, low), ~120 g edible", confidence: "low",
  }),
  fish: C({
    id: "fish", label: "fish", proteinG: 42, fibreG: 0, kcal: 375, heat: 1, sweet: false, prep: "fried", base: false,
    allergens: ["fish"], fish: true, slots: ["lunch", "dinner"], aliases: ["fish", "catfish", "croaker", "tilapia", "titus"],
    source: "dataset fried tilapia 28 g protein/100 g (AR, low), ~150 g edible", confidence: "low",
  }),
  fish_roasted: C({
    id: "fish_roasted", label: "roasted fish", proteinG: 20, fibreG: 0, kcal: 160, heat: 2, sweet: false, prep: "roasted", base: false,
    allergens: ["fish"], fish: true, slots: ["lunch", "dinner"], aliases: ["fish", "round fish", "roasted fish"],
    source: "dataset fish 28 g protein/100 g (AR, low), ~70 g edible, EST", confidence: "low",
  }),
  beef: C({
    id: "beef", label: "beef", proteinG: 9, fibreG: 0, kcal: 75, heat: 1, sweet: false, prep: "fried", base: false,
    allergens: [], meat: true, slots: ["lunch", "dinner"], aliases: ["beef", "meat"],
    source: "dataset cooked beef 28.8 g protein/100 g (AR, low), ~30 g piece", confidence: "low",
  }),
  ponmo: C({
    id: "ponmo", label: "ponmo", proteinG: 9, fibreG: 0, kcal: 90, heat: 1, sweet: false, prep: "boiled", base: false,
    allergens: [], meat: true, slots: ["lunch", "dinner"], aliases: ["ponmo", "kpomo", "cow skin"],
    source: "dataset ponmo 46.9 g/100 g (FN, high); counted at half as incomplete collagen protein, ~40 g piece", confidence: "medium",
  }),
  gizzard: C({
    id: "gizzard", label: "gizzard", proteinG: 18, fibreG: 0, kcal: 95, heat: 2, sweet: false, prep: "fried", base: false,
    allergens: [], meat: true, slots: ["lunch", "dinner", "snack"], aliases: ["gizzard", "gizz"],
    source: "dataset gizdodo 12-16 g/100 g (EST, low); gizzard alone EST, ~60 g", confidence: "low",
  }),
  kebab: C({
    id: "kebab", label: "kebab", proteinG: 17, fibreG: 0, kcal: 165, heat: 2, sweet: false, prep: "grilled", base: false,
    allergens: [], mayContain: ["groundnut"], meat: true, slots: ["lunch", "dinner", "snack"], aliases: ["kebab", "suya", "skewer"],
    source: "dataset suya 1 skewer = 165 kcal, 22 g protein/100 g (FS, medium); yaji spice may contain groundnut", confidence: "medium",
  }),
  egg: C({
    id: "egg", label: "egg", proteinG: 6, fibreG: 0, kcal: 80, heat: 0, sweet: false, prep: "fried", base: false,
    allergens: ["egg"], slots: ["breakfast", "lunch", "dinner"], aliases: ["egg", "eggs"],
    source: "dataset egg ~75 kcal, 6 g protein each (EST/FS)", confidence: "medium",
  }),
  sausage: C({
    id: "sausage", label: "sausage", proteinG: 4, fibreG: 0, kcal: 110, heat: 0, sweet: false, prep: "fried", base: false,
    allergens: [], mayContain: ["gluten"], meat: true, processed: true, highSodium: true, slots: ["breakfast", "lunch", "dinner", "snack"],
    aliases: ["sausage", "sausages", "hot dog"], source: "EST (not in dataset; ~35 g sausage)", confidence: "low",
  }),
  pepperoni: C({
    id: "pepperoni", label: "pepperoni", proteinG: 6, fibreG: 0, kcal: 150, heat: 1, sweet: false, prep: "baked", base: false,
    allergens: [], meat: true, processed: true, highSodium: true, slots: ["lunch", "dinner"], aliases: ["pepperoni"],
    source: "EST", confidence: "low",
  }),
  cheese: C({
    id: "cheese", label: "cheese", proteinG: 7, fibreG: 0, kcal: 110, heat: 0, sweet: false, prep: "topping", base: false,
    allergens: ["dairy"], slots: ["lunch", "dinner", "snack"], aliases: ["cheese"], source: "EST", confidence: "low",
  }),

  // ---- sauces ----
  egg_sauce: C({
    id: "egg_sauce", label: "egg sauce", proteinG: 6, fibreG: 1, kcal: 130, heat: 1, sweet: false, prep: "sauce", base: false,
    allergens: ["egg"], slots: ["breakfast", "lunch", "dinner"], aliases: ["egg sauce", "egg"],
    source: "dataset yam and egg sauce (EST, low)", confidence: "low",
  }),
  pepper_sauce: C({
    id: "pepper_sauce", label: "pepper sauce", proteinG: 0.5, fibreG: 1, kcal: 70, heat: 3, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner", "snack"], aliases: ["pepper sauce", "pepper"],
    source: "dataset: bole pepper sauce heat 3 (editorial)", confidence: "low",
  }),
  pepper_stew: C({
    id: "pepper_stew", label: "pepper stew", proteinG: 1, fibreG: 1, kcal: 90, heat: 3, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["pepper stew", "stew", "pepper"],
    source: "dataset: stew heat 2-3 (editorial)", confidence: "low",
  }),
  fish_sauce: C({
    id: "fish_sauce", label: "fish sauce", proteinG: 4, fibreG: 1, kcal: 90, heat: 2, sweet: false, prep: "sauce", base: false,
    allergens: ["fish"], fish: true, slots: ["lunch", "dinner"], aliases: ["fish sauce"],
    source: "dataset: bole with fish and pepper sauce (editorial)", confidence: "low",
  }),
  tomato_sauce: C({
    id: "tomato_sauce", label: "sauce", proteinG: 0.5, fibreG: 1, kcal: 70, heat: 1, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["sauce", "stew"], source: "EST", confidence: "low",
  }),

  // ---- campus (buka / cafeteria) foods from the dataset; one serving = one unit as sold (spoon, wrap, piece, portion) ----
  rice_white: C({
    id: "rice_white", label: "white rice", proteinG: 3.5, fibreG: 0.5, kcal: 156, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["rice", "white rice"],
    source: "dataset white rice ~130 kcal, 2.9 g protein/100 g (AR, low); ~120 g spoon", confidence: "low",
  }),
  jollof_rice: C({
    id: "jollof_rice", label: "jollof rice", proteinG: 3.1, fibreG: 1, kcal: 174, heat: 2, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["jollof", "jollof rice", "rice"],
    source: "dataset jollof 145 kcal, 2.6 g protein/100 g (FN, high); ~120 g spoon", confidence: "high",
  }),
  fried_rice: C({
    id: "fried_rice", label: "fried rice", proteinG: 3.1, fibreG: 1.3, kcal: 208, heat: 1, sweet: false, prep: "fried", base: true,
    allergens: [], mayContain: ["egg", "shellfish"], slots: ["lunch", "dinner"], aliases: ["fried rice", "rice"],
    source: "dataset fried rice 173 kcal, 1.1 g fibre/100 g (FN, high); ~120 g spoon", confidence: "high",
  }),
  rice_beans: C({
    id: "rice_beans", label: "rice and beans", proteinG: 5.5, fibreG: 3, kcal: 156, heat: 1, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["rice and beans", "rice & beans", "beans", "rice"],
    source: "dataset rice (AR) and beans (AR) mixed; fibre EST; ~120 g spoon", confidence: "low",
  }),
  beans: C({
    id: "beans", label: "beans", proteinG: 10, fibreG: 6, kcal: 156, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["breakfast", "lunch", "dinner"], aliases: ["beans", "ewa"],
    source: "dataset boiled beans ~130 kcal, 8.5 g protein/100 g (AR, low); fibre EST; ~120 g spoon", confidence: "low",
  }),
  ewa_agoyin: C({
    id: "ewa_agoyin", label: "ewa agoyin", proteinG: 16, fibreG: 10, kcal: 350, heat: 4, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["breakfast", "lunch"], aliases: ["agoyin", "ewa agoyin", "beans"],
    source: "dataset ewa agoyin 150-200 kcal, 7-9 g protein/100 g (EST, low); ~200 g portion with sauce", confidence: "low",
  }),
  beans_porridge: C({
    id: "beans_porridge", label: "beans porridge", proteinG: 8, fibreG: 6, kcal: 267, heat: 2, sweet: false, prep: "boiled", base: true,
    allergens: [], mayContain: ["fish", "shellfish"], slots: ["lunch", "dinner"], aliases: ["beans porridge", "porridge", "beans"],
    source: "dataset beans porridge 178 kcal/100 g (AR, low); ~150 g spoon", confidence: "low",
  }),
  yam_porridge: C({
    id: "yam_porridge", label: "yam porridge", proteinG: 6, fibreG: 6, kcal: 375, heat: 2, sweet: false, prep: "boiled", base: true,
    allergens: [], mayContain: ["fish", "shellfish"], slots: ["lunch", "dinner"], aliases: ["yam porridge", "asaro", "porridge", "yam"],
    source: "dataset yam porridge 100-150 kcal/100 g (EST, low); ~300 g portion", confidence: "low",
  }),
  yam_boiled: C({
    id: "yam_boiled", label: "boiled yam", proteinG: 1.5, fibreG: 4, kcal: 117, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["breakfast", "lunch", "dinner"], aliases: ["boiled yam", "yam"],
    source: "dataset boiled yam 116-118 kcal/100 g (FS, medium); fibre EST; ~100 g slice", confidence: "medium",
  }),
  spaghetti: C({
    id: "spaghetti", label: "spaghetti", proteinG: 7, fibreG: 2, kcal: 190, heat: 1, sweet: false, prep: "boiled", base: true,
    allergens: ["gluten"], slots: ["lunch", "dinner"], aliases: ["spaghetti", "pasta"],
    source: "dataset spaghetti ~158 kcal, 5.8 g protein/100 g (EST, low); ~120 g spoon", confidence: "low",
  }),
  indomie: C({
    id: "indomie", label: "Indomie", proteinG: 8, fibreG: 2, kcal: 350, heat: 1, sweet: false, prep: "boiled", base: true,
    allergens: ["gluten"], highSodium: true, slots: ["breakfast", "lunch", "dinner", "snack"], aliases: ["indomie", "noodles"],
    source: "dataset Indomie 70 g pack 285-400 kcal, 7-9 g protein (PKG, high for range)", confidence: "medium",
  }),
  eba: C({
    id: "eba", label: "eba", proteinG: 2, fibreG: 3, kcal: 360, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["eba", "garri", "swallow"],
    source: "dataset eba restaurant portion 200 g = 360 kcal (AR, low)", confidence: "low",
  }),
  amala: C({
    id: "amala", label: "amala", proteinG: 0.6, fibreG: 5, kcal: 178, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["amala", "swallow"],
    source: "dataset amala 89 kcal, 2.5 g fibre/100 g (FN, high); ~200 g wrap", confidence: "high",
  }),
  pounded_yam: C({
    id: "pounded_yam", label: "pounded yam", proteinG: 4, fibreG: 4, kcal: 450, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["pounded yam", "iyan", "poundo", "swallow"],
    source: "dataset pounded yam 109-262 kcal/100 g (PU/FS, medium; mid value); ~250 g wrap", confidence: "low",
  }),
  fufu: C({
    id: "fufu", label: "fufu", proteinG: 1, fibreG: 2, kcal: 284, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["fufu", "akpu", "swallow"],
    source: "dataset fufu 142 kcal/100 g (PU, medium); ~200 g wrap", confidence: "medium",
  }),
  semo: C({
    id: "semo", label: "semo", proteinG: 6, fibreG: 2, kcal: 320, heat: 0, sweet: false, prep: "boiled", base: true,
    allergens: ["gluten"], slots: ["lunch", "dinner"], aliases: ["semo", "semovita", "swallow"],
    source: "EST (dataset data gap); ~200 g wrap", confidence: "low",
  }),
  ofada_ayamase: C({
    id: "ofada_ayamase", label: "ofada rice and ayamase", proteinG: 14, fibreG: 4, kcal: 650, heat: 4, sweet: false, prep: "boiled", base: true,
    allergens: [], meat: true, slots: ["lunch"], aliases: ["ofada", "ayamase", "designer stew"],
    source: "dataset ofada with ayamase 170-230 kcal/100 g (EST, low); ~320 g portion", confidence: "low",
  }),
  bread: C({
    id: "bread", label: "bread", proteinG: 9, fibreG: 2.5, kcal: 265, heat: 0, sweet: false, prep: "baked", base: true,
    allergens: ["gluten"], mayContain: ["dairy", "egg"], slots: ["breakfast", "lunch", "snack"], aliases: ["bread"],
    source: "dataset white bread ~265 kcal/100 g (EST, low); ~100 g", confidence: "low",
  }),
  moi_moi: C({
    id: "moi_moi", label: "moi moi", proteinG: 10, fibreG: 3, kcal: 162, heat: 1, sweet: false, prep: "boiled", base: true,
    allergens: [], mayContain: ["egg", "fish"], slots: ["breakfast", "lunch", "dinner", "snack"], aliases: ["moi moi", "moimoi", "moin moin"],
    source: "dataset moi moi 108 kcal, 6.5 g protein/100 g (FN, high); ~150 g wrap; fibre EST", confidence: "medium",
  }),
  akara: C({
    id: "akara", label: "akara", proteinG: 3.6, fibreG: 1, kcal: 66, heat: 1, sweet: false, prep: "fried", base: true,
    allergens: [], slots: ["breakfast", "snack"], aliases: ["akara", "bean cake", "kosai"],
    source: "dataset akara 220 kcal, 12.1 g protein/100 g (FN, high); ~30 g ball", confidence: "high",
  }),
  abacha: C({
    id: "abacha", label: "abacha", proteinG: 14, fibreG: 6, kcal: 500, heat: 2, sweet: false, prep: "boiled", base: true,
    allergens: [], mayContain: ["fish", "shellfish"], slots: ["lunch", "snack"], aliases: ["abacha", "african salad"],
    source: "dataset abacha 150-250 kcal/100 g (EST, low); ~250 g portion", confidence: "low",
  }),
  pepper_soup: C({
    id: "pepper_soup", label: "pepper soup", proteinG: 25, fibreG: 1, kcal: 250, heat: 4, sweet: false, prep: "boiled", base: true,
    allergens: [], mayContain: ["fish", "shellfish"], meat: true, slots: ["dinner", "snack"], aliases: ["pepper soup", "goat meat pepper soup", "catfish pepper soup"],
    source: "dataset pepper soup 40-90 kcal/100 g (EST, low) plus meat; bowl", confidence: "low",
  }),
  egusi: C({
    id: "egusi", label: "egusi soup", proteinG: 21, fibreG: 4.6, kcal: 273, heat: 2, sweet: false, prep: "sauce", base: false,
    allergens: [], mayContain: ["fish", "shellfish"], meat: true, slots: ["lunch", "dinner"], aliases: ["egusi", "melon soup", "soup"],
    source: "dataset egusi 182 kcal, 14.3 g protein/100 g (FS, medium); ~150 g portion", confidence: "medium",
  }),
  efo_riro: C({
    id: "efo_riro", label: "efo riro", proteinG: 10, fibreG: 7, kcal: 188, heat: 3, sweet: false, prep: "sauce", base: false,
    allergens: [], mayContain: ["fish", "shellfish"], meat: true, slots: ["lunch", "dinner"], aliases: ["efo", "efo riro", "vegetable soup", "vegetable", "spinach", "soup"],
    source: "dataset efo riro 100-150 kcal/100 g (EST, low); ~150 g portion", confidence: "low",
  }),
  ewedu: C({
    id: "ewedu", label: "ewedu", proteinG: 4, fibreG: 6, kcal: 45, heat: 0, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["ewedu", "soup"],
    source: "dataset ewedu 20-40 kcal/100 g (EST, low); ~150 g portion", confidence: "low",
  }),
  gbegiri: C({
    id: "gbegiri", label: "gbegiri", proteinG: 9, fibreG: 4, kcal: 165, heat: 1, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["gbegiri", "soup"],
    source: "dataset gbegiri 90-130 kcal/100 g (EST, low); ~150 g portion", confidence: "low",
  }),
  stew: C({
    id: "stew", label: "stew", proteinG: 1, fibreG: 1, kcal: 90, heat: 2, sweet: false, prep: "sauce", base: false,
    allergens: [], slots: ["lunch", "dinner"], aliases: ["stew", "tomato stew"],
    source: "dataset: rice and stew heat 2 (editorial); EST", confidence: "low",
  }),
  shaki: C({
    id: "shaki", label: "shaki", proteinG: 6, fibreG: 0, kcal: 46, heat: 1, sweet: false, prep: "boiled", base: false,
    allergens: [], meat: true, slots: ["lunch", "dinner"], aliases: ["shaki", "tripe"],
    source: "dataset shaki 89-94 kcal, 11.7-12.6 g protein/100 g (FS, medium); ~50 g piece", confidence: "medium",
  }),

  // ---- campus snacks and street food (dataset 3.6, 3.5) ----
  puff_puff: C({
    id: "puff_puff", label: "puff puff", proteinG: 1.5, fibreG: 0.5, kcal: 80, heat: 0, sweet: true, prep: "fried", base: true,
    allergens: ["gluten"], slots: ["breakfast", "snack"], aliases: ["puff puff", "puff-puff", "bofrot"],
    source: "dataset puff puff 50-80 kcal per ball (EST, low)", confidence: "low",
  }),
  doughnut: C({
    id: "doughnut", label: "doughnut", proteinG: 4, fibreG: 1, kcal: 280, heat: 0, sweet: true, prep: "fried", base: true,
    allergens: ["gluten", "egg", "dairy"], slots: ["breakfast", "snack"], aliases: ["doughnut", "donut"],
    source: "dataset doughnut 370-420 kcal/100 g (EST, low); ~70 g", confidence: "low",
  }),
  meat_pie: C({
    id: "meat_pie", label: "meat pie", proteinG: 9, fibreG: 1.5, kcal: 350, heat: 1, sweet: false, prep: "baked", base: true,
    allergens: ["gluten"], mayContain: ["egg", "dairy"], meat: true, slots: ["breakfast", "lunch", "snack"], aliases: ["meat pie", "pie"],
    source: "dataset meat pie 217 kcal, 8.1 g protein/100 g (FS, medium); one 111 g pie = 353 kcal", confidence: "medium",
  }),
  sausage_roll: C({
    id: "sausage_roll", label: "sausage roll", proteinG: 7, fibreG: 1, kcal: 280, heat: 0, sweet: false, prep: "baked", base: true,
    allergens: ["gluten", "egg"], meat: true, processed: true, slots: ["breakfast", "snack"], aliases: ["sausage roll", "sausage"],
    source: "dataset sausage roll 330-380 kcal/100 g (EST, low); ~80 g", confidence: "low",
  }),
  suya: C({
    id: "suya", label: "suya", proteinG: 22, fibreG: 0, kcal: 207, heat: 3, sweet: false, prep: "grilled", base: true,
    allergens: ["groundnut"], meat: true, highSodium: true, slots: ["dinner", "snack"], aliases: ["suya", "kebab", "skewer"],
    source: "dataset suya 207 kcal, 22 g protein/100 g, yaji contains groundnut (FS, medium); ~100 g portion", confidence: "medium",
  }),

  // ---- sweet toppings ----
  ice_cream: C({ id: "ice_cream", label: "ice cream", proteinG: 2, fibreG: 0, kcal: 140, heat: 0, sweet: true, prep: "topping", base: false, allergens: ["dairy"], slots: ["breakfast", "snack"], aliases: ["ice cream"], source: "EST", confidence: "low" }),
  jam: C({ id: "jam", label: "jam", proteinG: 0, fibreG: 0, kcal: 60, heat: 0, sweet: true, prep: "topping", base: false, allergens: [], slots: ["breakfast", "snack"], aliases: ["jam"], source: "EST", confidence: "low" }),
  chocolate: C({ id: "chocolate", label: "chocolate", proteinG: 1, fibreG: 1, kcal: 110, heat: 0, sweet: true, prep: "topping", base: false, allergens: ["dairy"], slots: ["breakfast", "snack"], aliases: ["chocolate", "m&m", "m&ms", "chocolate chips"], source: "EST", confidence: "low" }),
  nutella: C({ id: "nutella", label: "Nutella", proteinG: 1.5, fibreG: 1, kcal: 110, heat: 0, sweet: true, prep: "topping", base: false, allergens: ["tree_nut", "dairy"], slots: ["breakfast", "snack"], aliases: ["nutella", "hazelnut"], source: "EST", confidence: "low" }),
  peanut_butter: C({ id: "peanut_butter", label: "peanut butter", proteinG: 4, fibreG: 1, kcal: 100, heat: 0, sweet: true, prep: "topping", base: false, allergens: ["groundnut"], slots: ["breakfast", "snack"], aliases: ["peanut butter", "groundnut"], source: "EST", confidence: "low" }),
  sweet_topping: C({ id: "sweet_topping", label: "sweet topping", proteinG: 0.5, fibreG: 0, kcal: 80, heat: 0, sweet: true, prep: "topping", base: false, allergens: [], mayContain: ["gluten", "dairy"], slots: ["breakfast", "snack"], aliases: ["marshmallow", "oreo", "oreos", "sprinkles"], source: "EST", confidence: "low" }),
};

export const COMPONENT_IDS = Object.keys(COMPONENTS);
