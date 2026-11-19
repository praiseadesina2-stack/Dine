/**
 * Paying a Prime order by bank transfer through Kora (contracts/ordering.md, "Paying Prime").
 *
 * The ordering flow returns `transfer` (payment "awaiting_transfer") when Prime's checkout
 * asks for a bank transfer. This sends it, but only after every guard passes:
 *
 *   1. Prime's amount equals the cart the flow verified line by line.
 *   2. The account number is a 10-digit NUBAN.
 *   3. Live only: the payee name Prime shows, and the name the bank returns for the
 *      account (Kora resolve), both match an allowed Prime payee (PRIME_PAYEE_NAMES).
 *   4. Live only: Kora's own bank list names the bank; no guessed or fallback bank code.
 *   5. One reference, created by the caller before the call. Never resent by this function.
 *
 * With Kora test keys nothing is paid: Kora sends to its sandbox account and the result is
 * "simulated", never "sent". Prime is NOT paid in test mode; the student-facing `message`
 * still reads "Payment received, order has been confirmed" so testers see the real flow.
 *
 * Prime makes a new virtual account per checkout, named after the Prime customer's
 * username. All Dine orders use one Prime account, so the allowed payee is that username.
 */
import type { BankTransfer } from "./prime-transfer.js";
import type { KoraDisbursementPayload, KoraDisbursementResult, AccountResolveResult } from "../kora.js";

export type TransferStatus =
  /** Test keys: Kora's sandbox accepted the payout. No money moved; Prime was not paid. */
  | "simulated"
  /** Live: Kora accepted the payout. Confirm with kora.verifyPayout(reference) before capturing. */
  | "sent"
  /** Kora rejected the payout outright. No money moved: release the student's reservation. */
  | "failed"
  /** A guard stopped it before Kora was called. No money moved: release, and alert if it was the payee check. */
  | "blocked"
  /** Unknown whether money moved (network error, unclear Kora reply). Hold; reconcile with verifyPayout. Never resend. */
  | "uncertain";

export interface TransferPayment {
  status: TransferStatus;
  reference: string;
  amountKobo: number;
  transfer: BankTransfer;
  /** The account holder's name as the bank returned it (live only). */
  resolvedName?: string;
  /** Kora's own payout status, when Kora answered. */
  koraStatus?: string;
  /** What happened, for logs. */
  detail: string;
  /** A short line for the student. */
  message: string;
  /** Every guard and its outcome, for the audit trail. */
  checks: string[];
}

/** The parts of KoraPaymentService this uses (tests pass a fake). */
export interface KoraPayouts {
  isConfigured(): boolean;
  isTestMode(): boolean;
  findBankCode(bankName: string): Promise<string | null>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<AccountResolveResult>;
  disburse(payload: KoraDisbursementPayload): Promise<KoraDisbursementResult>;
}

/** What the student sees once the payment went through (and, with test keys, once the sandbox took it). */
export const PAID_MESSAGE = "Payment received, order has been confirmed";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/** True when every word of an allowed payee name appears in `name` ("PRIME THAT LTD" matches "Prime That"). */
export function payeeAllowed(name: string | undefined, allowed: string[]): boolean {
  if (!name) return false;
  const have = new Set(words(name));
  return allowed.some((a) => {
    const need = words(a);
    return need.length > 0 && need.every((w) => have.has(w));
  });
}

