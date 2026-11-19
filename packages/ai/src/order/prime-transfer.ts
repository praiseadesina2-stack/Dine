/**
 * Prime's bank-transfer checkout: after checkout Prime may ask for a bank transfer
 * instead of taking the order from a wallet. Format, as recorded by the Backend
 * Engineer's agent (unconfirmed by a supervised order, contracts/ordering.md guarantee 8):
 *
 *   Send ₦2,250 to:
 *   Account number: 9479959026
 *   Bank: Flutterwave MFB
 *   Name: Prime That
 *
 * Parsing only; nothing here moves money (see pay-transfer.ts). Nothing here is a model.
 */

export interface BankTransfer {
  /** 10-digit NUBAN. */
  accountNumber: string;
  bankName: string;
  /** The payee name Prime shows. Absent when the screen has none (a live payment is then refused). */
  accountName?: string;
  /** What Prime asks for, in kobo. */
  amountKobo: number;
}

const ACCOUNT = /^\s*(?:account\s*(?:number|no\.?)?|acc(?:t)?\.?\s*no\.?)\s*:\s*`?(\d{10})`?\s*$/im;
const BANK = /^\s*bank(?:\s*name)?\s*:\s*(.+?)\s*$/im;
const NAME = /^\s*(?:account\s*)?name\s*:\s*(.+?)\s*$/im;
const NAIRA = /₦\s*([\d,]+(?:\.\d{1,2})?)/;
/** Lines that state the amount to send, e.g. "Send ₦2,250 to:", "Amount: ₦2,250", "Transfer ₦2,250". */
const AMOUNT_LINE = /\b(?:send|transfer|pay|amount|total)\b/i;

/** Parses Prime's bank-transfer instructions; null if `text` is not one (no account, bank or amount). */
export function parseBankTransfer(text: string): BankTransfer | null {
  const account = text.match(ACCOUNT)?.[1];
  const bank = text.match(BANK)?.[1];
  if (!account || !bank) return null;
  const amountLine = text.split("\n").find((l) => AMOUNT_LINE.test(l) && NAIRA.test(l));
  const amount = amountLine?.match(NAIRA)?.[1];
  if (!amount) return null;
  const amountKobo = Math.round(Number(amount.replace(/,/g, "")) * 100);
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) return null;
  const name = text.match(NAME)?.[1];
  return { accountNumber: account, bankName: bank, ...(name ? { accountName: name } : {}), amountKobo };
}
