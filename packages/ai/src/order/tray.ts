/**
 * The bot's tray → the agent's order lines (contracts/ordering.md, "Ordering a tray").
 *
 * The bot keeps tray items in naira, as shown to the student. The agent works in kobo
 * and orders only exact Prime catalogue rows, so this is the one place the two meet:
 *
 *   const lines = trayToCartLines(getTray(userId));
 *   if (!lines.ok) return reply(lines.problems.join("\n"));
 *   const result = await agent.placeTrayOrder(lines.lines);
 */
import { mergeLines, MAX_QTY, type CartLine } from "./prime-flow.js";
import { orderCharges, type OrderCharges } from "./charges.js";

/** A tray item as the bot stores it. Extra fields are ignored. */
export interface TrayItemInput {
  /** Exactly as on Prime (MealSuggestion.items[].name). */
  itemName: string;
  /** Exactly as on Prime (MealSuggestion.vendorName). */
  vendorName: string;
  /** Naira, the price the student saw and approved (MealSuggestion.items[].price). */
  price: number;
  /** MealSuggestion.location; both cafeteria groups are searched when missing. */
  location?: "inside_cafeteria" | "outside_cafeteria";
  qty?: number;
}

export type TrayConversion =
  | {
      ok: true;
      lines: CartLine[];
      /** The food alone, at the prices the student approved. */
      totalKobo: number;
      /**
       * Food + Prime's ₦600 + Dine's ₦100 (charges.ts). Reserve `charges.chargeStudentKobo`
       * in the student's wallet; pass `charges.payPrimeKobo` to placeTrayOrder as the most
       * the agent may pay Prime.
       */
      charges: OrderCharges;
    }
  | { ok: false; problems: string[] };

/**
 * Checks and converts a tray. Refuses (never guesses) when an item has no vendor, a
 * placeholder vendor, or no real price: those cannot be matched exactly on Prime.
 * Duplicates become one line with a quantity.
 */
export function trayToCartLines(tray: TrayItemInput[]): TrayConversion {
  const problems: string[] = [];
  if (!tray.length) problems.push("The tray is empty.");
  const raw: CartLine[] = [];
  for (const t of tray) {
    const name = t.itemName?.trim();
    const vendor = t.vendorName?.trim();
    if (!name) { problems.push("A tray item has no name."); continue; }
    if (!vendor || /^prime vendor$/i.test(vendor)) { problems.push(`${name}: no Prime vendor, so it cannot be ordered.`); continue; }
    if (!Number.isFinite(t.price) || t.price <= 0) { problems.push(`${name}: no price, so it cannot be ordered.`); continue; }
    raw.push({
      vendorName: vendor,
      itemName: name,
      expectedPriceKobo: Math.round(t.price * 100),
      ...(t.location ? { location: t.location } : {}),
      qty: t.qty ?? 1,
    });
  }
  const lines = mergeLines(raw);
  for (const l of lines) {
    if (l.qty! > MAX_QTY) problems.push(`${l.itemName}: at most ${MAX_QTY} of one item per order.`);
  }
  if (problems.length) return { ok: false, problems };
  const totalKobo = lines.reduce((s, l) => s + l.expectedPriceKobo * l.qty!, 0);
  return { ok: true, lines, totalKobo, charges: orderCharges(totalKobo) };
}
