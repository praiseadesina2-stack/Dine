/**
 * Order a tray on Prime AND pay it, in one go (contracts/ordering.md, "Paying Prime").
 *
 * Prime makes a fresh virtual account for every checkout, so there is no account to pin:
 * the agent pays whichever account Prime shows on THIS checkout, straight away (virtual
 * accounts expire), and only after payPrimeTransfer's checks pass (amount = verified cart;
 * live: the bank says the account is "Prime <Dine's registered Prime name>", see payeesFor).
 *
 * Proof of payment is Prime's own "payment received" message in the chat after the
 * transfer, never Kora's word alone. Kora "sent" with no message from Prime is "uncertain".
 */
import { runCartOrder, type CartLine, type OrderFlowResult, type PrimeBot } from "./prime-flow.js";
import { PAID_MESSAGE, payPrimeTransfer, type KoraPayouts, type TransferPayment } from "./pay-transfer.js";
import type { PaymentEvidence } from "./prime-wallet.js";

/**
 * Prime's message once a transfer lands. Prime's real wording is unknown until a
 * supervised real-money order; widen this only with a recorded message.
 */
export const PRIME_PAID = /payment\s+(?:has\s+been\s+|was\s+)?(?:received|confirmed|successful)|paid\s+successfully|received\s+your\s+payment|order\s+(?:has\s+been\s+)?paid/i;

/** How long to watch Prime's chat for its confirmation after Kora accepted the payout. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 3 * 60_000;

export interface OrderAndPayOptions {
  kora: KoraPayouts;
  /** Unique per order, stored by the caller with the student's hold; used as the Kora reference. */
  reference: string;
  /** Default payeesFor(): PRIME_PAYEE_NAMES, else "Prime <registered name>" from Prime's greeting. */
  allowedPayees?: string[];
  confirmTimeoutMs?: number;
  /**
   * The most Dine may pay Prime for this order: what the student approved, food + Prime's
   * fee (trayToCartLines → charges.payPrimeKobo). Pack fees can push Prime's amount above
   * it; then nothing is paid. Omit only in tests.
   */
  maxPayPrimeKobo?: number;
  /** Prime's per-order fee; default PRIME_FEE_NAIRA (₦600). */
  primeFeeKobo?: number;
}

export interface OrderAndPayResult {
  /** The order, with `payment` updated to what happened to the money. */
  order: OrderFlowResult;
  /** Set when a transfer was attempted (or blocked). */
  payout?: TransferPayment;
}

const NAIRA = /₦\s*([\d,]+(?:\.\d{1,2})?)/;

/**
 * Who this checkout's virtual account may belong to. Prime names each one "Prime <the
 * name the customer gave Prime>" ("Prime David"), and every Dine order uses the one
 * Dine-owned Prime account. PRIME_PAYEE_NAMES overrides; otherwise "Prime <name>" from
 * Prime's own greeting on this order. No name means live payments are blocked.
 */
export function payeesFor(primeCustomerName: string | undefined): string[] {
  const fromEnv = (process.env.PRIME_PAYEE_NAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return primeCustomerName ? [`Prime ${primeCustomerName}`] : [];
}

export async function runOrderAndPay(bot: PrimeBot, lines: CartLine[], o: OrderAndPayOptions): Promise<OrderAndPayResult> {
  const order = await runCartOrder(bot, lines, { payWith: "transfer", ...(o.primeFeeKobo != null ? { primeFeeKobo: o.primeFeeKobo } : {}) });
  if (!order.ok || order.payment.status !== "awaiting_transfer" || !order.transfer) return { order };

  const due = order.amountDueKobo;
  if (o.maxPayPrimeKobo != null && due > o.maxPayPrimeKobo) {
    const detail = `Prime asks for ₦${due / 100}, more than the ₦${o.maxPayPrimeKobo / 100} the student approved (pack fees?); nothing paid`;
    return { order: { ...order, steps: [...order.steps, detail], payment: { ...order.payment, status: "not_paid", detail } } };
  }

  await bot.markChat?.();
  const allowedPayees = o.allowedPayees ?? payeesFor(order.primeCustomerName);
  const payout = await payPrimeTransfer({ kora: o.kora, transfer: order.transfer, totalKobo: due, reference: o.reference, allowedPayees });
  const steps = [...order.steps, `payout ${payout.status}: ${payout.detail}`];
  const done = (status: PaymentEvidence["status"], detail: string): OrderAndPayResult => ({
    order: { ...order, steps: [...steps, `payment ${status}: ${detail}`], payment: { ...order.payment, status, detail } },
    // The student-facing line follows the final status, not Kora's first answer.
    payout: {
      ...payout,
      message:
        status === "verified" || status === "simulated" ? PAID_MESSAGE
        : status === "uncertain" ? "Your payment is being checked. We'll confirm your order shortly."
        : payout.message,
    },
  });

  switch (payout.status) {
    case "simulated":
      return done("simulated", "test keys: Kora's sandbox took it, Prime was not paid");
    case "blocked":
    case "failed":
      return done("not_paid", payout.detail);
    case "uncertain":
      return done("uncertain", `${payout.detail}; hold, check koraService.verifyPayout("${o.reference}"), never pay again`);
    case "sent":
      break;
  }

  if (!bot.waitForMessage) return done("uncertain", "Kora sent the money but Prime's chat cannot be watched; reconcile");
  const timeout = o.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  let msg: Awaited<ReturnType<NonNullable<PrimeBot["waitForMessage"]>>>;
  try {
    msg = await bot.waitForMessage(PRIME_PAID, timeout);
  } catch (err: any) {
    // The money has gone: losing the chat now must never look like "not paid".
    return done("uncertain", `Kora sent ₦${due / 100} but Prime's chat could not be read (${err?.message ?? err}); hold and reconcile`);
  }
  if (!msg) {
    return done("uncertain", `Kora sent ₦${due / 100} but Prime did not confirm within ${Math.round(timeout / 1000)} s; hold and check verifyPayout("${o.reference}")`);
  }
  // Prime's confirmation may show the total paid or the food alone; anything else is wrong.
  const shown = msg.text.match(NAIRA)?.[1];
  const shownKobo = shown ? Math.round(Number(shown.replace(/,/g, "")) * 100) : undefined;
  if (shownKobo != null && shownKobo !== due && shownKobo !== order.totalKobo) {
    return done("uncertain", `Prime confirmed ₦${shown}, the order is ₦${due / 100}; reconcile`);
  }
  return done("verified", `Prime confirmed: "${msg.text.split("\n").find((l) => PRIME_PAID.test(l))?.trim() ?? msg.text.slice(0, 80)}"`);
}
