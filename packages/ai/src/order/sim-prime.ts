/**
 * A simulated Prime bot for tests and the payment demo. It replays the REAL screens
 * crawled from @orderfromprimebot (fixtures/prime-crawl.json, 19 Oct) and the real
 * wallet screen format. The cart, checkout and payment screens were never crawled, so
 * those are SYNTHETIC and set per scenario through FakeOptions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalise, parseItemScreen, type BotButton, type BotScreen, type PrimeBot } from "./prime-flow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const crawl = JSON.parse(fs.readFileSync(path.join(here, "fixtures/prime-crawl.json"), "utf8")) as {
  start: string;
  screens: { id: string; kind: string; label: string; text: string; buttons: (BotButton & { to?: string })[] }[];
};
const byId = new Map(crawl.screens.map((s) => [s.id, s]));
export const itemScreen = (name: string) => crawl.screens.find((s) => s.kind === "item" && s.label === name)!;

export interface FakeOptions {
  /** Items already in the Prime cart before the order starts. */
  cartAtStart?: string[];
  /** SYNTHETIC: buttons on a non-empty cart screen. */
  cartButtons?: string[];
  /** SYNTHETIC: what pressing the checkout button shows. */
  checkoutReply?: BotScreen;
  /** Change the price Prime shows on item screens (kobo → naira text). */
  priceOverride?: Record<string, number>;
  /** Make a vendor's menu (and its list line) say Closed. */
  closed?: string[];
  /** Prime wallet balance at the start, in kobo (default ₦10,000). */
  walletKobo?: number;
  /** SYNTHETIC: pressing this button on the checkout reply pays the cart from the wallet. */
  walletPayButton?: { label: string; reply: BotScreen };
  /** SYNTHETIC: amount the wallet loses at checkout, when it differs from the cart total (to test "uncertain"). */
  chargeOverrideKobo?: number;
  /** Throw on the first wallet read after checkout (Prime stops replying). */
  failAfterCheckout?: boolean;
  /** SYNTHETIC: the "Total" the cart screen shows, when it should disagree with the items (default: the real sum). */
  cartTotalOverrideKobo?: number;
  /** SYNTHETIC: what Prime says in the chat after a transfer lands (none: Prime stays silent). */
  paidMessage?: string;
  /** Prime's per-order fee charged at checkout, in kobo (default ₦600). */
  primeFeeKobo?: number;
}

/** Prime's wallet screen, in the exact format crawled on 19 Oct. */
export const walletText = (kobo: number) =>
  `💰 Your Wallet\n\nBalance: ₦${(kobo / 100).toLocaleString("en-NG")}\n\n🏦 Fund by bank transfer\n\`9894065716\` · Flutterwave MFB (Formerly OK MFB)`;

/** Replays crawled screens; keeps a cart so Add to cart and My Cart behave like a real bot. */
export class FakePrime implements PrimeBot {
  /** Item names in the cart, one per line. */
  cart: string[];
  /** Quantities per cart line, same order as `cart`. */
  cartQty: number[] = [];
  clicks: string[] = [];
  walletKobo: number;
  private current = "";
  /** Quantity shown on the open item screen. */
  private qty = 1;
  private checkedOut = false;
  /** Cart total in kobo, from the item screens added. */
  private cartKobo = 0;

  constructor(private o: FakeOptions = {}) {
    this.cart = [...(o.cartAtStart ?? [])];
    this.cartQty = this.cart.map(() => 1);
    this.walletKobo = o.walletKobo ?? 1_000_000;
  }

  /** A bank transfer reaching the Prime funding account (in the demo: a Kora payout). */
  topUp(kobo: number) {
    this.walletKobo += kobo;
  }

  private pay() {
    // Prime charges the cart plus its per-order fee (₦600 unless a scenario sets another).
    this.walletKobo -= this.o.chargeOverrideKobo ?? this.cartKobo + (this.o.primeFeeKobo ?? 60_000);
  }

