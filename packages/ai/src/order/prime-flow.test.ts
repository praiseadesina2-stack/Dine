/**
 * The ordering flow against Prime's real screens (fixtures/prime-crawl.json, from the
 * crawl of @orderfromprimebot). Cart and checkout were never crawled, so those two
 * screens are SYNTHETIC here and marked as such.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exactButton, normalise, parseItemScreen, runOrderFlow, type BotScreen, type OrderTarget } from "./prime-flow.js";
import { judgePayment, judgeTopUp, parseWalletScreen } from "./prime-wallet.js";
import { crawl, FakePrime, itemScreen, walletText, type FakeOptions } from "./sim-prime.js";

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

test("wallet screen parsing (real crawled format)", () => {
  assert.deepEqual(parseWalletScreen(walletText(0)), { balanceKobo: 0, fundingAccount: { accountNumber: "9894065716", bankName: "Flutterwave MFB (Formerly OK MFB)" } });
  assert.equal(parseWalletScreen(walletText(1_250_050))?.balanceKobo, 1_250_050, "₦12,500.50 with thousands separator and kobo");
  assert.equal(parseWalletScreen("👤 My Profile\n\nWallet balance: ₦0"), null, "the profile line is not the wallet screen");
});

const CHECKOUT = { cartButtons: ["Checkout"] };

test("a low Prime wallet stops before the cart and says how much to top up, and where", async () => {
  const bot = new FakePrime({ walletKobo: 150_000 });
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(!r.ok && r.code === "PRIME_WALLET_LOW", JSON.stringify(r));
  assert.ok(!r.ok && !r.cartTouched && bot.cart.length === 0);
  assert.deepEqual(!r.ok && r.topUp, { shortfallKobo: 50_000, balanceKobo: 150_000, fundingAccount: { accountNumber: "9894065716", bankName: "Flutterwave MFB (Formerly OK MFB)" } });
});

test("paid from the wallet: verified only when the balance drops by exactly the total (SYNTHETIC checkout)", async () => {
  const bot = new FakePrime({ ...CHECKOUT, walletKobo: 500_000, checkoutReply: { text: "✅ Order placed! Order ID: PR-90001", buttons: [] } });
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.ok && r.payment, { method: "prime_wallet", status: "verified", amountKobo: 200_000, balanceBeforeKobo: 500_000, balanceAfterKobo: 300_000, detail: "wallet went ₦5000 → ₦3000" });
  assert.equal(r.ok && r.orderRef, "PR-90001");
});

test("when Prime asks how to pay, the agent picks the wallet (SYNTHETIC checkout)", async () => {
  const bot = new FakePrime({
    ...CHECKOUT,
    checkoutReply: { text: "How would you like to pay?", buttons: [{ row: 0, col: 0, label: "💳 Pay with card" }, { row: 1, col: 0, label: "👛 Pay with wallet" }] },
    walletPayButton: { label: "👛 Pay with wallet", reply: { text: "Order confirmed 🎉", buttons: [] } },
  });
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(r.ok && r.payment.status === "verified", JSON.stringify(r));
  assert.ok(!bot.clicks.some((c) => /card/i.test(c)), "never pays by card");
});

test("a Paystack link alone is not a payment", async () => {
  const bot = new FakePrime({ ...CHECKOUT, checkoutReply: { text: "Pay here: https://checkout.paystack.com/abc123", buttons: [] } });
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(r.ok && r.payment.method === "paystack_link" && r.payment.status === "not_paid", JSON.stringify(r));
});

test("a wrong charge or a lost reply after checkout is uncertain, never verified", async () => {
  const wrong = await runOrderFlow(new FakePrime({ ...CHECKOUT, chargeOverrideKobo: 220_000, checkoutReply: { text: "Order placed!", buttons: [] } }), shawarma);
  assert.ok(wrong.ok && wrong.payment.status === "uncertain" && /moved by ₦2200/.test(wrong.payment.detail), JSON.stringify(wrong));

  const lost = await runOrderFlow(new FakePrime({ ...CHECKOUT, failAfterCheckout: true, checkoutReply: { text: "Order placed!", buttons: [] } }), shawarma);
  assert.ok(lost.ok && lost.payment.status === "uncertain" && lost.payment.balanceAfterKobo === undefined, JSON.stringify(lost));
});

test("a bot error after checkout carries an uncertain payment", async () => {
  const bot = new FakePrime({ ...CHECKOUT, checkoutReply: { text: "Order placed!", buttons: [] } });
  const click = bot.click.bind(bot);
  bot.click = async (s, b) => {
    if (b.label === "Checkout") throw new Error("Prime did not reply in time");
    return click(s, b);
  };
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(!r.ok && r.code === "BOT_ERROR" && r.payment?.status === "uncertain", JSON.stringify(r));
});

test("top-up check: landed only when the balance rose by the payout amount", () => {
  const wallet = (kobo: number) => parseWalletScreen(walletText(kobo))!;
  assert.equal(judgeTopUp(100_000, wallet(600_000), 500_000).status, "landed");
  assert.equal(judgeTopUp(100_000, wallet(400_000), 500_000).status, "not_yet");
  assert.equal(judgePayment(500_000, 500_000, 200_000).status, "not_paid");
});

test("a bot error mid-flow is a clean failure, not a throw", async () => {
  const bot = new FakePrime();
  bot.click = async () => { throw new Error("Prime did not reply in time"); };
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(!r.ok && r.code === "BOT_ERROR" && /did not reply/.test(r.detail));
});
