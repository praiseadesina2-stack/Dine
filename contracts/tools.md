# Tools contract (v1, 11 Nov)

Owner: AI Engineer. Reader: Backend Engineer.
Argument schemas: `schemas/tool-args.schema.json` (one `$defs` entry per tool). Error shape: `schemas/tool-error.schema.json`.

## How a tool call travels

```
model ──args (naira)──▶ AI layer ──validate, convert to kobo──▶ backend endpoint ──▶ DB
model ◀──result (naira)── AI layer ◀──────result (kobo)───────── backend endpoint
```

- The AI layer validates every argument against the schema before calling the backend, and clamps limits.
- The backend validates again. It never trusts the AI layer for anything that touches a user or money.
- Endpoint: `POST /internal/ai/tools/{tool_name}`, JSON body = arguments.
  Auth: service token, plus an `X-Dine-User-Id` header set **by the bot server from the Telegram session**. The model cannot set or change it.
- Backend results use kobo. The AI layer converts to naira before the model sees them.
- Every result that contains a meal includes `meal_id`, `price_kobo`, `source_type`, `last_verified_at` and `stale`, so every price shown can be traced to a row.
- Text from reviews and menus is wrapped as data (`student_text`, `menu_text`) and labelled untrusted.

## Tools

| Tool | Type | Implemented by | Status |
|---|---|---|---|
| `search_meals` | Read | Backend endpoint | In-memory version in `packages/ai/src/find/tools.ts` |
| `get_meal` | Read | Backend endpoint | Missing |
| `get_vendor` | Read | Backend endpoint | In-memory version exists |
| `list_vendors` | Read | Backend endpoint | In-memory version exists |
| `get_reviews` | Read | Backend endpoint | In-memory version over `Context/` |
| `search_reviews` | Read | Backend endpoint (FTS) | In-memory BM25 version |
| `get_user_context` | Read | Backend endpoint | Missing |
| `get_wallet_summary` | Read | Backend endpoint | Missing |
| `propose_plan` | Propose | Backend endpoint | Missing |
| `request_user_confirmation` | Propose | Backend endpoint | Missing |
| `flag_data_issue` | Write (safe) | Backend endpoint | Missing |
| `final_answer` | Output | AI layer only (not an endpoint) | Exists; schema `chat-reply.schema.json` |

Removed from the earlier plan: `propose_order_action` (the scheduler orders, not the AI) and `create_complaint_draft`.

### `search_meals(query?, min_price_naira?, max_price_naira?, vendor_id?, limit?)`