function allowedFromEnv(): string[] {
  return (process.env.PRIME_PAYEE_NAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function payPrimeTransfer(args: {
  kora: KoraPayouts;
  /** From the order result: `result.transfer`. */
  transfer: BankTransfer;
  /** From the order result: `result.totalKobo`, the verified cart. */
  totalKobo: number;
  /** Unique, created and stored by the caller BEFORE this call (e.g. the reservation id). */
  reference: string;
  /** Allowed Prime payee names; default PRIME_PAYEE_NAMES (comma-separated). Required for live payments. */
  allowedPayees?: string[];
  narration?: string;
}): Promise<TransferPayment> {
  const { kora, transfer, totalKobo, reference } = args;
  const checks: string[] = [];
  const base = { reference, amountKobo: totalKobo, transfer, checks };
  const naira = `₦${(totalKobo / 100).toLocaleString("en-NG")}`;
  const block = (detail: string): TransferPayment => ({
    ...base, status: "blocked", detail, message: `Payment to Prime stopped before any money moved: ${detail}`,
  });

  if (!reference?.trim()) return block("no payment reference");
  if (!kora.isConfigured()) return block("Kora is not configured (KORA_SECRET_KEY)");
  if (!Number.isInteger(totalKobo) || totalKobo <= 0) return block("no verified order total");
  if (transfer.amountKobo !== totalKobo) {
    return block(`Prime asks for ₦${transfer.amountKobo / 100}, the verified cart is ${naira}`);
  }
  checks.push(`amount ${naira} matches the verified cart`);
  if (!/^\d{10}$/.test(transfer.accountNumber)) return block(`"${transfer.accountNumber}" is not a 10-digit account number`);
  checks.push("account number is 10 digits");

  const test = kora.isTestMode();
  let bankCode = "";
  let resolvedName: string | undefined;
  if (test) {
    checks.push("test mode: payee and bank checks skipped; Kora pays its sandbox account, not Prime");
  } else {
    const allowed = args.allowedPayees ?? allowedFromEnv();
    if (!allowed.length) return block("no allowed Prime payee names (set PRIME_PAYEE_NAMES)");
    if (!payeeAllowed(transfer.accountName, allowed)) {
      return block(`Prime's payee "${transfer.accountName ?? "(none shown)"}" is not an allowed Prime payee`);
    }
    checks.push(`payee shown by Prime "${transfer.accountName}" is allowed`);
    const code = await kora.findBankCode(transfer.bankName);
    if (!code) return block(`Kora does not list a bank named "${transfer.bankName}"`);
    bankCode = code;
    checks.push(`bank "${transfer.bankName}" is code ${code}`);
    const resolved = await kora.resolveAccount(transfer.accountNumber, bankCode);
    if (!resolved.success || !resolved.accountName) return block(`account ${transfer.accountNumber} could not be verified: ${resolved.message ?? "no name returned"}`);
    resolvedName = resolved.accountName;
    if (!payeeAllowed(resolvedName, allowed)) return block(`account ${transfer.accountNumber} belongs to "${resolvedName}", not an allowed Prime payee`);
    checks.push(`bank says the account belongs to "${resolvedName}"`);
  }

  let r: KoraDisbursementResult;
  try {
    r = await kora.disburse({
      bankCode: bankCode || "033",
      accountNumber: transfer.accountNumber,
      amount: totalKobo / 100,
      reference,
      narration: args.narration ?? "Dine meal order",
      customerName: resolvedName ?? transfer.accountName ?? "Prime",
    });
  } catch (err: any) {
    return { ...base, ...(resolvedName ? { resolvedName } : {}), status: "uncertain", detail: `Kora call failed: ${err?.message ?? err}`, message: "Payment to Prime is being checked; nothing will be sent again until it is." };
  }
  const extra = { ...(resolvedName ? { resolvedName } : {}), koraStatus: r.status };

  if (test) {
    // The student-facing line reads like a real payment so testers see the real flow; the
    // status ("simulated") and detail keep the truth for the backend and the logs.
    return r.success
      ? { ...base, ...extra, status: "simulated", detail: `Kora sandbox accepted ${naira} (ref ${reference}); no money moved, Prime not paid`, message: PAID_MESSAGE }
      : { ...base, ...extra, status: "failed", detail: `Kora sandbox refused: ${r.message}`, message: `Test payment failed: ${r.message}` };
  }
  if (r.success) {
    return { ...base, ...extra, status: "sent", detail: `Kora accepted ${naira} to ${transfer.accountNumber} (ref ${reference}, ${r.status})`, message: "Payment sent, waiting for Prime to confirm…" };
  }
  if (r.raw?.data?.status === "failed") {
    return { ...base, ...extra, status: "failed", detail: `Kora refused the payout: ${r.message}`, message: "Payment to Prime failed; the order was not paid." };
  }
  return { ...base, ...extra, status: "uncertain", detail: `Kora's reply was unclear (${r.status}): ${r.message}`, message: "Payment to Prime is being checked; nothing will be sent again until it is." };
}
