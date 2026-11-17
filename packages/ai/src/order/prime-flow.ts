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

export type OrderStage = "start" | "cart_check" | "locations" | "vendor_list" | "vendor_menu" | "item" | "add_to_cart" | "cart" | "checkout" | "done";

export type OrderFailure =
  | "CART_NOT_EMPTY"
  | "VENDOR_NOT_FOUND"
  | "VENDOR_CLOSED"
  | "ITEM_NOT_FOUND"
  | "ITEM_MISMATCH"
  | "PRICE_CHANGED"
  | "CART_MISMATCH"
  | "CHECKOUT_UNMAPPED"
  | "PRIME_WALLET_LOW"
  | "UNEXPECTED_SCREEN"
  | "BOT_ERROR";

export type OrderFlowResult =
  | {
      ok: true;
      /** Prime's total for this order (item plus any packs), in kobo. This is what Dine pays. */
      totalKobo: number;
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
      topUp?: { shortfallKobo: number; balanceKobo: number; fundingAccount?: FundingAccount };
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

export async function runOrderFlow(bot: PrimeBot, target: OrderTarget): Promise<OrderFlowResult> {
  const steps: string[] = [];
  let stage: OrderStage = "start";
  let cartTouched = false;
  let totalKobo: number | undefined;
  let payment: PaymentEvidence | undefined;
  /** Set once checkout is pressed: from then on money may have moved. */
  let paymentPending: { amountKobo: number; balanceBeforeKobo: number } | undefined;
  const fail = (code: OrderFailure, detail: string, extra: { topUp?: { shortfallKobo: number; balanceKobo: number; fundingAccount?: FundingAccount } } = {}): OrderFlowResult => ({
    ok: false, code, stage, detail, cartTouched, ...(totalKobo != null ? { totalKobo } : {}), ...(payment ? { payment } : {}), ...extra, steps,
  });
  const press = async (screen: BotScreen, label: string, note = label) => {
    const b = exactButton(screen, label);
    if (!b) return null;
    steps.push(`pressed "${b.label}"${note !== label ? ` (${note})` : ""}`);
    return bot.click(screen, b);
  };

  try {
    // 1. The Dine account's Prime cart must be empty, or this order would carry someone else's items.
    stage = "cart_check";
    let screen = await bot.start();
    steps.push("sent /start");
    const cart = await press(screen, "🛒 My Cart");
    if (!cart) return fail("UNEXPECTED_SCREEN", "home screen has no My Cart button");
    if (!EMPTY_CART.test(cart.text)) return fail("CART_NOT_EMPTY", "the Prime cart already has items; clear it before ordering");

    // 1b. The Prime wallet balance before ordering: checked against the total at the item
    // screen, and the baseline that proves payment after checkout.
    let walletBefore: PrimeWallet;
    try {
      walletBefore = await readPrimeWallet(bot);
    } catch (err: any) {
      return fail("UNEXPECTED_SCREEN", `Prime wallet: ${err?.message ?? err}`);
    }
    steps.push(`read Prime wallet: ₦${walletBefore.balanceKobo / 100}`);

    // 2. Home → locations.
    stage = "locations";
    screen = await bot.start();
    steps.push("sent /start");
    let locations = (await press(screen, "I'm Hungry 🍽️")) ?? (await press(screen, "🍽 See all vendors"));
    if (!locations) return fail("UNEXPECTED_SCREEN", "home screen has no I'm Hungry / See all vendors button");

    // 3. Vendor list(s): exact vendor name, paging with Next.
    stage = "vendor_list";
    const groups = target.location === "inside_cafeteria" ? ["Inside Cafeteria"] : target.location === "outside_cafeteria" ? ["Outside Cafeteria"] : ["Outside Cafeteria", "Inside Cafeteria"];
    let menu: BotScreen | null = null;
    for (const group of groups) {
      const groupButton = locations.buttons.find((b) => normalise(b.label).startsWith(normalise(group)));
      if (!groupButton) continue;
      steps.push(`pressed "${groupButton.label}"`);
      let list: BotScreen | null = await bot.click(locations, groupButton);
      for (let page = 0; list && page < MAX_PAGES; page++) {
        if (vendorStatus(list.text, target.vendorName) === "closed") {
          return fail("VENDOR_CLOSED", `${target.vendorName} is closed on Prime`);
        }
        menu = await press(list, target.vendorName, "vendor");
        if (menu) break;
        list = await press(list, "Next ▶", "next page");
      }
      if (menu) break;
      // Back to the locations screen for the other group.
      if (groups.length > 1) {
        const back = await bot.start();
        locations = (await press(back, "I'm Hungry 🍽️")) ?? (await press(back, "🍽 See all vendors")) ?? locations;
      }
    }
    if (!menu) return fail("VENDOR_NOT_FOUND", `no vendor button named exactly "${target.vendorName}"`);

    // 4. Vendor menu: must be active; exact "Choose <item>", paging with Next.
    stage = "vendor_menu";
    const status = vendorStatus(menu.text, target.vendorName);
    if (status !== "active") return fail(status === "closed" ? "VENDOR_CLOSED" : "UNEXPECTED_SCREEN", `vendor menu shows ${target.vendorName} as ${status}`);
    let item: BotScreen | null = null;
    for (let page = 0, current: BotScreen | null = menu; current && page < MAX_PAGES; page++) {
      item = await press(current, `Choose ${target.itemName}`, "item");
      if (item) break;
      current = await press(current, "Next ▶", "next page");
    }
    if (!item) return fail("ITEM_NOT_FOUND", `no button "Choose ${target.itemName}" on ${target.vendorName}'s menu`);

    // 5. Item screen: same item, quantity 1, the approved price.
    stage = "item";
    const parsed = parseItemScreen(item.text);
    if (!parsed) return fail("UNEXPECTED_SCREEN", "item screen could not be read");
    totalKobo = parsed.totalKobo;
    if (normalise(parsed.name) !== normalise(target.itemName)) return fail("ITEM_MISMATCH", `Prime opened "${parsed.name}", not "${target.itemName}"`);
    if (parsed.qty !== 1) return fail("UNEXPECTED_SCREEN", `quantity is ${parsed.qty}, expected 1`);
    if (parsed.priceKobo !== target.expectedPriceKobo) {
      return fail("PRICE_CHANGED", `Prime shows ₦${parsed.priceKobo / 100}, approved ₦${target.expectedPriceKobo / 100}`);
    }
    const expectedTotal = parsed.priceKobo + (parsed.packKobo ?? 0) * (parsed.packs ?? 0);
    if (parsed.totalKobo !== expectedTotal) return fail("UNEXPECTED_SCREEN", `total ₦${parsed.totalKobo / 100} does not add up`);
    steps.push(`item verified: ${parsed.name}, total ₦${parsed.totalKobo / 100}`);
    if (walletBefore.balanceKobo < parsed.totalKobo) {
      const shortfallKobo = parsed.totalKobo - walletBefore.balanceKobo;
      return fail("PRIME_WALLET_LOW", `Prime wallet has ₦${walletBefore.balanceKobo / 100}, order needs ₦${parsed.totalKobo / 100}`, {
        topUp: { shortfallKobo, balanceKobo: walletBefore.balanceKobo, ...(walletBefore.fundingAccount ? { fundingAccount: walletBefore.fundingAccount } : {}) },
      });
    }

    // 6. Add to cart.
    stage = "add_to_cart";
    const added = await press(item, "Add to cart ✓");
    if (!added) return fail("UNEXPECTED_SCREEN", "item screen has no Add to cart button");
    cartTouched = true;

    // 7. Cart: exactly this item. 8. Checkout. Both unmapped (see CHECKOUT_LABELS).
    stage = "cart";
    const home = await bot.start();
    steps.push("sent /start");
    const filled = await press(home, "🛒 My Cart");
    if (!filled || EMPTY_CART.test(filled.text)) return fail("CART_MISMATCH", "the item is not in the cart after Add to cart");
    if (!normalise(filled.text).includes(normalise(target.itemName))) return fail("CART_MISMATCH", "the cart does not show the ordered item");

    stage = "checkout";
    const checkoutLabel = CHECKOUT_LABELS.find((l) => exactButton(filled, l));
    if (!checkoutLabel) {
      return fail("CHECKOUT_UNMAPPED", `no known checkout button on the cart screen (buttons: ${filled.buttons.map((b) => b.label).join(", ")})`);
    }
    paymentPending = { amountKobo: parsed.totalKobo, balanceBeforeKobo: walletBefore.balanceKobo };
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

    // Proof of payment: the wallet balance, not the checkout message. From here on
    // money may have moved, so every outcome carries the evidence.
    let afterKobo: number | undefined;
    try {
      afterKobo = (await readPrimeWallet(bot)).balanceKobo;
      steps.push(`read Prime wallet: ₦${afterKobo / 100}`);
    } catch {
      steps.push("could not read Prime wallet after checkout");
    }
    const judged = judgePayment(walletBefore.balanceKobo, afterKobo, parsed.totalKobo);
    payment = {
      method: url && !paidWithWallet ? "paystack_link" : "prime_wallet",
      amountKobo: parsed.totalKobo,
      balanceBeforeKobo: walletBefore.balanceKobo,
      ...(afterKobo != null ? { balanceAfterKobo: afterKobo } : {}),
      ...judged,
    };
    steps.push(`payment ${payment.status}: ${payment.detail}`);

    if (!url && !CONFIRMED.test(after.text)) return fail("UNEXPECTED_SCREEN", "checkout gave neither a payment link nor an order confirmation");

    stage = "done";
    return { ok: true, totalKobo: parsed.totalKobo, ...(url ? { paystackUrl: url } : {}), ...(ref ? { orderRef: ref } : {}), payment, steps };
  } catch (err: any) {
    if (paymentPending && !payment) {
      payment = { method: "prime_wallet", status: "uncertain", ...paymentPending, detail: "Prime stopped replying after checkout; reconcile the wallet before any retry" };
    }
    return fail("BOT_ERROR", String(err?.message ?? err).slice(0, 200));
  }
}