  private screen(id: string, qty = 1): BotScreen {
    const s = byId.get(id)!;
    this.current = id;
    this.qty = qty;
    let text = s.text;
    for (const v of this.o.closed ?? []) text = text.replace(`${v} · 🟢 Active`, `${v} · 🔴 Closed`);
    if (s.kind === "item" && this.o.priceOverride?.[s.label] != null) {
      const naira = this.o.priceOverride[s.label] / 100;
      text = text.replace(/Price: ₦\d+/, `Price: ₦${naira}`).replace(/Total: ₦\d+/, `Total: ₦${naira}`);
    }
    let buttons = s.buttons.map(({ to: _to, ...b }) => b);
    if (s.kind === "item" && qty !== 1) {
      // Prime re-renders the item screen with the new quantity and total (packs stay as set).
      const p = parseItemScreen(text)!;
      const total = p.priceKobo * qty + (p.packKobo ?? 0) * (p.packs ?? 0);
      text = text.replace(/Qty: \d+/, `Qty: ${qty}`).replace(/Total: ₦[\d,]+/, `Total: ₦${total / 100}`);
      buttons = buttons.map((b) => (/^\d+ × ₦/.test(b.label) ? { ...b, label: b.label.replace(/^\d+/, String(qty)) } : b));
    }
    return { text, buttons };
  }

  async start() {
    return this.screen(crawl.start);
  }

  /** Times markChat was called (the payment watch starts from the last one). */
  marks = 0;

  async markChat() {
    this.marks++;
  }

  async waitForMessage(pattern: RegExp, _timeoutMs: number): Promise<BotScreen | null> {
    const text = this.o.paidMessage;
    return this.marks > 0 && text && pattern.test(text) ? { text, buttons: [] } : null;
  }

  async click(screen: BotScreen, button: BotButton): Promise<BotScreen> {
    this.clicks.push(button.label);
    const node = byId.get(this.current)!;
    if (normalise(button.label) === "my cart") {
      if (!this.cart.length) return this.screen(crawl.screens.find((s) => s.label === "Cart (empty)")!.id);
      // SYNTHETIC cart screen.
      const total = this.o.cartTotalOverrideKobo ?? this.cartKobo;
      return {
        text: `🛒 Your Cart\n\n${this.cart.map((i, n) => `${i} × ${this.cartQty[n]}`).join("\n")}\n\nTotal: ₦${(total / 100).toLocaleString("en-NG")}`,
        buttons: (this.o.cartButtons ?? []).map((label, col) => ({ row: 0, col, label })),
      };
    }
    if (normalise(button.label) === "wallet") {
      if (this.checkedOut && this.o.failAfterCheckout) throw new Error("Prime did not reply in time");
      return { text: walletText(this.walletKobo), buttons: [{ row: 0, col: 0, label: "➕ Top up" }, { row: 0, col: 1, label: "All transactions" }] };
    }
    if (node.kind === "item" && button.label.trim() === "+" && button.row === 0) {
      return this.screen(this.current, this.qty + 1);
    }
    if (normalise(button.label) === "add to cart") {
      const qty = this.qty;
      this.cart.push(node.label);
      this.cartQty.push(qty);
      this.cartKobo += parseItemScreen(this.screen(this.current, qty).text)!.totalKobo;
      return { text: "✅ Added to cart", buttons: [] };
    }
    if (this.o.walletPayButton && button.label === this.o.walletPayButton.label) {
      this.pay();
      return this.o.walletPayButton.reply;
    }
    if (this.o.checkoutReply && (this.o.cartButtons ?? []).includes(button.label)) {
      this.checkedOut = true;
      // Without a wallet-choice step, a confirmation means Prime charged the wallet directly.
      if (!this.o.walletPayButton && !/paystack/i.test(this.o.checkoutReply.text)) this.pay();
      return this.o.checkoutReply;
    }
    const to = node.buttons.find((b) => b.row === button.row && b.col === button.col)?.to;
    if (!to) throw new Error(`fixture has no screen behind "${button.label}"`);
    return this.screen(to);
  }
}
