/**
 * What an order costs, per order (not per item), except packs:
 *
 *   food            the tray, at Prime's prices
 *   + packs         Prime's per-item pack charge (e.g. ₦200 on chips), only known on Prime's
 *                   item screen; reserved up to PACK_ALLOWANCE_NAIRA per item, charged as shown
 *   + Prime's fee   ₦600 (PRIME_FEE_NAIRA): Prime adds it at checkout, so Prime is paid food + packs + fee
 *   + Dine's fee    ₦100 (DINE_FEE_NAIRA): Dine's charge, kept in Dine's Kora account
 *
 * The student's wallet reserves the most it could be (with the full pack allowance); once
 * Prime is paid, it is charged what Prime actually asked + Dine's fee, and the rest returns.
 */

const naira = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  const v = Number(raw);
  return Math.round((raw && Number.isFinite(v) && v >= 0 ? v : fallback) * 100);
};

/** Prime's per-order charge, in kobo. */
export const primeFeeKobo = () => naira("PRIME_FEE_NAIRA", 600);
/** Dine's per-order charge, in kobo. */
export const dineFeeKobo = () => naira("DINE_FEE_NAIRA", 100);
/** The most a pack may add per item, in kobo (Prime shows the real amount on the item screen). */
export const packAllowanceKobo = () => naira("PACK_ALLOWANCE_NAIRA", 300);

export interface OrderCharges {
  foodKobo: number;
  /** Most the packs may add: items × allowance. */
  maxPacksKobo: number;
  primeFeeKobo: number;
  dineFeeKobo: number;
  /** The most Dine may pay Prime's virtual account: food + max packs + Prime's fee. */
  payPrimeKobo: number;
  /** The most the student can be charged: payPrimeKobo + Dine's fee. Reserve this. */
  chargeStudentKobo: number;
}

export function orderCharges(
  foodKobo: number,
  items = 1,
  fees: { primeFeeKobo?: number; dineFeeKobo?: number; packAllowanceKobo?: number } = {},
): OrderCharges {
  const p = fees.primeFeeKobo ?? primeFeeKobo();
  const d = fees.dineFeeKobo ?? dineFeeKobo();
  const packs = items * (fees.packAllowanceKobo ?? packAllowanceKobo());
  return { foodKobo, maxPacksKobo: packs, primeFeeKobo: p, dineFeeKobo: d, payPrimeKobo: foodKobo + packs + p, chargeStudentKobo: foodKobo + packs + p + d };
}

/** What the student is actually charged once Prime is paid `paidPrimeKobo`: that + Dine's fee. */
export function studentCharge(paidPrimeKobo: number, dineFee = dineFeeKobo()): number {
  return paidPrimeKobo + dineFee;
}
