/**
 * Prime's own wallet: how Dine pays for the orders the agent places (contracts/ordering.md, "Paying Prime").
 *
 * Prime's wallet screen, as crawled (19 Oct, Context/Prime Bot Crawl Map.html), reached by
 * /start → "💰 Wallet" (or "👤 My Profile" → "💰 My Wallet"):
 *
 *   💰 Your Wallet
 *
 *   Balance: ₦0
 *
 *   🏦 Fund by bank transfer
 *   `9894065716` · Flutterwave MFB (Formerly OK MFB)
 *
 * The Dine-owned Prime account holds a float in this wallet. The backend tops it up with a
 * Kora payout to the funding account shown here; the agent pays each checkout from it and
 * proves the payment by reading the balance before and after. Nothing here is a model.
 */
import { exactButton, type BotScreen, type PrimeBot } from "./prime-flow.js";
import type { BankTransfer } from "./prime-transfer.js";

export interface FundingAccount {
  accountNumber: string;
  bankName: string;
}

export interface PrimeWallet {
  balanceKobo: number;
  /** The bank account that tops this wallet up, when the screen shows one. */
  fundingAccount?: FundingAccount;
}

/** "Balance: ₦1,500" or "Balance: ₦1,500.50", on the wallet screen only. */
const BALANCE = /^balance:\s*₦\s*([\d,]+(?:\.\d{1,2})?)\s*$/im;
/** "`9894065716` · Flutterwave MFB (Formerly OK MFB)": 10-digit NUBAN, then the bank. */
const FUNDING = /`?(\d{10})`?\s*·\s*(.+)$/m;

/** Parses Prime's wallet screen; null if `text` is not one. */
export function parseWalletScreen(text: string): PrimeWallet | null {
  if (!/your wallet/i.test(text)) return null;
  const balance = text.match(BALANCE);
  if (!balance) return null;
  const balanceKobo = Math.round(Number(balance[1].replace(/,/g, "")) * 100);
  if (!Number.isFinite(balanceKobo)) return null;
  const funding = text.match(FUNDING);
  return {
    balanceKobo,
    ...(funding ? { fundingAccount: { accountNumber: funding[1], bankName: funding[2].trim() } } : {}),
  };
}

/** Home screen buttons that open the wallet (the first one present is pressed). */
const WALLET_PATHS: string[][] = [["💰 Wallet"], ["👤 My Profile", "💰 My Wallet"]];

/** Opens Prime's wallet from /start and reads it. Throws if the wallet cannot be reached or read. */
export async function readPrimeWallet(bot: PrimeBot): Promise<PrimeWallet> {
  for (const path of WALLET_PATHS) {
    let screen: BotScreen | null = await bot.start();
    for (const label of path) {
      const b: ReturnType<typeof exactButton> = screen ? exactButton(screen, label) : undefined;
      screen = b && screen ? await bot.click(screen, b) : null;
    }
    if (!screen) continue;
    const wallet = parseWalletScreen(screen.text);
    if (wallet) return wallet;
    throw new Error("Prime's wallet screen could not be read");
  }
  throw new Error("Prime's home screen has no Wallet button");
}

/**
 * Buttons that pay a checkout from the Prime wallet, exact after normalising. Prime's
 * real labels are unknown until checkout is mapped with a test account (ordering.md, guarantee 8).
 */
export const WALLET_PAY_LABELS = ["Pay with wallet", "Pay from wallet", "Pay with Wallet balance", "Use wallet"];

export type PaymentStatus =
  /**
   * Prime took the payment. Wallet: the balance dropped by exactly the order total.
   * Transfer: Kora sent it AND Prime's chat confirmed payment afterwards.
   */
  | "verified"
  /** The wallet did not move: nothing was paid (e.g. Prime returned a Paystack link instead). */
  | "not_paid"
  /** The wallet moved by some other amount, or could not be read after checkout. Reconcile before any retry. */
  | "uncertain"
  /**
   * Prime placed the order and asked for a bank transfer of exactly the order total
   * (`transfer`). Nothing is paid yet: the backend pays it with payPrimeTransfer().
   */
  | "awaiting_transfer"
  /** Kora test keys: the transfer went to Kora's sandbox. Prime was NOT paid. Release the student's hold. */
  | "simulated";

export interface PaymentEvidence {
  method: "prime_wallet" | "paystack_link" | "bank_transfer";
  status: PaymentStatus;
  amountKobo: number;
  /** Wallet payments only: the Prime wallet before checkout. */
  balanceBeforeKobo?: number;
  /** bank_transfer only: where Prime asked the money to go. */
  transfer?: BankTransfer;
  /** Absent when the wallet could not be read after checkout (status is then "uncertain"). */
  balanceAfterKobo?: number;
  detail: string;
}

/** Proof of payment from the wallet's own numbers, not from a checkout message. */
export function judgePayment(beforeKobo: number, afterKobo: number | undefined, amountKobo: number): Pick<PaymentEvidence, "status" | "detail"> {
  if (afterKobo == null) return { status: "uncertain", detail: "the wallet could not be read after checkout" };
  const paid = beforeKobo - afterKobo;
  if (paid === amountKobo) return { status: "verified", detail: `wallet went ₦${beforeKobo / 100} → ₦${afterKobo / 100}` };
  if (paid === 0) return { status: "not_paid", detail: `wallet still ₦${afterKobo / 100}` };
  return { status: "uncertain", detail: `wallet moved by ₦${paid / 100}, order total is ₦${amountKobo / 100}` };
}

export type TopUpStatus = "landed" | "not_yet";

export interface TopUpCheck {
  status: TopUpStatus;
  balanceKobo: number;
  fundingAccount?: FundingAccount;
}

/**
 * After the backend's Kora payout to the funding account: has it reached the Prime wallet?
 * "landed" only when the balance rose by at least `amountKobo` over `previousBalanceKobo`.
 * "not_yet" never means "send again": the payout is reconciled with Kora first.
 */
export function judgeTopUp(previousBalanceKobo: number, wallet: PrimeWallet, amountKobo: number): TopUpCheck {
  const landed = wallet.balanceKobo - previousBalanceKobo >= amountKobo;
  return { status: landed ? "landed" : "not_yet", balanceKobo: wallet.balanceKobo, ...(wallet.fundingAccount ? { fundingAccount: wallet.fundingAccount } : {}) };
}
