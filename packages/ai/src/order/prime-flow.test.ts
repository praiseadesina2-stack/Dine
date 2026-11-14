/**
 * The ordering flow against Prime's real screens (fixtures/prime-crawl.json, from the
 * crawl of @orderfromprimebot). Cart and checkout were never crawled, so those two
 * screens are SYNTHETIC here and marked as such.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exactButton, normalise, parseItemScreen, runOrderFlow, type BotButton, type BotScreen, type OrderTarget, type PrimeBot } from "./prime-flow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const crawl = JSON.parse(fs.readFileSync(path.join(here, "fixtures/prime-crawl.json"), "utf8")) as {
  start: string;
  screens: { id: string; kind: string; label: string; text: string; buttons: (BotButton & { to?: string })[] }[];
};
const byId = new Map(crawl.screens.map((s) => [s.id, s]));
const itemScreen = (name: string) => crawl.screens.find((s) => s.kind === "item" && s.label === name)!;

interface FakeOptions {
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
}

/** Replays crawled screens; keeps a cart so Add to cart and My Cart behave like a real bot. */
class FakePrime implements PrimeBot {
  cart: string[];
  clicks: string[] = [];
  private current = "";

  constructor(private o: FakeOptions = {}) {
    this.cart = [...(o.cartAtStart ?? [])];
  }

  private screen(id: string): BotScreen {
    const s = byId.get(id)!;
    this.current = id;
    let text = s.text;
    for (const v of this.o.closed ?? []) text = text.replace(`${v} · 🟢 Active`, `${v} · 🔴 Closed`);
    if (s.kind === "item" && this.o.priceOverride?.[s.label] != null) {
      const naira = this.o.priceOverride[s.label] / 100;
      text = text.replace(/Price: ₦\d+/, `Price: ₦${naira}`).replace(/Total: ₦\d+/, `Total: ₦${naira}`);
    }
    return { text, buttons: s.buttons.map(({ to: _to, ...b }) => b) };
  }

  async start() {
    return this.screen(crawl.start);
  }

  async click(screen: BotScreen, button: BotButton): Promise<BotScreen> {
    this.clicks.push(button.label);
    const node = byId.get(this.current)!;
    if (normalise(button.label) === "my cart") {
      if (!this.cart.length) return this.screen(crawl.screens.find((s) => s.label === "Cart (empty)")!.id);
      // SYNTHETIC cart screen.
      return {
        text: `🛒 Your Cart\n\n${this.cart.map((i) => `${i} × 1`).join("\n")}`,
        buttons: (this.o.cartButtons ?? []).map((label, col) => ({ row: 0, col, label })),
      };
    }
    if (normalise(button.label) === "add to cart") {
      this.cart.push(node.label);
      return { text: "✅ Added to cart", buttons: [] };
    }
    if (this.o.checkoutReply && (this.o.cartButtons ?? []).includes(button.label)) return this.o.checkoutReply;
    const to = node.buttons.find((b) => b.row === button.row && b.col === button.col)?.to;
    if (!to) throw new Error(`fixture has no screen behind "${button.label}"`);
    return this.screen(to);
  }
}

const shawarma: OrderTarget = { vendorName: "Slash Shawarma", itemName: "Shawarma + 1 Sausage", expectedPriceKobo: 200_000 };

test("exact matching: similar names and empty labels never match", () => {
  const s: BotScreen = {
    text: "",
    buttons: [
      { row: 0, col: 0, label: "Choose Shawarma + 1 Sausage & Extra Chicken" },
      { row: 1, col: 0, label: "" },
      { row: 2, col: 0, label: "Next ▶" },
    ],
  };
  assert.equal(exactButton(s, "Choose Shawarma + 1 Sausage"), undefined);
  assert.equal(exactButton(s, "Next ▶")?.row, 2);
  assert.equal(exactButton(s, "next"), exactButton(s, "Next ▶"), "decorations are ignored, words are not");
  assert.equal(normalise("I’m Hungry 🍽️"), "i'm hungry");
});

test("item screen parsing, with and without packs", () => {
  assert.deepEqual(parseItemScreen(itemScreen("Shawarma + 1 Sausage").text), { name: "Shawarma + 1 Sausage", priceKobo: 200_000, qty: 1, totalKobo: 200_000 });
  const chips = parseItemScreen("Chips (Small)\n\n\nPrice: ₦1500\nPack: ₦200 each\n\nQty: 1\nPacks: 1\n\nTotal: ₦1700");
  assert.deepEqual(chips, { name: "Chips (Small)", priceKobo: 150_000, qty: 1, packKobo: 20_000, packs: 1, totalKobo: 170_000 });
  assert.equal(parseItemScreen("Slash Shawarma · 🟢 Active"), null);
});

