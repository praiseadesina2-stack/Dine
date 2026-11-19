/**
 * The Prime ordering flow as a strict state machine (contracts/ordering.md).
 *
 * Prime's bot, as mapped by the crawl (Context/Prime Bot Crawl Map.html, 19 Oct):
 *
 *   /start ─▶ home ("I'm Hungry 🍽️" | "🍽 See all vendors")
 *          ─▶ locations ("Inside Cafeteria · N vendors open" | "Outside Cafeteria · N vendors open")
 *          ─▶ vendor list, paged ("<Vendor>" buttons, "Next ▶")
 *          ─▶ vendor menu, paged ("<Vendor> · 🟢 Active", "Choose <Item>" buttons, "Next ▶")
 *          ─▶ item ("<Item>\n\nPrice: ₦X\n[Pack: ₦Y each]\n\nQty: 1\n[Packs: 1]\n\nTotal: ₦Z", "Add to cart ✓")
 *          ─▶ cart ─▶ checkout        ← NOT MAPPED: the crawler never changed a cart.
 *
 * Every step fails closed: a button is pressed only on an exact (normalised) label
 * match, never a "close enough" one; anything unexpected stops the order with a code.
 * Nothing here is a model.
 *
 * Payment (order/prime-wallet.ts): the order is paid from the Dine-owned Prime account's
 * wallet. The flow reads the wallet before ordering (stops with PRIME_WALLET_LOW, cart
 * untouched, if it cannot cover the total) and again after checkout; only an exact drop
 * by the order total counts as paid.
 */
import { judgePayment, readPrimeWallet, WALLET_PAY_LABELS, type FundingAccount, type PaymentEvidence, type PrimeWallet } from "./prime-wallet.js";

export interface BotButton {
  row: number;
  col: number;
  label: string;
  url?: string;
}

export interface BotScreen {
  text: string;
  buttons: BotButton[];
}

/** One Telegram conversation with Prime's bot. Implementations must wait for the bot's reply. */
export interface PrimeBot {
  /** Send /start and return the bot's reply. */
  start(): Promise<BotScreen>;
  /** Press a button on `screen` and return the screen the bot shows next. */
  click(screen: BotScreen, button: BotButton): Promise<BotScreen>;
}

export interface OrderTarget {
  /** Exactly as on Prime (the catalogue row's vendor name). */
  vendorName: string;
  /** Exactly as on Prime (the catalogue row's meal name). */
  itemName: string;
  /** Prime's item price the student approved, in kobo. The order stops if Prime shows another price. */
  expectedPriceKobo: number;
  /** Where the vendor is listed; both are searched when omitted. */
  location?: "inside_cafeteria" | "outside_cafeteria";
}

export type OrderStage = "start" | "cart_check" | "wallet_check" | "locations" | "vendor_list" | "vendor_menu" | "item" | "add_to_cart" | "cart" | "checkout" | "done";

export type OrderFailure =
  | "CART_NOT_EMPTY"
  | "VENDOR_NOT_FOUND"
  | "VENDOR_CLOSED"
  | "ITEM_NOT_FOUND"
  | "ITEM_MISMATCH"
  | "PRICE_CHANGED"
  | "CART_MISMATCH"
  | "CHECKOUT_UNMAPPED"
  | "INVALID_ORDER"
  | "PRIME_WALLET_LOW"
  | "UNEXPECTED_SCREEN"
  | "BOT_ERROR";

/** PRIME_WALLET_LOW: how much the backend must top up, and where to send it. */
export type TopUp = { shortfallKobo: number; balanceKobo: number; fundingAccount?: FundingAccount };

