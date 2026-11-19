/**
 * What an order costs, per order (not per item):
 *
 *   food            the tray, at Prime's prices
 *   + Prime's fee   ₦600 (PRIME_FEE_NAIRA): Prime adds it at checkout, so Prime is paid food + fee
 *   + Dine's fee    ₦100 (DINE_FEE_NAIRA): Dine's charge, kept in Dine's Kora account
 *   = the student is charged food + Prime's fee + Dine's fee
 */

const naira = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Math.round((Number.isFinite(v) && v >= 0 && process.env[name]?.trim() ? v : fallback) * 100);
};

/** Prime's per-order charge, in kobo. */
export const primeFeeKobo = () => naira("PRIME_FEE_NAIRA", 600);
/** Dine's per-order charge, in kobo. */
export const dineFeeKobo = () => naira("DINE_FEE_NAIRA", 100);

export interface OrderCharges {
  foodKobo: number;
  primeFeeKobo: number;
  dineFeeKobo: number;
  /** What Dine pays Prime's virtual account: food + Prime's fee. */
  payPrimeKobo: number;
  /** What the student's wallet is charged: food + Prime's fee + Dine's fee. Reserve this. */
  chargeStudentKobo: number;
}

export function orderCharges(foodKobo: number, fees: { primeFeeKobo?: number; dineFeeKobo?: number } = {}): OrderCharges {
  const p = fees.primeFeeKobo ?? primeFeeKobo();
  const d = fees.dineFeeKobo ?? dineFeeKobo();
  return { foodKobo, primeFeeKobo: p, dineFeeKobo: d, payPrimeKobo: foodKobo + p, chargeStudentKobo: foodKobo + p + d };
}