test("walks Prime's real screens to the exact item and adds only that to the cart", async () => {
  const bot = new FakePrime();
  const r = await runOrderFlow(bot, shawarma);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.code === "CHECKOUT_UNMAPPED", "checkout labels are unknown until the cart is mapped");
  assert.deepEqual(bot.cart, ["Shawarma + 1 Sausage"]);
  assert.ok(bot.clicks.includes("Choose Shawarma + 1 Sausage"));
  assert.ok(!bot.clicks.some((c) => /Extra Chicken/.test(c)), "never presses a similar item");
  assert.ok(!r.ok && r.cartTouched && r.totalKobo === 200_000);
});

test("pages through vendor lists and menus (Grandpa Chips is on list page 3)", async () => {
  const bot = new FakePrime();
  const chips = crawl.screens.find((s) => s.kind === "item" && /Grandpa|Chips/.test(s.label) && /Pack:/.test(s.text))!;
  const parsed = parseItemScreen(chips.text)!;
  const r = await runOrderFlow(bot, { vendorName: "Grandpa Chips", itemName: parsed.name, expectedPriceKobo: parsed.priceKobo });
  assert.ok(!r.ok && r.code === "CHECKOUT_UNMAPPED", JSON.stringify(r));
  assert.equal(r.totalKobo, parsed.totalKobo, "total includes the pack");
  assert.ok(bot.clicks.filter((c) => c === "Next ▶").length >= 2);
});

test("a full checkout succeeds only with a payment link or a confirmation (SYNTHETIC checkout screens)", async () => {
  const withLink = new FakePrime({
    cartButtons: ["Checkout"],
    checkoutReply: { text: "Pay here: https://checkout.paystack.com/abc123\nOrder ID: PR-88213", buttons: [] },
  });
  const ok = await runOrderFlow(withLink, shawarma);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.paystackUrl, "https://checkout.paystack.com/abc123");
  assert.equal(ok.ok && ok.orderRef, "PR-88213");

  const nothing = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: "Something went wrong", buttons: [] } });
  const bad = await runOrderFlow(nothing, shawarma);
  assert.ok(!bad.ok && bad.code === "UNEXPECTED_SCREEN");
});

test("stops before touching the cart: not empty, closed, missing vendor or item, changed price", async () => {
  const cases: [FakeOptions, OrderTarget, string][] = [
    [{ cartAtStart: ["Egg"] }, shawarma, "CART_NOT_EMPTY"],
    [{ closed: ["Slash Shawarma"] }, shawarma, "VENDOR_CLOSED"],
    [{}, { ...shawarma, vendorName: "Slash Shawarma Express" }, "VENDOR_NOT_FOUND"],
    [{}, { ...shawarma, vendorName: "Slash" }, "VENDOR_NOT_FOUND"],
    [{}, { ...shawarma, itemName: "Shawarma + 1 Sausages" }, "ITEM_NOT_FOUND"],
    [{}, { ...shawarma, itemName: "Shawarma" }, "ITEM_NOT_FOUND"],
    [{ priceOverride: { "Shawarma + 1 Sausage": 230_000 } }, shawarma, "PRICE_CHANGED"],
  ];
  for (const [opts, target, code] of cases) {
    const bot = new FakePrime(opts);
    const r = await runOrderFlow(bot, target);
    assert.ok(!r.ok && r.code === code, `${code}: got ${JSON.stringify(!r.ok && r.code)}`);
    assert.ok(!r.ok && !r.cartTouched, `${code}: cart must not be touched`);
    assert.ok(!bot.clicks.some((c) => /add to cart/i.test(c)), `${code}: never adds to cart`);
    assert.deepEqual(bot.cart, opts.cartAtStart ?? []);
  }
});

test("a closed vendor in the list is refused (Waffledom is closed in the crawl)", async () => {
  const r = await runOrderFlow(new FakePrime(), { vendorName: "Waffledom", itemName: "Circle Waffle", expectedPriceKobo: 70_000 });
  assert.ok(!r.ok && r.code === "VENDOR_CLOSED");
});

test("a bot error mid-flow is a clean failure, not a throw", async () => {
  const bot = new FakePrime();
  bot.click = async () => { throw new Error("Prime did not reply in time"); };
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(!r.ok && r.code === "BOT_ERROR" && /did not reply/.test(r.detail));
});