export type OrderFlowResult =
  | {
      ok: true;
      /** Prime's total for the whole cart (items, quantities, packs), in kobo. This is what Dine pays. */
      totalKobo: number;
      /** Every line as Prime showed it when added. */
      lines: VerifiedLine[];
      paystackUrl?: string;
      /** Prime's order reference, when its confirmation shows one. */
      orderRef?: string;
      /** How the order was paid, proven by the Prime wallet balance. Capture the student's reservation only on "verified". */
      payment: PaymentEvidence;
      steps: string[];
    }
  | {
      ok: false;
      code: OrderFailure;
      stage: OrderStage;
      detail: string;
      /** True once "Add to cart" was pressed: the Dine account's Prime cart may now hold this item. */
      cartTouched: boolean;
      /** Prime's total, once the item screen was read. */
      totalKobo?: number;
      /** PRIME_WALLET_LOW only: how much the backend must top up, and where to send it. */
      topUp?: TopUp;
      /** The tray line the order stopped on, when it stopped on one. */
      item?: { vendorName: string; itemName: string };
      /** Set when checkout was pressed: what the wallet shows about payment. "uncertain" means reconcile before any retry. */
      payment?: PaymentEvidence;
      steps: string[];
    };

// ---------------------------------------------------------------- text helpers

/** Lowercase, emoji and decorative symbols removed, spaces collapsed. "Next ▶" → "next", "I'm Hungry 🍽️" → "i'm hungry". */
export function normalise(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}▶◀✓✔·]/gu, " ")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The button whose label is exactly `label` after normalising, or undefined. Never a partial match. */
export function exactButton(screen: BotScreen, label: string): BotButton | undefined {
  const want = normalise(label);
  const hits = screen.buttons.filter((b) => normalise(b.label) === want);
  return hits.length === 1 ? hits[0] : undefined;
}

const naira = /₦\s*([\d,]+)/;
const kobo = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

export interface ItemScreen {
  name: string;
  priceKobo: number;
  qty: number;
  packKobo?: number;
  packs?: number;
  totalKobo: number;
}

