# Policy contract (DRAFT, 11 Nov)

**Status: draft written by the AI Engineer. The Backend Engineer owns the policy service and must sign off before it is v1.**
Output schema: `schemas/policy-decision.schema.json`.

The policy service is deterministic code. The model is never called while it runs, and nothing it does depends on the model being up.
It runs before every order the ordering agent places (an **Order on Dine** tap or a scheduled plan day, see [ordering.md](ordering.md)), and again right before the wallet payment.

## Input: an order attempt

| Field | Meaning |
|---|---|
| `trigger` | `tap` (student tapped **Order on Dine**) or `schedule` (scheduler running an approved plan day) |
| `user_id` | From the Telegram session (`tap`) or the plan record (`schedule`) |
| `plan_id`, `plan_item_id` | `schedule` only: the approved plan item being executed. Null for `tap` |
| `tap_token` | `tap` only: the single-use callback token of the button the student pressed. Null for `schedule` |
| `meal_id`, `vendor_id` | From the tapped pick or the plan item |
| `approved_price_kobo` | Price shown on the button the student tapped, or the price on the plan they approved |
| `current_price_kobo` | Price read from the catalogue at run time (null if missing) |
| `price_verified_at` | `meals.last_verified_at` at run time |
| `scheduled_for` | The dinner date and time this order is for |
| `now` | Evaluation time |

The service reads everything else itself: approval and consent records, pause state, caps, balance, vendor verification, earlier orders.

## Output

```json
{ "decision": "allow" | "block" | "ask_user", "reasons": [{ "code": "...", "detail": "..." }], "amount_kobo": 0, "policy_version": "v1" }
```

- `allow`: reserve `amount_kobo` from the student's wallet; the ordering agent then places the order and Dine pays the checkout from that reservation.
- `block`: skip this order and notify the student with the state text for the first reason.
- `ask_user`: skip this order for now and send the price-change keyboard. Payment happens only after a fresh approval.

`reasons` lists **every** rule that failed, not only the first, so the logs explain everything.
`amount_kobo` is the amount to reserve. It is 0 unless `decision` is `allow`.

## Rules (all must pass for `allow`)

| # | Rule | On failure | Reason code |
|---|---|---|---|
| 1 | Payments are enabled (`PAYMENTS_ENABLED`) | block | `PAYMENTS_DISABLED` |
| 2 | User and plan are not paused | block | `PAUSED` |
| 3 | `schedule`: the plan item is approved, and the plan's consent record (given once, for the whole week or the days the student chose: text version, timestamp, days covered) includes this item's day. `tap`: the tap token is valid, unused, bound to this user, meal and price, and under 15 minutes old | block | `NOT_APPROVED` |
| 4 | No order already exists for this plan item or tap token (idempotency) | block | `DUPLICATE` |
| 5 | Vendor is active and in the verified vendor table | block | `VENDOR_NOT_VERIFIED` |
| 6 | Meal is a Prime catalogue item (on Prime's bot), available, and a dinner item | block | `MEAL_UNAVAILABLE` |
| 7 | The current price exists and was verified within 30 days | block | `PRICE_STALE` |
| 8 | Price increase ≤ tolerance: `current ≤ approved × (1 + tolerance)` | ask_user | `PRICE_CHANGED` |
| 9 | Within the per-order cap | block | `CAP_ORDER` |
| 10 | Within the per-day cap, counting earlier orders and reservations that day | block | `CAP_DAY` |
| 11 | Within the per-week cap (Mon–Sun, Lagos time) | block | `CAP_WEEK` |
| 12 | Available balance ≥ `current_price_kobo`. No partial payments | block | `INSUFFICIENT_BALANCE` |
| 13 | `schedule` only: `now` is inside the run window for `scheduled_for`. `tap`: Prime is taking orders now | block | `OUTSIDE_WINDOW` |

If any rule blocks, the decision is `block` even if rule 8 would ask. If rule 8 is the only failure, the decision is `ask_user`.
A price **decrease** always passes rule 8, and the order is charged the lower current price.

## Settings (defaults are ASSUMPTIONS until both engineers agree)

| Setting | Default | Note |
|---|---|---|
| `price_tolerance_pct` | 10 | From the one-week plan |
| `run_at_local` | 15:00 Africa/Lagos | Configurable lead time before dinner |
| `run_window_minutes` | 120 | After that the order is skipped and the student is told |
| `system_max_order_kobo` | 2 000 000 (₦20,000) | Hard safety ceiling, same as the profile's budget maximum |

## Caps come from the student's own budget

The student states a budget per meal (`budget_per_dinner_kobo` in their PreferenceProfile). The caps follow from it and the plan they approved:

| Cap | Value |
|---|---|
| Per order | `budget_per_dinner_kobo` × (1 + `price_tolerance_pct`/100). Up to the budget is allowed; above it up to the tolerance is `ask_user` (rule 8); beyond that is blocked |
| Per day | Same as per order (dinner only: one order per day) |
| Per week | `budget_per_dinner_kobo` × number of days approved for auto-pay that week |

The approved budget is **copied onto the plan when the student approves it**. Changing the profile later does not change the caps of an already-approved plan; it needs a new approval.
Every cap is also limited by `system_max_order_kobo`, so a mistyped budget cannot authorise a large payment.

## Things the AI relies on

- The model never calls the policy service or the ordering agent, and never sees an `allow`. It only reads results through `get_user_context` and the state texts in `states.md`.
- The ordering agent (`packages/ai/src/agent.ts`) is code, not a model. The backend calls it only after an `allow` and a successful reservation.
- `ask_user` uses the same `request_user_confirmation` keyboard machinery, with a backend-only type `price_change`.

## Tests the backend should have

One test per rule (each fails alone and yields the right code), plus: pause set between policy check and payment → no payment; two runs of the same plan item at once → one order; price −20% → allow at the lower price; price +15% → ask_user; price +15% and balance short → block with both reasons.