Dinner meals that pass the [catalogue visibility rules](catalogue.md#what-tools-may-return).
Full-text search on `query`; with no query, browse by price. `limit` 1–20, default 10.

Returns `{ count, meals: [MealView] }`, ranked by relevance then price.

`MealView`: `meal_id`, `name`, `vendor_id`, `vendor_name`, `price_kobo`, `portion_note?`, `dietary_tags`, `source_type`, `last_verified_at`, `stale`.

### `get_meal(meal_id)`

One meal with its vendor, tags, price history (newest first, at most 5 rows) and review summary.
Returns `MealView` plus `description`, `availability_note`, `excluded` (true if older than 30 days), `price_history: [{ price_kobo, observed_at }]`, and `review_summary: { count, average_rating, sentiment }`.
Errors: `NOT_FOUND`.

### `get_vendor(vendor_id)` / `list_vendors()`

As today: the vendor and its visible dinner meals / all visible vendors, each with `meal_count` and `cheapest_kobo`. Errors: `NOT_FOUND`.

### `get_reviews(vendor_id, meal_id?, tag?)`

Stored reviews for a vendor (optionally one meal or one tag dimension), newest first, at most 10.
Returns `{ summary: { count, average_rating, rated_count, sentiment }, tag_counts: { [dimension]: { positive, negative, neutral } }, reviews: [ReviewView] }`.

`ReviewView`: `review_id`, `vendor_id`, `meal_id?`, `rating?`, `sentiment?`, `date`, `student_text`.

### `search_reviews(query, vendor_id?, limit?)`

Reviews that mention a topic (e.g. "oily", "portion"). Matches are by topic, not opinion: the model must read the sentiment. `limit` 1–10, default 6.

### `get_user_context()`

No arguments. The current user only.
Returns `{ first_name, preferences: PreferenceProfile | null, active_plan: { plan_id, week_start, status, days: [day] } | null, paused: bool, timezone: "Africa/Lagos" }`.
Never returns another user's data, a Telegram ID, a phone number or payment details.

### `get_wallet_summary()`

No arguments. Returns `{ available_kobo, reserved_kobo, simulated: bool }`.
`simulated` is true while payments run on the mock adapter. The bot must then say payments are simulated.

### `propose_plan(week_start, items[], note?)`

Arguments follow `schemas/plan-proposal.schema.json`.
The backend:

1. Checks that the user has a preference profile, and that `week_start` is a Monday not in the past.
2. For each item: the meal exists, is visible, is dinner, the day is unique, and the meal is fresh enough to plan (≤ 30 days).
3. **Recomputes every price and the total from the DB.** It ignores the quoted prices except to detect a change.
4. Stores a **draft** plan and returns it. Nothing is approved or paid.

Returns `{ plan_id, status: "draft", items: [{ day, meal_id, price_kobo, price_changed, stale }], total_kobo, over_budget_days: [day], warnings: [string] }`.
Errors: `INVALID_ARGUMENT`, `NOT_FOUND`, `NOT_DINNER`, `STALE_PRICE`, `UNAVAILABLE`, `NO_PROFILE`, `FEATURE_DISABLED` (`AI_PLAN_PROPOSALS_ENABLED` off).

### `request_user_confirmation(type, payload)`

Sends an inline-keyboard confirmation to the current user. The backend writes the message text and buttons from templates; the model only picks the type and references.

| `type` | `payload` | Buttons |
|---|---|---|
| `approve_plan` | `{ plan_id }` | Approve all · Choose days · Not now |
| `save_preferences` | `{ profile: PreferenceProfile }` | Save · Edit |

Returns `{ request_id, sent: true }`. The answer arrives later as a bot event, not as a tool result. The model must never say a plan is approved until `get_user_context` shows it.
Callback tokens are single-use and bound to the user. Errors: `NOT_FOUND`, `INVALID_ARGUMENT`, `RATE_LIMITED`.

### `flag_data_issue(entity_type, entity_id, reason, note?)`

Adds a catalogue review task for a human. It never changes catalogue data.
`entity_type`: `meal`, `vendor`, `review`. `reason`: `price_wrong`, `unavailable`, `stale`, `wrong_vendor`, `offensive_review`, `other`. `note` ≤ 280 characters.
Returns `{ task_id }`. At most 5 per user per day (`RATE_LIMITED` after that).

### `final_answer(message, picks[])`

Not an endpoint: the model's last call in a chat turn. It follows `schemas/chat-reply.schema.json`.
The AI layer runs the grounding check (`packages/ai/src/find/grounding.ts`) before anything is sent:

- each `meal_id` was returned by a tool in this conversation and is available;
- each `review_id` was returned by a tool and is about that meal's vendor;
- no money amount appears that is not a returned price or a number the user typed;
- no quality claim ("tasty", "filling" …) without a cited review.

If the check fails: one retry with the problems listed, then fall back to keyword mode.

## Error codes

Every failed tool call returns `{ "error": { "code", "message", "retryable" } }` (`schemas/tool-error.schema.json`). `message` is safe to show the model; it never contains SQL, stack traces or other users' data.

| Code | Meaning | Retryable |
|---|---|---|
| `INVALID_ARGUMENT` | Argument failed schema validation | No (fix the arguments) |
| `NOT_FOUND` | No visible row with that ID | No |
| `NOT_DINNER` | Meal is not a dinner item | No |
| `UNAVAILABLE` | Meal or vendor is not available | No |
| `STALE_PRICE` | Price older than 30 days, or missing | No |
| `NO_PROFILE` | User has no saved preferences yet | No |
| `FEATURE_DISABLED` | A feature flag is off | No |
| `RATE_LIMITED` | Too many calls; wait | Yes |
| `UPSTREAM_TIMEOUT` | Backend dependency timed out | Yes, once |
| `INTERNAL` | Anything else | Yes, once |

## Limits

- At most 8 tool calls per chat turn and 20 seconds total, then fall back to keyword mode.
- Tool results sent to the model are capped at 20 meals or 10 reviews.
