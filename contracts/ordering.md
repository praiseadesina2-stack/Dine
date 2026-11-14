# Ordering contract (DRAFT, 14 Nov)

**Status: draft written by the AI Engineer. The Backend Engineer owns the scheduler, wallet and ledger and must sign off before it is v1.**

Dine places dinner orders on Prime **for** the student and pays from the wallet the student funded. This file says when that may happen, in what order the steps run, and what the ordering agent promises.

## What Dine can order

**Only items on Prime's bot catalogue** (`@orderfromprimebot`), exactly as Prime lists them: same vendor, same item name, Prime's price. In the AI layer that is a meal from the Prime catalogue (`packages/ai/src/find/prime-catalogue.ts`, built from the crawl in `recommend/data/prime-menu.json`); in the database it is a `meals` row sourced from Prime.

- Campus meals from the recommender (`orderable: false`) are suggestions only. They never get an **Order on Dine** button and can never be ordered or paid through Dine.
- Plans (`propose_plan`) contain Prime catalogue meals only, so every planned day can be ordered.
- An item that is no longer on Prime's bot, or whose name or price there differs from the catalogue row, is not ordered (policy rule 6, agent guarantees 1 to 4).

## When Dine orders

Only these two triggers. Nothing else (no model output, chat message or tool call) can start an order.

| Trigger | What the student did | Approval record |
|---|---|---|
| `tap` | Tapped **Order on Dine** on a pick (from `/find` or the recommender) | The button's single-use callback token, bound to the user, the meal and the price shown |
| `schedule` | Approved a plan (`approve_plan` keyboard) **and** gave consent once for Dine to order and pay on their behalf, covering either the whole week or only the days they chose | The approved plan items plus **one consent record for that plan**: consent text version, timestamp, and the days it covers. No per-day prompts; a new week needs a new approval and consent |

The model never triggers an order or a payment. It proposes meals and plans; the student approves; the backend's policy check decides; the ordering agent executes.

## Order sequence (both triggers)

```
trigger ─▶ policy check (policy.md) ─allow─▶ reserve amount in wallet ─▶ ordering agent places order on Prime
        ─▶ Dine pays the Prime checkout from the reservation ─▶ verify payment and Prime confirmation ─▶ ledger: capture
                                                     any failure ─▶ release reservation, tell the student (states.md)
```

1. **Policy check** with `trigger`, user, meal, vendor and approved price (see [policy.md](policy.md)). `block` stops here. `ask_user` sends the price-change keyboard and stops.
2. **Reserve** `amount_kobo` in the student's wallet (append-only ledger). No reservation, no order.
3. **Ordering agent** places the order: `DineOrderingAgent.placeOrder(target)` in `packages/ai/src/agent.ts`.
4. **Pay** the Prime checkout from the reservation. *To confirm (Backend):* how Dine settles the Paystack checkout Prime returns (Dine's own payment method, then the ledger moves the student's reserved funds).
5. **Verify** that the payment succeeded and Prime accepted the order before capturing the reservation. An uncertain outcome (timeout after paying) is not a failure: it is reconciled before any retry, so a student is never charged twice.
6. **Policy re-check right before paying** (step 4), so a pause or balance change after step 1 stops the payment.

## The ordering agent

Code, not a model. It drives Prime's Telegram bot (`@orderfromprimebot`) through a Dine-owned Telegram session (`TELEGRAM_STRING_SESSION`). The backend is its only caller, and only after steps 1 and 2.

**Input** (`OrderTarget`): `vendorName`, `itemName` (exact names from the Prime catalogue row being ordered), `expectedPriceKobo` (Prime's item price the student approved), optional `location` (`inside_cafeteria` / `outside_cafeteria`), optional `botUsername`.

**Output** (`AgentOrderResult`): `success`, `message`, `code?` (failure code below), `stage`, `cartTouched`, `totalKobo?` (Prime's total including packs: **this is the amount Dine pays**, so reserve against it), `paystackUrl?`, `orderRef?`, `stepsCompleted[]`.

**Failure codes**: `CART_NOT_EMPTY`, `VENDOR_NOT_FOUND`, `VENDOR_CLOSED`, `ITEM_NOT_FOUND`, `ITEM_MISMATCH`, `PRICE_CHANGED`, `CART_MISMATCH`, `CHECKOUT_UNMAPPED`, `UNEXPECTED_SCREEN`, `BOT_ERROR`. When `cartTouched` is true the Dine account's Prime cart may hold the item; it must be cleared before any retry (the next order refuses a non-empty cart).

### Prime's flow, as the agent walks it

`/start` → **I'm Hungry 🍽️** → **Inside / Outside Cafeteria** → vendor list (paged, **Next ▶**) → vendor menu (`<Vendor> · 🟢 Active`, **Choose <item>**, paged) → item screen (`Price`, `Qty`, `Pack`, `Packs`, `Total`) → **Add to cart ✓** → **🛒 My Cart** → checkout.
Mapped from the crawl of `@orderfromprimebot` (19 Oct) up to **Add to cart**. The cart and checkout were never crawled.

### Guarantees (`packages/ai/src/order/prime-flow.ts`, tested in `prime-flow.test.ts` on the crawled screens)

| # | Guarantee | Status (14 Nov) |
|---|---|---|
| 1 | Presses a vendor or item button only on an **exact** (normalised) name match; never a similar or empty one | Met |
| 2 | If the vendor or item is not found, or the vendor is closed, stops without touching the cart; never falls back to another button | Met |
| 3 | `success: true` only when checkout gave a payment link or an order confirmation | Met |
| 4 | Stops (`PRICE_CHANGED`) if Prime's price differs from the approved one; checks quantity 1 and that the total adds up | Met |
| 5 | Refuses to start if the Prime cart is not empty, so an order never carries leftover items | Met |
| 6 | One order at a time per Telegram session (lock), so two orders cannot read each other's bot replies | Met |
| 7 | Returns Prime's order reference when the confirmation shows one | Met if Prime shows one (format unconfirmed) |
| 8 | Checkout | **Not mapped.** Stops with `CHECKOUT_UNMAPPED` after verifying the cart. Needs one supervised test order on a funded account to record the cart and checkout screens and set `CHECKOUT_LABELS` |
| 9 | Delivery to the student's hall and room | **Open.** Prime takes hall and room from the account profile (**📍 Change Hall/Room**, not crawled); all Dine orders go through one Prime account, so per-order delivery needs that flow mapped |
| 10 | Paying the checkout | **Open.** Prime has its own wallet (bank-transfer top-up) and may also return a Paystack link; which one Dine uses is a backend decision |

Until 8 to 10 are closed, `PRIME_AUTOMATION_ENABLED` stays off outside a supervised test.

## Things the AI side relies on

- States and message texts for each order outcome come from `states.md` (Backend owes it).
- `get_user_context` shows the plan's approval and consent state; the model must never say an order is placed or paid unless that shows it.

## Tests

Backend: one test per trigger for each policy rule; a `tap` token used twice gives one order; pause between reservation and payment gives no payment; agent failure releases the reservation.
AI side: agent tests against recorded Prime bot messages for guarantees 1 to 4 (wrong-but-similar item name, missing item, missing checkout link, changed price).
