# Dine meal recommender: backend integration guide

Nov 10, 2026 · Dozie (AI Engineer)

## Summary

The bot collects the user's button answers and optional note, calls one function, `recommend()`, and gets back ready-to-show meal suggestions. The AI side is built and tested (19 tests passing) but not yet wired into the bot. This doc is everything the backend needs to wire it in.

**What it does**

- Suggests meals from two sources:
  - **Campus meals** from the Nigerian university foods dataset (rice and beans, eba and egusi, moi moi, akara, pepper soup and so on). These can't be ordered through Dine. They come with no label, vendor, quantity or price; the student buys as much as their budget allows.
  - **Prime meals**, from the Prime bot's menu (183 items, 16 vendors). These can be ordered through Dine and come with the exact cart items, vendor and prices, plus an "Order on Dine" label.
- Supports **eat now** (3 options for the current time of day) and **timetable** (chosen days × 1, 2 or 3 meals a day, with 2 swap options per meal).
- Applies the budget **per meal**.
- Prime only sells in the evening, so Prime meals are only suggested for dinner, or for "eat now" in the evening. Even then they're only included when they genuinely fit the user, never forced in.
- Reads the optional free-text note with an LLM (Gemini), backed by a keyword reader. Allergies and "no X" requests become hard filters.

**Where it lives:** `packages/ai/src/recommend/` in the `@dine/ai` package (branch `context-engineering`). Import from `@dine/ai/src/recommend/index.js`, or re-export it from `@dine/ai`.

**Who owns what**

| Area | Owner |
| --- | --- |
| Buttons, flow, sessions, callback data, Telegram messages | Backend |
| Live vendor status, current time, ordering and the cart | Backend |
| Picking and ranking meals, reading the note, nutrition and food data | AI (this package) |
| Prime menu snapshot and campus food list | AI, refreshed together (see "What the backend needs to provide") |

## Bot flow and button codes

Every answer except the final note is a button tap. Use the codes below as your callback values so both sides agree; they're exported from `types.ts` as `GOALS`, `CRAVINGS` and `DAYS`, so you can build keyboards straight from those arrays.

1. **Mode:** "Eat now" (`now`) or "Plan a timetable" (`timetable`).
2. **Timetable only: days.** Multi-select from `mon` `tue` `wed` `thu` `fri` `sat` `sun`.
3. **Timetable only: meals per day.** `1`, `2` or `3`. These map to dinner; lunch + dinner; or breakfast + lunch + dinner. Default is 3.
4. **Goals** (multi-select, optional).
5. **Cravings** (multi-select, optional).
6. **Budget per meal**, in whole naira, from your preset buttons.
7. **Optional note:** "Anything else you'd like to add?" This is the only free text. Let the user skip it.

| Step | Code | Button text suggestion |
| --- | --- | --- |
| Goal | `protein_rich` | High protein |
| Goal | `high_fibre` | More fibre |
| Goal | `healthy` | Healthy |
| Goal | `light` | Light / weight loss |
| Goal | `bulk` | Bulking / big appetite |
| Craving | `sweet` | Something sweet |
| Craving | `filling` | Heavy and filling |
| Craving | `spicy` | Spicy |
| Craving | `savoury` | Savoury |
| Craving | `snack` | Just a snack |
| Craving | `surprise` | Surprise me |

Notes:

- Goals and cravings can be empty. With none chosen, it favours a filling, good-value meal.
- The budget is a single number per meal. If a button means a range (e.g. "₦1,000 – ₦2,000"), send the top of the range.
- Drop the old "✏️ Type My Exact Budget" step; typed text is limited to the note.

## Calling recommend()

Call `recommend(request, options)` once the user has answered (after the note, or after they skip it). It's async because reading the note may call the LLM. It normally returns in under a second without a note, and about 2 seconds with one.

