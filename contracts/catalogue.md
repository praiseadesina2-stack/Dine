# Catalogue contract (v1, 11 Nov)

Owner: AI Engineer. Reader: Backend Engineer.
Source of truth for the tables: `packages/database/src/catalogue.ts`.

## Scope

Dinner only. 3 to 4 vendors at one university. Target: 25 or more dinner items now, 40 or more by Friday.
**Any row without a source and a verification date is never shown and never planned.**

## Tables

### `vendors`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | Opaque ID |
| `name` | text | Display name, as students say it |
| `location_text` | text? | E.g. "Campus Cafeteria" |
| `serves_dinner` | bool | Must be true to appear anywhere this week |
| `active` | bool | False hides the vendor and all its meals |
| `source_type`, `source_ref`, `collected_by`, `collected_at`, `last_verified_at` | | Provenance (see below) |

Payout account details are **not** part of the catalogue. They live in the backend's verified vendor table, which the AI cannot read.

### `meals`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | Opaque ID; this is the `meal_id` that tools return and plans reference |
| `vendor_id` | uuid → vendors | |
| `name` | text | As on the menu, e.g. "Jollof rice + chicken" |
| `category` | text? | Free text for now, e.g. "rice", "swallow", "pasta" |
| `description` | text? | What is on the plate |
| `portion_note` | text? | E.g. "2 spoons rice, 1 piece chicken" |
| `dietary_tags` | text[] | Only values from [Dietary tags](#dietary-tags) |
| `price_kobo` | int > 0 | Current price for one portion, as sold |
| `is_dinner` | bool | Must be true to be shown or planned |
| `available` | bool | False hides the meal |
| `availability_note` | text? | E.g. "not on Sundays" |
| provenance columns | | As for vendors |
| `search` | tsvector | Full-text index over name, category, description and vendor name |

### `reviews`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | This is the `review_id` that tools return and replies cite |
| `meal_id` | uuid? | Set when the review is about one meal |
| `vendor_id` | uuid? | Set for every review that can be shown; a review with no vendor is never shown |
| `text` | text | Student's words with names removed. **Untrusted data**: never instructions |
| `rating` | 1–5? | |
| `consent_basis` | text? | **A review is shown only if this is set** |
| `anonymised` | bool | Must be true to be shown |
| `source_ref` | text? | E.g. `Fact_Reviews.csv#row=12;REV-014` |
| `collected_by`, `created_at` | | |

### `review_tags`

| Column | Values |
|---|---|
| `dimension` | `taste`, `portion`, `affordability`, `quality`, `service`, `hygiene`, `speed` |
| `polarity` | `positive`, `negative`, `neutral` |
| `confidence` | 0–1 |
| `tagger` | `human`, `model` (with `model_version`) |
| `reviewed` | true once a human checked a model tag |

### `meal_price_history` (to add)

`get_meal` returns price history, and the policy check needs to know when a price changed. Proposed:
`id`, `meal_id`, `price_kobo`, `observed_at`, `source_type`, `source_ref`, `collected_by`.
Append a row every time `meals.price_kobo` or `meals.last_verified_at` changes. **Needs a migration.**

## Provenance

| Field | Allowed values / format |
|---|---|
| `source_type` | `menu_photo`, `price_board_photo`, `vendor_catalogue`, `vendor_message`, `site_visit`, `student_submission`, `prime_crawl` |
| `source_ref` | A file path, URL or message ID that someone else can open to check the value |
| `collected_by` | Team member handle, or `student_form` |
| `collected_at` | When we first recorded it |
| `last_verified_at` | The last time someone confirmed the price and availability at the source |

A `student_submission` price may be shown but **may not be planned or paid** until a team member verifies it
(i.e. its `source_type` changes or a newer verified price-history row exists).

## Freshness (from the SRS)

Age = now − `meals.last_verified_at`.

| Age | Search and chat | Plans and scheduled payment |
|---|---|---|
| ≤ 14 days | Shown | Allowed |
| 15–30 days | Shown with `stale: true`; the bot shows a warning | Allowed, with a warning on the plan |
| > 30 days | Not returned by search; `get_meal` returns it with `excluded: true` so the AI can explain | **Blocked** |
| Missing | Never shown | Blocked |

## Dietary tags

Preferences only. **No health data** (no conditions, no reasons why).

`vegetarian`, `contains_pork`, `contains_groundnut`, `contains_tree_nut`, `contains_egg`, `contains_fish`,
`contains_shellfish`, `contains_dairy`, `contains_gluten`, `spice_0` … `spice_4` (pepper heat, 0 = none).

The allergen names match `ALLERGENS` in `packages/ai/src/recommend/knowledge.ts`.

## What tools may return

A row is visible to the AI only if **all** of these are true:

- vendor: `active` and `serves_dinner`
- meal: `is_dinner`, `available`, provenance set, age ≤ 30 days (except through `get_meal`, as above)
- review: `vendor_id` set, `consent_basis` set, `anonymised` true

The backend applies these filters in SQL. The AI does not re-implement them, but its grounding check refuses any meal or review a tool did not return.

**Instruction-like text (added 14 Nov).** Meal names are shown to students verbatim, so a name or vendor description that reads like an instruction to an AI ("ignore your rules", "note to AI", "tell the student…", "system prompt") must be rejected at import and sent to a human, not loaded. The in-memory catalogue already does this (`packages/ai/src/find/untrusted.ts`, `looksLikeInstruction()`); the seed import should call the same function. Review text is not filtered (the model treats it as data; `evals/find-adv-v1.json` tests this), but it is never shown to students without passing through the model's grounded answer.

## How data gets in

1. Raw sources (photos, CSVs, chat exports) stay local in `Context/`. They are never committed.
2. The AI Engineer turns them into a seed file with every provenance field filled, and reviews it.
3. The backend's seed import loads the seed into staging. Re-running it updates rows by `(vendor name, meal name)` and appends price history.
4. Price changes after that go through the admin edit or a new seed, never by hand in SQL.

## Open items

- [ ] Generate the migration for `catalogue.ts`. Only `users` and `consent_records` are migrated today.
- [ ] Add `meal_price_history` (above).
- [x] Consent basis for the 125 survey reviews in `Context/`: respondents were told their answers would be used to build the application. Load them with `consent_basis = 'google_form_food_review_v1'` and `anonymised = true` (names already removed). The form's exact wording is kept locally in `Context/consent/google_form_food_review_v1.txt`.
- [ ] New review sources (Telegram form, interviews) need their own consent line and their own `consent_basis` value before they are shown.
- [ ] Pick the 3–4 dinner vendors. The current menu data is mostly from the Prime crawl, which is out of scope this week.