/** Parses Prime's item screen; null if `text` is not one. */
export function parseItemScreen(text: string): ItemScreen | null {
  const lines = text.split("\n").map((l) => l.trim());
  const name = lines.find(Boolean);
  const field = (label: string) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`));
    return line?.slice(label.length + 1).trim();
  };
  const price = field("Price")?.match(naira);
  const total = field("Total")?.match(naira);
  const qty = Number(field("Qty"));
  if (!name || !price || !total || !Number.isInteger(qty)) return null;
  const pack = field("Pack")?.match(naira);
  const packs = field("Packs");
  return {
    name,
    priceKobo: kobo(price[1]),
    qty,
    ...(pack ? { packKobo: kobo(pack[1]) } : {}),
    ...(packs != null ? { packs: Number(packs) } : {}),
    totalKobo: kobo(total[1]),
  };
}

/** "Slash Shawarma · 🟢 Active" on the vendor's menu or in the vendor list. */
function vendorStatus(text: string, vendorName: string): "active" | "closed" | "unknown" {
  const want = normalise(vendorName);
  for (const line of text.split("\n")) {
    const [name, status] = line.split("·").map((s) => s.trim());
    if (status == null || normalise(name) !== want) continue;
    if (/active/i.test(status)) return "active";
    if (/closed/i.test(status)) return "closed";
  }
  return "unknown";
}

const PAYSTACK = /https?:\/\/(?:checkout\.)?paystack\.(?:com|co)\/\S+/i;
const ORDER_REF = /order\s*(?:id|ref(?:erence)?|no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i;
const CONFIRMED = /order\s+(?:has\s+been\s+|was\s+)?(?:placed|confirmed|received)/i;
const EMPTY_CART = /nothing here yet/i;

/**
 * Checkout button labels to accept, exact after normalising. Prime's real labels are
 * unknown until the cart and checkout are mapped with a test account; until then a
 * checkout attempt stops with CHECKOUT_UNMAPPED unless one of these appears.
 */
export const CHECKOUT_LABELS = ["Checkout", "Check out", "Proceed to checkout", "Place order", "Pay now"];

const MAX_PAGES = 6;

// ---------------------------------------------------------------- the flow

/** One tray line. The same vendor and item twice is one line with qty 2 (see mergeLines). */
export interface CartLine extends OrderTarget {
  /** How many (default 1, at most MAX_QTY). Set on Prime's item screen with its "+" button. */
  qty?: number;
}

/** A line as Prime showed it when it was added to the cart. */
export interface VerifiedLine {
  vendorName: string;
  itemName: string;
  qty: number;
  priceKobo: number;
  /** Prime's total for this line (price × qty plus any packs). */
  totalKobo: number;
}

export const MAX_QTY = 10;

/** Same vendor and item (after normalising) become one line with the quantities added. */
export function mergeLines(lines: CartLine[]): CartLine[] {
  const merged = new Map<string, CartLine>();
  for (const line of lines) {
    const key = `${normalise(line.vendorName)}|${normalise(line.itemName)}`;
    const qty = line.qty ?? 1;
    const seen = merged.get(key);
    if (seen) seen.qty = (seen.qty ?? 1) + qty;
    else merged.set(key, { ...line, qty });
  }
  return [...merged.values()];
}

/** The "+" in the quantity row ("1 × ₦1500"), not the packs row ("1 pack × ₦200"). */
function qtyPlusButton(screen: BotScreen): BotButton | undefined {
  const qtyRow = screen.buttons.find((b) => /^\d+\s*×\s*₦/.test(b.label.trim()))?.row;
  if (qtyRow == null) return undefined;
  const plus = screen.buttons.filter((b) => b.row === qtyRow && b.label.trim() === "+");
  return plus.length === 1 ? plus[0] : undefined;
}

/** One item, kept for callers that order a single meal. */
export async function runOrderFlow(bot: PrimeBot, target: OrderTarget): Promise<OrderFlowResult> {
  return runCartOrder(bot, [target]);
}

/**
 * Orders a whole tray from Prime as ONE cart and ONE checkout, items from any vendors.
 *
 *   1. Prime cart empty; read the Prime wallet.
 *   2. Verify every line on Prime (vendor open, exact item, approved price). Cart untouched.
 *   3. The wallet must cover the whole tray, or stop with PRIME_WALLET_LOW. Cart untouched.
 *   4. Add every line, setting its quantity with "+", re-checking price and total.
 *   5. The cart must show every item (and Prime's total, when it shows one).
 *   6. Check out once; pay from the wallet; prove payment by the wallet balance.
 */
export async function runCartOrder(bot: PrimeBot, tray: CartLine[]): Promise<OrderFlowResult> {
  const steps: string[] = [];
  let stage: OrderStage = "start";
  let cartTouched = false;
  let totalKobo: number | undefined;
  let payment: PaymentEvidence | undefined;
  let current: CartLine | undefined;
  /** Set once checkout is pressed: from then on money may have moved. */
  let paymentPending: { amountKobo: number; balanceBeforeKobo: number } | undefined;
  const fail = (code: OrderFailure, detail: string, extra: { topUp?: TopUp } = {}): OrderFlowResult => ({
    ok: false, code, stage, detail, cartTouched,
    ...(totalKobo != null ? { totalKobo } : {}),
    ...(payment ? { payment } : {}),
    ...(current ? { item: { vendorName: current.vendorName, itemName: current.itemName } } : {}),
    ...extra, steps,
  });
  const press = async (screen: BotScreen, label: string, note = label) => {
    const b = exactButton(screen, label);
    if (!b) return null;
    steps.push(`pressed "${b.label}"${note !== label ? ` (${note})` : ""}`);
    return bot.click(screen, b);
  };

  const lines = mergeLines(tray);
  if (!lines.length) return fail("INVALID_ORDER", "the tray is empty");
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty! < 1 || l.qty! > MAX_QTY) {
      current = l;
      return fail("INVALID_ORDER", `quantity ${l.qty} for ${l.itemName} is not between 1 and ${MAX_QTY}`);
    }
  }

  /** Home → vendor → item screen for `line`, checked against what the student approved. */
  const openItem = async (line: CartLine): Promise<{ item: BotScreen; parsed: ItemScreen } | OrderFlowResult> => {
    current = line;
    stage = "locations";
    const home = await bot.start();
    steps.push("sent /start");
    let locations = (await press(home, "I'm Hungry 🍽️")) ?? (await press(home, "🍽 See all vendors"));
    if (!locations) return fail("UNEXPECTED_SCREEN", "home screen has no I'm Hungry / See all vendors button");

    stage = "vendor_list";
    const groups = line.location === "inside_cafeteria" ? ["Inside Cafeteria"] : line.location === "outside_cafeteria" ? ["Outside Cafeteria"] : ["Outside Cafeteria", "Inside Cafeteria"];
    let menu: BotScreen | null = null;
    for (const group of groups) {
      const groupButton = locations.buttons.find((b) => normalise(b.label).startsWith(normalise(group)));
      if (!groupButton) continue;
      steps.push(`pressed "${groupButton.label}"`);
      let list: BotScreen | null = await bot.click(locations, groupButton);
      for (let page = 0; list && page < MAX_PAGES; page++) {
        if (vendorStatus(list.text, line.vendorName) === "closed") return fail("VENDOR_CLOSED", `${line.vendorName} is closed on Prime`);
        menu = await press(list, line.vendorName, "vendor");
        if (menu) break;
        list = await press(list, "Next ▶", "next page");
      }
      if (menu) break;
      if (groups.length > 1) {
        const back = await bot.start();
        locations = (await press(back, "I'm Hungry 🍽️")) ?? (await press(back, "🍽 See all vendors")) ?? locations;
      }
    }
    if (!menu) return fail("VENDOR_NOT_FOUND", `no vendor button named exactly "${line.vendorName}"`);

    stage = "vendor_menu";
    const status = vendorStatus(menu.text, line.vendorName);
    if (status !== "active") return fail(status === "closed" ? "VENDOR_CLOSED" : "UNEXPECTED_SCREEN", `vendor menu shows ${line.vendorName} as ${status}`);
    let item: BotScreen | null = null;
    for (let page = 0, screen: BotScreen | null = menu; screen && page < MAX_PAGES; page++) {
      item = await press(screen, `Choose ${line.itemName}`, "item");
      if (item) break;
      screen = await press(screen, "Next ▶", "next page");
    }
    if (!item) return fail("ITEM_NOT_FOUND", `no button "Choose ${line.itemName}" on ${line.vendorName}'s menu`);

    stage = "item";
    const parsed = parseItemScreen(item.text);
    if (!parsed) return fail("UNEXPECTED_SCREEN", "item screen could not be read");
    if (normalise(parsed.name) !== normalise(line.itemName)) return fail("ITEM_MISMATCH", `Prime opened "${parsed.name}", not "${line.itemName}"`);
    if (parsed.qty !== 1) return fail("UNEXPECTED_SCREEN", `quantity starts at ${parsed.qty}, expected 1`);
    if (parsed.priceKobo !== line.expectedPriceKobo) {
      return fail("PRICE_CHANGED", `${line.itemName}: Prime shows ₦${parsed.priceKobo / 100}, approved ₦${line.expectedPriceKobo / 100}`);
    }
    if (parsed.totalKobo !== parsed.priceKobo + (parsed.packKobo ?? 0) * (parsed.packs ?? 0)) {
      return fail("UNEXPECTED_SCREEN", `${line.itemName}: total ₦${parsed.totalKobo / 100} does not add up`);
    }
    return { item, parsed };
  };

  try {
    // 1. The Dine account's Prime cart must be empty, or this order would carry someone else's items.
    stage = "cart_check";
    const home = await bot.start();
    steps.push("sent /start");
    const cart = await press(home, "🛒 My Cart");
    if (!cart) return fail("UNEXPECTED_SCREEN", "home screen has no My Cart button");
    if (!EMPTY_CART.test(cart.text)) return fail("CART_NOT_EMPTY", "the Prime cart already has items; clear it before ordering");

    let walletBefore: PrimeWallet;
    try {
      walletBefore = await readPrimeWallet(bot);
    } catch (err: any) {
      return fail("UNEXPECTED_SCREEN", `Prime wallet: ${err?.message ?? err}`);
    }
    steps.push(`read Prime wallet: ₦${walletBefore.balanceKobo / 100}`);

    // 2. Verify every line before touching the cart.
    let estimateKobo = 0;
    for (const line of lines) {
      const opened = await openItem(line);
      if ("ok" in opened) return opened;
      const { parsed } = opened;
      // Packs counted per unit here: the larger of the two ways Prime might charge them.
      estimateKobo += parsed.totalKobo * line.qty!;
      steps.push(`verified: ${line.qty} × ${parsed.name} at ₦${parsed.priceKobo / 100}`);
    }
    current = undefined;

    // 3. The wallet must cover the whole tray.
    stage = "wallet_check";
    const topUpFor = (needKobo: number): TopUp => ({
      shortfallKobo: needKobo - walletBefore.balanceKobo,
      balanceKobo: walletBefore.balanceKobo,
      ...(walletBefore.fundingAccount ? { fundingAccount: walletBefore.fundingAccount } : {}),
    });
    totalKobo = estimateKobo;
    if (walletBefore.balanceKobo < estimateKobo) {
      return fail("PRIME_WALLET_LOW", `Prime wallet has ₦${walletBefore.balanceKobo / 100}, the tray needs ₦${estimateKobo / 100}`, { topUp: topUpFor(estimateKobo) });
    }

    // 4. Add every line at its quantity.
    const added: VerifiedLine[] = [];
    for (const line of lines) {
      const opened = await openItem(line);
      if ("ok" in opened) return opened;
      let { item, parsed } = opened;
      stage = "add_to_cart";
      while (parsed.qty < line.qty!) {
        const plus = qtyPlusButton(item);
        if (!plus) return fail("UNEXPECTED_SCREEN", `${line.itemName}: no quantity "+" button`);
        steps.push(`pressed "+" (quantity ${parsed.qty + 1})`);
        item = await bot.click(item, plus);
        const next = parseItemScreen(item.text);
        if (!next || next.qty !== parsed.qty + 1) return fail("UNEXPECTED_SCREEN", `${line.itemName}: quantity did not go up to ${parsed.qty + 1}`);
        parsed = next;
      }
      if (parsed.priceKobo !== line.expectedPriceKobo) {
        return fail("PRICE_CHANGED", `${line.itemName}: Prime shows ₦${parsed.priceKobo / 100}, approved ₦${line.expectedPriceKobo / 100}`);
      }
      if (parsed.totalKobo !== parsed.priceKobo * parsed.qty + (parsed.packKobo ?? 0) * (parsed.packs ?? 0)) {
        return fail("UNEXPECTED_SCREEN", `${line.itemName}: total ₦${parsed.totalKobo / 100} does not add up at quantity ${parsed.qty}`);
      }
      const ok = await press(item, "Add to cart ✓");
      if (!ok) return fail("UNEXPECTED_SCREEN", `${line.itemName}: no Add to cart button`);
      cartTouched = true;
      added.push({ vendorName: line.vendorName, itemName: parsed.name, qty: parsed.qty, priceKobo: parsed.priceKobo, totalKobo: parsed.totalKobo });
      steps.push(`added: ${parsed.qty} × ${parsed.name}, ₦${parsed.totalKobo / 100}`);
    }
    current = undefined;
    totalKobo = added.reduce((sum, l) => sum + l.totalKobo, 0);
    if (walletBefore.balanceKobo < totalKobo) {
      return fail("PRIME_WALLET_LOW", `Prime's cart came to ₦${totalKobo / 100}, more than the ₦${walletBefore.balanceKobo / 100} in the wallet`, { topUp: topUpFor(totalKobo) });
    }

    // 5. The cart shows exactly this tray.
    stage = "cart";
    const again = await bot.start();
    steps.push("sent /start");
    const filled = await press(again, "🛒 My Cart");
    if (!filled || EMPTY_CART.test(filled.text)) return fail("CART_MISMATCH", "the cart is empty after adding the tray");
    const cartText = normalise(filled.text);
    const missing = added.filter((l) => !cartText.includes(normalise(l.itemName)));
    if (missing.length) return fail("CART_MISMATCH", `the cart does not show: ${missing.map((l) => l.itemName).join(", ")}`);
    const shownTotal = filled.text.match(/total[^₦\n]*₦\s*([\d,]+)/i);
    if (shownTotal && kobo(shownTotal[1]) !== totalKobo) {
      return fail("CART_MISMATCH", `Prime's cart total is ₦${kobo(shownTotal[1]) / 100}, the tray is ₦${totalKobo / 100}`);
    }

    // 6. One checkout, paid from the Prime wallet.
    stage = "checkout";
    const checkoutLabel = CHECKOUT_LABELS.find((l) => exactButton(filled, l));
    if (!checkoutLabel) {
      return fail("CHECKOUT_UNMAPPED", `no known checkout button on the cart screen (buttons: ${filled.buttons.map((b) => b.label).join(", ")})`);
    }
    paymentPending = { amountKobo: totalKobo, balanceBeforeKobo: walletBefore.balanceKobo };
    let after = await press(filled, checkoutLabel, "checkout");
    if (!after) return fail("BOT_ERROR", "checkout button could not be pressed");
    // Prime may ask how to pay: always the wallet, never a card or another method.
    const payLabel = WALLET_PAY_LABELS.find((l) => exactButton(after!, l));
    let paidWithWallet = false;
    if (payLabel) {
      const paid = await press(after, payLabel, "pay from Prime wallet");
      if (!paid) return fail("BOT_ERROR", "wallet pay button could not be pressed");
      after = paid;
      paidWithWallet = true;
    }
    const url = after.text.match(PAYSTACK)?.[0] ?? after.buttons.find((b) => b.url && PAYSTACK.test(b.url))?.url;
    const ref = after.text.match(ORDER_REF)?.[1];

    // Proof of payment: the wallet balance, not the checkout message.
    let afterKobo: number | undefined;
    try {
      afterKobo = (await readPrimeWallet(bot)).balanceKobo;
      steps.push(`read Prime wallet: ₦${afterKobo / 100}`);
    } catch {
      steps.push("could not read Prime wallet after checkout");
    }
    payment = {
      method: url && !paidWithWallet ? "paystack_link" : "prime_wallet",
      amountKobo: totalKobo,
      balanceBeforeKobo: walletBefore.balanceKobo,
      ...(afterKobo != null ? { balanceAfterKobo: afterKobo } : {}),
      ...judgePayment(walletBefore.balanceKobo, afterKobo, totalKobo),
    };
    steps.push(`payment ${payment.status}: ${payment.detail}`);

    if (!url && !CONFIRMED.test(after.text)) return fail("UNEXPECTED_SCREEN", "checkout gave neither a payment link nor an order confirmation");

    stage = "done";
    return { ok: true, totalKobo, lines: added, ...(url ? { paystackUrl: url } : {}), ...(ref ? { orderRef: ref } : {}), payment, steps };
  } catch (err: any) {
    if (paymentPending && !payment) {
      payment = { method: "prime_wallet", status: "uncertain", ...paymentPending, detail: "Prime stopped replying after checkout; reconcile the wallet before any retry" };
    }
    return fail("BOT_ERROR", String(err?.message ?? err).slice(0, 200));
  }
}