**Request (`RecommendRequest`)**

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `mode` | `"now"` or `"timetable"` | Yes | Eat now, or plan a timetable |
| `budgetPerMeal` | number (naira) | Yes | Budget for one meal |
| `goals` | `Goal[]` | No | Codes from the table above |
| `cravings` | `Craving[]` | No | Codes from the table above |
| `days` | `Day[]` | Timetable | Days to plan; defaults to `["mon"]` |
| `mealsPerDay` | `1`, `2` or `3` | Timetable | Defaults to 3 |
| `note` | string | No | The free-text note; up to 500 characters are read |
| `excludeMealKeys` | string[] | No | Keys of meals already shown, for "show me others" |
| `seed` | number | No | Changes "surprise me" picks between rerolls |

**Options (`RecommendOptions`)**

| Option | Default | What to pass |
| --- | --- | --- |
| `now` | the server clock | The current time. Eat-now mode uses it (in Lagos time) to pick the meal: breakfast before 11:00, lunch 11:00 to 16:00, dinner after 16:00. It also decides whether Prime is selling. |
| `isVendorOpen` | the crawl's snapshot (19 Oct) | `(vendorId) => boolean` from live Prime status. Strongly recommended. |
| `primeHours` | `{ from: 16, to: 24 }` | Hours Prime sells, Lagos time, `[from, to)`. Placeholder until we confirm the real hours. |
| `useModel` | `true` | Set `false` to skip the LLM and use only the keyword reader (e.g. in tests). |
| `menu` | the bundled snapshot | Only if you load the Prime menu yourself. |

**Example (grammY handler)**

```ts
import { recommend, type RecommendRequest } from "@dine/ai/src/recommend/index.js";

const req: RecommendRequest = {
  mode: session.mode,                 // "now" | "timetable"
  days: session.days,                 // e.g. ["mon", "tue", "wed"]
  mealsPerDay: session.mealsPerDay,   // 1 | 2 | 3
  goals: session.goals,               // e.g. ["protein_rich"]
  cravings: session.cravings,         // e.g. ["spicy"]
  budgetPerMeal: session.budget,      // e.g. 3000
  note: session.note,                 // optional free text
  excludeMealKeys: session.shownKeys, // for rerolls
};

const result = await recommend(req, {
  now: new Date(),
  isVendorOpen: (id) => primeStatus.get(id) === "open",
});
```

`recommend()` doesn't throw on model problems: if Gemini is down or slow it falls back to the keyword reader. It can still throw on programming errors, so keep your usual try/catch and "something went wrong" reply.

## The result

The result is either `{ mode: "now", options }` (up to 3 suggestions) or `{ mode: "timetable", days }`, where each day lists its meals, each with a `pick` and up to 2 `alternatives`. Both also carry `note`, `notices` and `menuAsOf`.

**Each suggestion (`MealSuggestion`)**

| Field | Prime meal | Campus meal | Use it for |
| --- | --- | --- | --- |
| `key` | e.g. `prime\|slash_shawarma\|Shawarma + 2 Sausages` | e.g. `campus\|rice_beans` | Rerolls, and looking the meal up when a button is tapped. Long, so keep it server-side. |
| `name` | The main item, e.g. "Super Pack: Chicken + 2 Sausages" | The dish, e.g. "Rice and beans with fish and dodo" | The meal's title |
| `orderable` | `true` | `false` | Whether to show order buttons |
| `orderLabel` | `"Order on Dine"` | absent | The label. Campus meals get no label at all. |
| `vendorId`, `vendorName`, `location` | set | absent | Which Prime vendor to order from |
| `items` | `[{ name, price }]`: the exact cart items | `[{ name }]`: what's on the plate, no prices or quantities | Cart contents (Prime); optional detail (campus) |
| `totalPrice` | set, always ≤ the budget | absent | Showing the price |
| `reasons` | list of strings | list of strings | Why it was picked, e.g. "High in protein (est. ~52 g)", "Hot and peppery", "Has fish, as you asked". Prime meals also get "₦X of your ₦Y budget". |
| `warnings` | list of strings | list of strings | Allergens, e.g. "May contain: groundnut, gluten (wheat)", and the pork check for sausage and pepperoni |
| `estimates` | `{ proteinG, fibreG, kcal, heat, confidence }` | same | Optional. These are rough estimates, so label them that way if you show them. `heat` is 0–4. |

