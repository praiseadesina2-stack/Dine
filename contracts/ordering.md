# Ordering contract (DRAFT, 14 Nov; payment route and tray orders added 17 Nov)

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
4. **Pay** the Prime checkout from **Prime's own wallet** on the Dine-owned Prime account (see [Paying Prime](#paying-prime)). The agent does this as part of checkout and returns proof (`payment`).
5. **Verify** (`payment.status === "verified"`, from the Prime wallet balance) that the payment succeeded and Prime accepted the order before capturing the reservation. An uncertain outcome (timeout after paying) is not a failure: it is reconciled before any retry, so a student is never charged twice.
6. **Policy re-check right before paying** (step 4), so a pause or balance change after step 1 stops the payment.

## The ordering agent

Code, not a model. It drives Prime's Telegram bot (`@orderfromprimebot`) through a Dine-owned Telegram session (`TELEGRAM_STRING_SESSION`). The backend is its only caller, and only after steps 1 and 2.

**Input**: the whole tray, `agent.placeTrayOrder(lines)`, where each line (`CartLine`) is `vendorName`, `itemName` (exact names from the Prime catalogue row), `expectedPriceKobo` (Prime's item price the student approved), optional `qty` (default 1, at most 10), optional `location` (`inside_cafeteria` / `outside_cafeteria`). Build `lines` from the bot's tray with `trayToCartLines(tray)` (see [Ordering a tray](#ordering-a-tray)). `agent.placeOrder(target)` still works for a single item; it is a one-line tray.

**Output** (`AgentOrderResult`): `success`, `message`, `code?` (failure code below), `stage`, `cartTouched`, `totalKobo?` (Prime's total for the whole cart, quantities and packs included: **this is the amount Dine pays**, so reserve against it), `lines?` (success: each line as Prime showed it), `item?` (failure: the tray line it stopped on), `paystackUrl?`, `orderRef?`, `payment?` (proof of payment, below), `transfer?` (Prime asked for a bank transfer; also as `bankPaymentDetails` in naira), `suggestions?` (`VENDOR_NOT_FOUND` / `ITEM_NOT_FOUND`: similar names on Prime for a "Did you mean…?"; never ordered automatically), `topUp?` (`PRIME_WALLET_LOW` only), `stepsCompleted[]`.

**Failure codes**: `CART_NOT_EMPTY`, `VENDOR_NOT_FOUND`, `VENDOR_CLOSED`, `ITEM_NOT_FOUND`, `ITEM_MISMATCH`, `PRICE_CHANGED`, `CART_MISMATCH`, `CHECKOUT_UNMAPPED`, `PRIME_WALLET_LOW`, `TRANSFER_MISMATCH` (Prime asked for a transfer of a different amount than the verified cart; nothing paid), `INVALID_ORDER` (empty tray, quantity outside 1 to 10, or a line without `expectedPriceKobo`), `UNEXPECTED_SCREEN`, `BOT_ERROR`. When `cartTouched` is true the Dine account's Prime cart may hold items; it must be cleared before any retry (the next order refuses a non-empty cart).

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
| 10 | Paying the checkout | **Met in code, unverified on Prime.** Two paths (`PRIME_PAY_MODE`, below); whichever Prime's checkout shows wins. **Transfer** (default): Prime's transfer request is returned only if its amount equals the verified cart, and paid by `payPrimeTransfer` behind its guards. **Wallet**: presses a wallet-pay button if Prime asks how to pay (never card); proves payment by the wallet balance dropping by exactly the total. The transfer format comes from the Backend Engineer's agent; the wallet-pay labels (`WALLET_PAY_LABELS`) are guesses. Neither is confirmed until checkout is mapped. **Proof that Prime received a transfer is open**: Kora's test keys never pay Prime, so what Prime shows once paid is unknown until one supervised real-money order |
| 11 | Wallet covers the order | **Met (wallet mode).** Reads the Prime wallet before ordering; stops with `PRIME_WALLET_LOW` before touching the cart if it cannot cover the whole tray. Transfer mode does not read the Prime wallet |
| 12 | A tray is one order | **Met in code, unverified on Prime.** Every line, from any vendors, in one Prime cart and one checkout. Every line is checked (vendor open, exact item, approved price) **before anything is added**; one bad line stops the whole order with the cart untouched. The same item twice is one line with quantity 2, set with Prime's `+` button. The cart must show every item, and Prime's cart total (when shown) must equal the tray. Whether Prime accepts several vendors in one cart is unconfirmed until the supervised test order |

Until 8 to 10 are closed, `PRIME_AUTOMATION_ENABLED` stays off outside a supervised test.

## Ordering a tray

The student fills the tray, taps **Confirm & Order**, and Dine orders everything at once: one Prime cart, one checkout, one payment.

Backend wiring in `apps/api/src/index.ts`, replacing the upfront `walletService.debit` and the loop that called `placeOrder` once per tray item (that call no longer passes a price, so the agent refuses it with `INVALID_ORDER`; it is also a type error):

```ts
import { trayToCartLines, payPrimeTransfer } from "@dine/ai";

const conv = trayToCartLines(getTray(userId)); // tray items: itemName, vendorName, price (naira), optional location
if (!conv.ok) return ctx.reply(conv.problems.join("\n")); // e.g. a "Prime Vendor" placeholder or a missing price

const ref = `order_${userId}_${Date.now()}`; // one reference for the hold and the payout, created first
const hold = await walletService.reserve({ telegramUserId: String(userId), amountKobo: conv.totalKobo, reference: ref });
if (!hold) return /* insufficient balance: the existing top-up prompt */;

const result = await orderingAgent.placeTrayOrder(conv.lines);
if (!result.success) {
  await walletService.release(ref, result.code);           // nothing was paid
  // result.suggestions → offer "Did you mean …?" buttons; result.cartTouched → clear Prime's cart before a retry
  return ctx.reply(result.message);
}

switch (result.payment?.status) {
  case "awaiting_transfer": {                               // Prime asked for a bank transfer of exactly result.totalKobo
    const paid = await payPrimeTransfer({ kora: koraService, transfer: result.transfer!, totalKobo: result.totalKobo!, reference: ref });
    // paid.message is the line for the student ("Test payment …: Prime was not actually paid." with test keys)
    if (paid.status === "sent") { /* poll koraService.verifyPayout(ref): "success" → capture(ref); "failed" → release(ref) */ }
    else if (paid.status === "failed" || paid.status === "blocked") await walletService.release(ref, paid.detail);
    else if (paid.status === "simulated") await walletService.release(ref, "test mode: Prime not paid");
    // "uncertain": keep the hold, alert an operator, never call payPrimeTransfer again for this ref
    break;
  }
  case "verified": await walletService.capture(ref); break; // wallet mode: Prime wallet dropped by the total
  case "not_paid": await walletService.release(ref, "not paid"); break;
  default: break;                                           // "uncertain": keep the hold, reconcile
}
// wallet mode only: result.code === "PRIME_WALLET_LOW" → top up the Prime float (result.topUp), then retry
```

In test mode the hold is released after a `simulated` payment so test balances are not spent on orders Prime never received. Change that only once a real payment has been confirmed end to end.

What the tray must keep for each item: the exact Prime `vendorName` and item name (`MealSuggestion.vendorName`, `MealSuggestion.items[].name`), the item price in naira (`items[].price`), and `MealSuggestion.location` (optional, makes the search faster). `trayToCartLines` refuses an item with no vendor, the placeholder vendor `"Prime Vendor"`, or no price, rather than guessing. Hall and room are not inputs: Prime delivers to the Dine account's profile (guarantee 9).

## Paying Prime

Students never pay Prime directly: their money stays in Dine's wallet, reserved (`walletService.reserve`), until the order is proven paid (`capture`) or not (`release`). Dine pays Prime in one of two ways, set by **`PRIME_PAY_MODE`** (`transfer`, the default, or `wallet`). Whichever Prime's checkout actually shows wins.

### By bank transfer (`PRIME_PAY_MODE=transfer`)

Prime's checkout asks for a transfer ("Send ₦X to: Account number … Bank … Name …", format from the Backend Engineer's agent, unconfirmed). The agent returns it as `result.transfer` with `payment.status: "awaiting_transfer"`, only when Prime's amount equals the cart it verified line by line (else `TRANSFER_MISMATCH`). The backend pays it with **`payPrimeTransfer`** (`packages/ai/src/order/pay-transfer.ts`), never with `koraService.disburse` directly. Before calling Kora it checks:

1. Prime's amount equals `totalKobo`; the account number is 10 digits.
2. Live keys only: the payee Prime shows **and** the account holder the bank returns (Kora resolve) both match an allowed Prime payee in **`PRIME_PAYEE_NAMES`** (comma-separated, e.g. `Prime That`). Not set means every live payment is blocked.
3. Live keys only: Kora's bank list names the bank (`koraService.findBankCode`, no guessed code or fallback).
4. One reference, made by the caller before the call; `payPrimeTransfer` never retries.

| `status` | Means | Backend does |
|---|---|---|
| `simulated` | Test keys: Kora's sandbox accepted it. **No money moved; Prime was not paid** | Release; show `message` ("Test payment … Prime was not actually paid.") |
| `sent` | Live: Kora accepted the payout | Hold; `koraService.verifyPayout(ref)`: `success` → capture, `failed` → release |
| `failed` | Kora refused outright | Release; the unpaid Prime order must be cleared |
| `blocked` | A check stopped it before Kora was called | Release; alert an operator if it was the payee or bank check |
| `uncertain` | Unknown whether money moved | **Hold**; reconcile with `verifyPayout`; never pay again for this order |

**Open:** Kora reporting `success` proves the money reached the account, not that Prime marked the order paid. What Prime shows after receiving a transfer is unknown until one supervised real-money order.

### From the Prime wallet float (`PRIME_PAY_MODE=wallet`)

Dine keeps a **float** in Prime's wallet on the Dine-owned Prime account.

Prime's wallet screen (crawled 19 Oct): `Balance: ₦X` and a funding account for bank-transfer top-ups (`9894065716 · Flutterwave MFB` on the crawl). Code: `packages/ai/src/order/prime-wallet.ts`.

**Proof of payment** (`payment` on the agent's result, set once checkout was pressed): the agent reads the wallet before ordering and after checkout. A checkout message is never proof.

| `payment.status` | Means | Backend does |
|---|---|---|
| `verified` | Balance dropped by exactly `totalKobo` | Capture the student's reservation |
| `not_paid` | Balance did not move (e.g. Prime returned only a Paystack link) | Release the reservation; the unpaid Prime order and cart must be cleared before the next order |
| `uncertain` | Balance moved by another amount, could not be read, or Prime stopped replying after checkout | **Hold** the reservation; reconcile (Prime wallet transactions, operator) before any retry. Never retry an uncertain order |

**Low float**: `PRIME_WALLET_LOW` comes with `topUp: { shortfallKobo, balanceKobo, fundingAccount }`. The cart is untouched, so the backend may retry once the float is topped up.

**Topping up the float** (Backend, Kora payout):
1. Pin the funding account once (Kora resolve, store the resolved name). Pay **only** to the pinned account; if `topUp.fundingAccount` ever differs from it, stop and alert an operator.
2. Top up by more than the shortfall (a float for several orders, e.g. ₦10,000), with a unique reference created before the call; never resend after a timeout.
3. Confirm it landed: `agent.checkTopUp({ previousBalanceKobo, amountKobo })` polls Prime's wallet and returns `landed` or `not_yet`. `not_yet` means reconcile with Kora, not pay again.
4. `agent.readPrimeWallet()` gives the balance for a daily float check against the ledger (Prime float = top-ups − verified order payments).

Demo of the whole path on the simulated Prime bot: `pnpm --filter @dine/ai pay:demo`.

## Things the AI side relies on

- States and message texts for each order outcome come from `states.md` (Backend owes it).
- `WalletService` (`packages/ai/src/wallet.ts`) keeps balances and holds **in memory only**: a restart or redeploy wipes them. Persisting to the `wallets` / `wallet_transactions` tables (with a `users` row per student, which nothing creates yet) is Backend's, before any real money.
- `get_user_context` shows the plan's approval and consent state; the model must never say an order is placed or paid unless that shows it.

## Tests

Backend: one test per trigger for each policy rule; a `tap` token used twice gives one order; pause between reservation and payment gives no payment; agent failure releases the reservation.
AI side: agent tests against recorded Prime bot messages for guarantees 1 to 4 (wrong-but-similar item name, missing item, missing checkout link, changed price), and for payment: low float stops before the cart, verified only on an exact wallet drop, wallet chosen over card, a Paystack link alone is not paid, wrong charge or lost reply is uncertain; whole trays: three vendors in one cart and one checkout, duplicates set with `+`, every line verified before anything is added, wallet covers the whole tray, cart total must match, tray conversion refuses placeholders (`prime-flow.test.ts`); bank transfer: parsed only with account, bank and amount, returned only when the amount equals the cart, the Prime wallet untouched in transfer mode, a line without a price refused, near misses returned as suggestions and never ordered, every `payPrimeTransfer` guard blocks before Kora is called, test keys give `simulated` and never `sent`, an unclear Kora reply is `uncertain` and not retried; student wallet: reserve, capture and release, a debit cannot spend reserved money (`payments.test.ts`).