**Example (eat now, 7:30pm, ₦3,000, protein goal)**

```json
{
  "mode": "now",
  "options": [
    {
      "key": "campus|amala_efo_riro",
      "name": "Amala and efo riro with fish and chicken",
      "orderable": false,
      "items": [{ "name": "Amala" }, { "name": "Efo riro" }, { "name": "Fish" }, { "name": "Chicken" }],
      "reasons": ["High in protein (est. ~61 g)"],
      "warnings": ["May contain: fish, shellfish"]
    },
    {
      "key": "prime|burritos|Super Pack: Chicken + 2 Sausages",
      "name": "Super Pack: Chicken + 2 Sausages",
      "orderable": true,
      "orderLabel": "Order on Dine",
      "vendorId": "burritos",
      "vendorName": "Burritos",
      "location": "outside_cafeteria",
      "items": [{ "name": "Super Pack: Chicken + 2 Sausages", "price": 3000 }],
      "totalPrice": 3000,
      "reasons": ["High in protein (est. ~51 g)", "₦3,000 of your ₦3,000 budget"],
      "warnings": ["May contain: gluten (wheat)", "Has sausage or pepperoni; ask the vendor if it contains pork"]
    }
  ],
  "notices": ["Nutrition figures are rough estimates."],
  "note": { "parsedBy": "none", "unhandled": [] },
  "menuAsOf": "2026-10-19T14:33:05Z"
}
```

(`estimates` and some `note` fields are trimmed above.)

**Timetable shape**

```json
{
  "mode": "timetable",
  "days": [
    { "day": "mon", "meals": [
      { "slot": "breakfast", "pick": { }, "alternatives": [{ }, { }] },
      { "slot": "lunch",     "pick": { }, "alternatives": [{ }, { }] },
      { "slot": "dinner",    "pick": { }, "alternatives": [{ }, { }] }
    ]}
  ]
}
```

`pick` is `null` only when nothing fits the budget and preferences; there's a notice when that happens.

**Result-level fields**

- `notices`: short sentences to show under the results, e.g. "Couldn't apply from your note: "can it come before 8"." and "Nutrition figures are rough estimates." Show them all.
- `note`: how the note was understood: `excludeAllergens`, `excludeComponents`, `excludeVendors`, `preferComponents`, `preferVendors`, `vegetarian`, `noPork`, `maxHeat`, `minHeat`, `unhandled`, `parsedBy` (`none`, `rules` or `model`). Useful for logs or a "Got it: no groundnut, no amala" confirmation line.
- `menuAsOf`: when the Prime menu snapshot was taken.

## Showing results in Telegram

The rule we agreed: **Prime meals get an "Order on Dine" label, price and order button; campus meals get nothing extra**. A campus meal is just its name and why it fits, with no label, vendor, price, quantity or "not available" text.

**Suggested eat-now message**

```
Here are 3 picks for dinner (₦3,000 per meal):

1. Amala and efo riro with fish and chicken
   High in protein (est. ~61 g)
   May contain: fish, shellfish

2. Beans porridge with fish
   High in protein (est. ~54 g)
   May contain: fish, shellfish

3. Super Pack: Chicken + 2 Sausages
   Order on Dine · Burritos · ₦3,000
   High in protein (est. ~51 g)
   May contain: gluten (wheat)

Nutrition figures are rough estimates.
```

Buttons under it:

- One "🛒 Order #3 on Dine" button per orderable meal only. Campus meals get no button.
- "🎲 Show me others" (reroll).
- "🔙 Start over".

**Timetable message:** one message per day, or one per week if it fits. List each slot (Breakfast / Lunch / Dinner) with the pick's name and its first reason. Prime dinners show their "Order on Dine" line. Add a "🔁 Swap" button per meal that cycles through that meal's `alternatives`. Telegram's 4,096-character limit means a 7-day, 3-meal plan should be split by day.

**Rerolls ("show me others")**

1. Keep a list of every `key` you've shown in the session.
2. Call `recommend()` again with the same answers and `excludeMealKeys: shownKeys` (and `seed: rerollCount` so "surprise me" changes too).
3. Add the new keys to the list. When `options` comes back empty, offer "Start over" or a bigger budget.

**Callback data (64-byte limit)**

- Don't put `key`s or item names in `callback_data`. Prime keys run past 64 bytes; you hit this before (`BUTTON_DATA_INVALID`).
- Store the last result in the user's session, and use short positional callbacks, e.g. `ord:2` (order option 3), `rr` (reroll), `sw:1:2` (swap day 2, slot 3).
- On tap, look the meal up in the stored result.

**Formatting**

- Names contain characters that break Telegram's legacy Markdown, e.g. `(`, `+`, `&` in "M&M's", and `_`.
- Use `parse_mode: "HTML"` and escape `&`, `<` and `>`, or MarkdownV2 with full escaping.

## Ordering a Prime meal

An orderable suggestion is already a valid Prime cart: every item is from one vendor (`vendorId` / `vendorName`), and the names and prices are exactly as they appear on Prime's menu.

- **Cart contents:** add each entry in `items` once (quantity 1 each). A suggestion is a main item plus at most 2 extras from the same vendor, e.g. `Boli, Yam & Potato (Regular)` + `Round Fish` + `Gizzard (Large)`.
- **Tray:** if you keep the current tray, push each item with its `vendorName` and `price`. `totalPrice` equals the sum of the item prices.
- **Ordering agent:** `DineOrderingAgent.placeOrder()` in `packages/ai/src/agent.ts` takes `{ vendorName, itemName }`, one item. For multi-item meals it needs extending to add several items before checkout. Tell me if you want me to do that.
- **Plastic Pack:** some vendors list "Plastic Pack — ₦200". The recommender never adds it and leaves it out of `totalPrice`. If Prime requires it at checkout, the backend should add it and show the extra ₦200 before payment. The total can then go ₦200 over the user's budget. We need to decide how to handle that (see "Open questions").
- **Before checkout:** re-check that the vendor is open and the prices haven't changed. Our menu is a snapshot, so a stale price or a removed item is possible.

## What the backend needs to provide

The recommender only knows what's in its snapshot, so four live inputs come from the backend.

| Input | Why it matters | How |
| --- | --- | --- |
| Current time | Eat-now mode picks breakfast, lunch or dinner from it, and Prime is only suggested during Prime's hours. | Pass `now: new Date()`. The server's timezone doesn't matter; it's converted to Lagos time. |
| Live vendor status | The snapshot's open/closed values are from 19 Oct (14 open, 2 closed). Suggesting a closed vendor breaks the order. | Pass `isVendorOpen(vendorId)`. Vendor ids are slugs of Prime names, e.g. `slash_shawarma`, `dg_and_g_boli`, `6_33_pizza_republic`. Full list: `packages/ai/src/recommend/data/prime-menu.json`. |
| Prime's selling hours | Decides when Prime meals can appear. | Confirm the real hours; until then we assume 16:00 to midnight (`primeHours`). |
| Menu changes | New or renamed items are invisible until the snapshot is refreshed. | Tell the AI side when Prime's menu changes. We re-run the crawl, then `pnpm --filter @dine/ai menu:extract` and `menu:check` (which flags any item name it can't understand). |

If you already fetch Prime's vendor list live for "Browse Vendors", the same data can feed `isVendorOpen`. Longer term, we could pass the live menu in as `menu` instead of using the snapshot.

## Replacing the old code in apps/api

`apps/api/src/engine/recommender.ts` and `apps/api/src/data/vendors.ts` should be retired once `recommend()` is wired in.

**Why `vendors.ts` is out of date**

It doesn't match Prime's menu:

- It lists vendors that don't exist, e.g. "Ice Vendor".
- Prices differ from the crawl, e.g. Grandpa Chips egg ₦200 vs ₦300, beef ₦400 vs ₦200, Delish Yamarita sausage ₦400 vs ₦300.
- It invents combos, e.g. "Chips + Fried Chicken ₦2,300".

Recommending from it would show users items and prices they can't actually order.

**What changes in `index.ts`**

| Today | After |
| --- | --- |
| Budget brackets + "Type My Exact Budget" | Preset budget buttons sending one number per meal; no typed budget |
| One craving (`crv:...`) | Goals and cravings (multi-select), plus mode, days and meals per day |
| `recommendMeals(budget, craving, seed)` | `await recommend(request, options)` |
| `Recommendation { badge, title, vendorName, price, reason }` | `MealSuggestion` (see "The result"); every suggestion now has `orderable`, `reasons[]` and `warnings[]` |
| Every pick is a vendor item | Campus meals have no vendor and no price; only `orderable` ones go to the tray |
| "Browse Vendors" paging over `VENDORS` | Read vendors from `loadPrimeMenu()` (or your live source) |

The old badges ("🥇 Top Pick", "🥈 Smart Value", "🥉 Alternative Vibe") can stay as decoration by position, but the reason line should come from `reasons`.

## Setup, running and testing

**Environment (`.env` at the repo root)**

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash-lite,gemini-3.8-flash
```

- `GEMINI_MODEL` is a comma-separated list, tried in order, 6 seconds each.
- We put the lite model first because `gemini-3.8-flash` kept returning 503 "high demand" during testing.
- With no key, or if every model fails, the keyword reader handles the note alone. Allergies and "no X" requests still apply; only the subtler readings are lost.
- The bot needs no other new env vars.

**Try it from the terminal** (in `packages/ai`)

```
pnpm recommend --budget 3000 --goals protein_rich --at 19:30
pnpm recommend --mode timetable --days mon,tue,wed --meals 3 --budget 2500 --goals healthy
pnpm recommend --budget 2000 --note "allergic to groundnut, no amala" --json
```

- `--at` sets the time of day.
- `--no-model` skips the LLM.
- `--json` prints the exact object the bot will receive.

**Tests**

```
node --import tsx --test src/recommend/recommend.test.ts
```

The 19 tests cover:

- every Prime item being understood;
- Prime prices matching the menu, and totals staying within budget;
- only Prime meals being orderable;
- no Prime meals outside evening hours, and Prime never forced in when it fits badly;
- allergen and food exclusions;
- rerolls;
- timetable slots and variety;
- the note reader.

`pnpm test` does the same; on one dev machine the global pnpm install is broken, hence the direct command.

**Performance:** without a note, a call is pure computation, roughly tens of milliseconds for a 7-day timetable. A note adds one LLM call (about 1–2 s on the lite model, up to 6 s per model if one times out). Consider showing "Finding meals…" while it runs.

**Known wrinkle:** `tsc` reports `import.meta` errors across `@dine/ai` (old files too) because the package isn't marked `"type": "module"`. It runs fine under `tsx`. If the bot is ever compiled with `tsc`, we should switch the package to ESM together.

## Open questions

These need an answer before or during the wiring; tick them off as they're settled.

- [ ] **Prime's selling hours.** What are the real hours? We assume 16:00 to midnight Lagos time.
- [ ] **Live vendor status.** Can the backend get open/closed per Prime vendor at request time? If so, pass it as `isVendorOpen`.
- [ ] **Plastic Pack.** Is the ₦200 pack required at checkout? If yes, should the recommender count it in the budget, or should the backend add it and tell the user?
- [ ] **Multi-item orders.** Should the ordering agent add several items (main + extras) to Prime's cart? It handles one item today.
- [ ] **Budget buttons.** Which preset amounts will the buttons offer? Single values work best (e.g. ₦1,000, ₦1,500, ₦2,000, ₦3,000, ₦5,000).
- [ ] **Goal and craving buttons.** Is the code list above final? Adding a new code needs a small change on the AI side.
- [ ] **Showing nutrition estimates.** Should the bot show the protein and calorie estimates (labelled as estimates), or only the reasons?
- [ ] **Confirming the note.** Show a short "Got it: no groundnut, no amala" line built from `result.note`? It helps users trust that their allergy was applied.
- [ ] **Saving timetables.** Should a timetable be saved so the user can reopen it, or regenerated on demand?
- [ ] **Menu refresh.** Who notices when Prime's menu changes, and how often should we re-crawl?

Anything unclear here, message me directly.
