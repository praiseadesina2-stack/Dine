/**
 * Paying Prime by bank transfer (Prime asks at checkout, Kora pays), the student wallet's
 * reserve → capture / release, and "Did you mean…?" suggestions.
 * Prime's checkout is SYNTHETIC here (never crawled); the transfer text follows the format
 * the Backend Engineer's agent recorded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCartOrder, runOrderFlow, type OrderTarget } from "./prime-flow.js";
import { parseBankTransfer } from "./prime-transfer.js";
import { payeeAllowed, payPrimeTransfer, type KoraPayouts } from "./pay-transfer.js";
import { similarity, suggestNames } from "./suggest.js";
import { payeesFor, runOrderAndPay } from "./order-and-pay.js";
import { dineFeeKobo, orderCharges, packAllowanceKobo, primeFeeKobo, studentCharge } from "./charges.js";
import { trayToCartLines } from "./tray.js";
import { FakePrime } from "./sim-prime.js";
import { WalletService } from "../wallet.js";
import type { KoraDisbursementPayload } from "../kora.js";

const shawarma: OrderTarget = { vendorName: "Slash Shawarma", itemName: "Shawarma + 1 Sausage", expectedPriceKobo: 200_000 };
const transferText = (naira: string, name = "Prime That") =>
  `Send ₦${naira} to:\nAccount number: 9479959026\nBank: Flutterwave MFB\nName: ${name}\n\nOrder ID: PR-55120`;

// ---------------------------------------------------------------- parsing

test("bank-transfer screen parsing (recorded format)", () => {
  assert.deepEqual(parseBankTransfer(transferText("2,250")), { accountNumber: "9479959026", bankName: "Flutterwave MFB", accountName: "Prime That", amountKobo: 225_000 });
  assert.equal(parseBankTransfer("Account number: 9479959026\nBank: Flutterwave MFB"), null, "no amount: not a transfer request");
  assert.equal(parseBankTransfer("Send ₦2,000 to:\nBank: Flutterwave MFB"), null, "no account number");
  assert.equal(parseBankTransfer("Send ₦2,000 to:\nAccount number: 12345\nBank: X"), null, "not a 10-digit NUBAN");
  assert.equal(parseBankTransfer("Send ₦2,000 to:\nAccount number: 9479959026\nBank: Flutterwave MFB")?.accountName, undefined, "no payee shown");
});

// ---------------------------------------------------------------- the flow, transfer mode

test("transfer mode: Prime asks for exactly the cart total → awaiting_transfer, Prime wallet never opened", async () => {
  const bot = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: transferText("2,600"), buttons: [] } });
  const r = await runOrderFlow(bot, shawarma, { payWith: "transfer" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.payment.status, "awaiting_transfer");
  assert.equal(r.ok && r.payment.method, "bank_transfer");
  assert.deepEqual(r.ok && r.transfer, { accountNumber: "9479959026", bankName: "Flutterwave MFB", accountName: "Prime That", amountKobo: 260_000 });
  assert.equal(r.ok && r.orderRef, "PR-55120");
  assert.ok(!bot.clicks.some((c) => /wallet/i.test(c)), "the Prime wallet is not read in transfer mode");
});

test("transfer mode: Prime asking for a different amount is refused, nothing paid", async () => {
  const bot = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: transferText("2,500"), buttons: [] } });
  const r = await runOrderFlow(bot, shawarma, { payWith: "transfer" });
  assert.ok(!r.ok && r.code === "TRANSFER_MISMATCH", JSON.stringify(r));
  assert.equal(!r.ok && r.payment?.status, "not_paid");
  assert.ok(!r.ok && r.cartTouched, "the unpaid Prime order must be cleared before a retry");
});

test("transfer mode: a whole tray is one transfer for the whole cart", async () => {
  const bot = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: transferText("4,600"), buttons: [] } });
  const r = await runCartOrder(bot, [shawarma, shawarma], { payWith: "transfer" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.totalKobo, 400_000);
  assert.equal(r.ok && r.transfer?.amountKobo, 460_000);
});

test("transfer mode: a Paystack link is not paid, and a wallet-pay button is never pressed", async () => {
  const link = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: "Pay here: https://checkout.paystack.com/x1", buttons: [] } });
  const r = await runOrderFlow(link, shawarma, { payWith: "transfer" });
  assert.ok(r.ok && r.payment.status === "not_paid" && r.payment.method === "paystack_link");

  const ask = new FakePrime({
    cartButtons: ["Checkout"],
    checkoutReply: { text: "How would you like to pay?", buttons: [{ row: 0, col: 0, label: "Pay with wallet" }] },
    walletPayButton: { label: "Pay with wallet", reply: { text: "Order confirmed", buttons: [] } },
  });
  const r2 = await runOrderFlow(ask, shawarma, { payWith: "transfer" });
  assert.ok(!r2.ok && r2.code === "CHECKOUT_UNMAPPED", JSON.stringify(r2));
  assert.ok(!ask.clicks.includes("Pay with wallet"));
});

test("Prime's delivery question is answered with the saved address, then the transfer is read", async () => {
  const bot = new FakePrime({
    cartButtons: ["Checkout →"],
    checkoutReply: { text: "📍 Deliver to Joseph Hall, Room D208?", buttons: [{ row: 0, col: 0, label: "✅ Deliver here" }, { row: 1, col: 0, label: "🏠 Change hall" }, { row: 1, col: 1, label: "🔢 Change room" }] },
    walletPayButton: { label: "✅ Deliver here", reply: { text: transferText("2,600"), buttons: [] } },
  });
  const r = await runOrderFlow(bot, shawarma, { payWith: "transfer" });
  assert.ok(r.ok && r.payment.status === "awaiting_transfer", JSON.stringify(r));
  assert.ok(r.ok && r.steps.includes("Prime delivers to Joseph Hall, Room D208"));
  assert.ok(!bot.clicks.some((c) => /change/i.test(c)), "never changes the address on its own");
});

test("wallet mode still takes a transfer request when that is what Prime shows", async () => {
  const bot = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: transferText("2,600"), buttons: [] } });
  const r = await runOrderFlow(bot, shawarma);
  assert.ok(r.ok && r.payment.status === "awaiting_transfer", JSON.stringify(r));
});

test("an item with no approved price is refused before Prime is touched", async () => {
  const bot = new FakePrime();
  const r = await runOrderFlow(bot, { vendorName: "Slash Shawarma", itemName: "Shawarma + 1 Sausage" } as OrderTarget);
  assert.ok(!r.ok && r.code === "INVALID_ORDER");
  assert.deepEqual(bot.clicks, []);
});

// ---------------------------------------------------------------- suggestions

test("near misses come back as suggestions, never as orders", async () => {
  const bot = new FakePrime();
  const r = await runOrderFlow(bot, { ...shawarma, itemName: "Shawarma + 1 Sausages" });
  assert.ok(!r.ok && r.code === "ITEM_NOT_FOUND");
  assert.ok(!r.ok && r.suggestions?.includes("Shawarma + 1 Sausage"), JSON.stringify(!r.ok && r.suggestions));
  assert.ok(!r.ok && !r.cartTouched);

  const v = await runOrderFlow(new FakePrime(), { ...shawarma, vendorName: "Slash Shawarmaa" });
  assert.ok(!v.ok && v.code === "VENDOR_NOT_FOUND");
  assert.ok(!v.ok && v.suggestions?.includes("Slash Shawarma"), JSON.stringify(!v.ok && v.suggestions));
});

test("similarity: different numbers never match; exact names are not 'suggestions'", () => {
  assert.equal(similarity("Shawarma + 2 Sausages", "Shawarma + 1 Sausage"), 0);
  assert.ok(similarity("Jollof Rice and Chicken", "Jollof Rice") >= 0.9);
  assert.deepEqual(suggestNames("Fried Rice", ["Fried Rice", "Fried Rice & Turkey", "Egg"]), ["Fried Rice & Turkey"]);
});

// ---------------------------------------------------------------- paying the transfer

const transfer = { accountNumber: "9479959026", bankName: "Flutterwave MFB", accountName: "Prime That", amountKobo: 200_000 };

function fakeKora(o: { test?: boolean; bankCode?: string | null; resolvedName?: string; disburse?: any; throws?: boolean } = {}) {
  const sent: KoraDisbursementPayload[] = [];
  const kora: KoraPayouts = {
    isConfigured: () => true,
    isTestMode: () => o.test ?? false,
    findBankCode: async () => (o.bankCode === undefined ? "090560" : o.bankCode),
    resolveAccount: async (acct) => (o.resolvedName ? { success: true, accountName: o.resolvedName, accountNumber: acct } : { success: false, message: "not found" }),
    disburse: async (p) => {
      sent.push(p);
      if (o.throws) throw new Error("socket hang up");
      return o.disburse ?? { success: true, status: "processing", reference: p.reference!, message: "ok" };
    },
  };
  return { kora, sent };
}
const pay = (kora: KoraPayouts, extra: Partial<Parameters<typeof payPrimeTransfer>[0]> = {}) =>
  payPrimeTransfer({ kora, transfer, totalKobo: 200_000, reference: "ord_1", allowedPayees: ["Prime That"], ...extra });

test("test keys: the payout is simulated, never 'sent'; testers see the normal confirmation, the logs keep the truth", async () => {
  const { kora, sent } = fakeKora({ test: true });
  const r = await pay(kora, { allowedPayees: [] });
  assert.equal(r.status, "simulated");
  assert.equal(r.message, "Payment received, order has been confirmed");
  assert.match(r.detail, /Prime not paid/);
  assert.equal(sent.length, 1);
});

test("virtual accounts are 'Prime <registered name>': only Dine's own name is accepted", () => {
  assert.deepEqual(payeesFor("mark"), process.env.PRIME_PAYEE_NAMES ? payeesFor("mark") : ["Prime mark"]);
  assert.ok(payeeAllowed("PRIME MARK", ["Prime mark"]));
  assert.ok(payeeAllowed("Prime Mark Okafor", ["Prime mark"]));
  assert.ok(!payeeAllowed("PRIME DAVID", ["Prime mark"]), "another Prime customer's account");
  assert.ok(!payeeAllowed("MARK", ["Prime mark"]), "not a Prime virtual account");
});

test("the agent reads Dine's registered Prime name from the greeting and pays only 'Prime <name>'", async () => {
  const saved = process.env.PRIME_PAYEE_NAMES;
  delete process.env.PRIME_PAYEE_NAMES;
  try {
    const opts = (resolvedName: string) => ({ kora: fakeKora({ resolvedName }).kora, reference: "g", confirmTimeoutMs: 10 });
    const ours = await runOrderAndPay(new FakePrime({ ...checkoutTo("9479959026", "2,600", "Prime Mark"), paidMessage: "Payment received" }), [shawarma], opts("PRIME MARK"));
    assert.ok(ours.order.ok && ours.order.primeCustomerName === "mark", "crawled home screen: 'Hi mark! 👋'");
    assert.equal(ours.payout?.status, "sent", String(ours.payout?.detail));
    assert.ok(ours.order.ok && ours.order.payment.status === "verified");

    // Prime shows our name, but the bank says the account is someone else's: blocked.
    const theirs = await runOrderAndPay(new FakePrime(checkoutTo("9479959026", "2,600", "Prime Mark")), [shawarma], opts("PRIME DAVID"));
    assert.equal(theirs.payout?.status, "blocked");
    assert.ok(theirs.order.ok && theirs.order.payment.status === "not_paid");
  } finally {
    if (saved !== undefined) process.env.PRIME_PAYEE_NAMES = saved;
  }
});

test("live: sent only after amount, payee, bank and account-holder checks pass", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "PRIME THAT TECHNOLOGIES LTD" });
  const r = await pay(kora);
  assert.equal(r.status, "sent", r.detail);
  assert.equal(sent[0].amount, 2000, "naira to Kora");
  assert.equal(sent[0].reference, "ord_1", "the caller's reference, created before the call");
  assert.equal(sent[0].bankCode, "090560");
});

test("live: every guard blocks before Kora is called", async () => {
  const cases: [string, ReturnType<typeof fakeKora>, Partial<Parameters<typeof payPrimeTransfer>[0]>][] = [
    ["amount differs", fakeKora({ resolvedName: "Prime That" }), { totalKobo: 210_000 }],
    ["payee shown is not Prime", fakeKora({ resolvedName: "Prime That" }), { transfer: { ...transfer, accountName: "John Doe" } }],
    ["no payee shown", fakeKora({ resolvedName: "Prime That" }), { transfer: { ...transfer, accountName: undefined } }],
    ["bank says someone else", fakeKora({ resolvedName: "JOHN DOE" }), {}],
    ["account does not resolve", fakeKora({}), {}],
    ["unknown bank", fakeKora({ bankCode: null, resolvedName: "Prime That" }), {}],
    ["no allowed payees configured", fakeKora({ resolvedName: "Prime That" }), { allowedPayees: [] }],
    ["no reference", fakeKora({ resolvedName: "Prime That" }), { reference: " " }],
  ];
  for (const [why, { kora, sent }, extra] of cases) {
    const r = await pay(kora, extra);
    assert.equal(r.status, "blocked", `${why}: ${r.detail}`);
    assert.equal(sent.length, 0, `${why}: Kora must not be called`);
  }
});

test("live: Kora's explicit refusal is failed; anything unclear is uncertain (never resent)", async () => {
  const refused = fakeKora({ resolvedName: "Prime That", disburse: { success: false, status: "failed", reference: "ord_1", message: "Insufficient balance", raw: { data: { status: "failed" } } } });
  assert.equal((await pay(refused.kora)).status, "failed");

  const unclear = fakeKora({ resolvedName: "Prime That", disburse: { success: false, status: "failed", reference: "ord_1", message: "Bad gateway" } });
  assert.equal((await pay(unclear.kora)).status, "uncertain", "a 5xx with no Kora status is not proof nothing moved");

  const thrown = fakeKora({ resolvedName: "Prime That", throws: true });
  const r = await pay(thrown.kora);
  assert.equal(r.status, "uncertain");
  assert.equal(thrown.sent.length, 1, "called once, not retried");
});

test("payee matching needs every word of an allowed name", () => {
  assert.ok(payeeAllowed("PRIME THAT LTD", ["Prime That"]));
  assert.ok(!payeeAllowed("PRIME LTD", ["Prime That"]));
  assert.ok(!payeeAllowed(undefined, ["Prime That"]));
  assert.ok(!payeeAllowed("Prime That", []));
});

// ---------------------------------------------------------------- the agent orders AND pays

const checkoutTo = (account: string, naira = "2,600", name = "Prime That") => ({
  cartButtons: ["Checkout"],
  checkoutReply: { text: `Send ₦${naira} to:\nAccount number: ${account}\nBank: Flutterwave MFB\nName: ${name}`, buttons: [] },
});
const orderAndPay = (bot: FakePrime, kora: KoraPayouts, reference = "ord_9") =>
  runOrderAndPay(bot, [shawarma], { kora, reference, allowedPayees: ["Prime That"], confirmTimeoutMs: 10 });

test("each checkout's own virtual account is paid; nothing is pinned", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "PRIME THAT" });
  await orderAndPay(new FakePrime({ ...checkoutTo("9479959026"), paidMessage: "Payment received ✅" }), kora, "a");
  await orderAndPay(new FakePrime({ ...checkoutTo("8123456789"), paidMessage: "Payment received ✅" }), kora, "b");
  assert.deepEqual(sent.map((p) => [p.accountNumber, p.reference]), [["9479959026", "a"], ["8123456789", "b"]]);
});

test("live: verified only when Prime confirms the payment in its chat", async () => {
  const { kora } = fakeKora({ resolvedName: "PRIME THAT" });
  const bot = new FakePrime({ ...checkoutTo("9479959026"), paidMessage: "✅ Payment received! ₦2,600\nYour order is being prepared." });
  const { order, payout } = await orderAndPay(bot, kora);
  assert.equal(payout?.status, "sent");
  assert.ok(order.ok && order.payment.status === "verified", JSON.stringify(order.ok && order.payment));
  assert.equal(payout?.message, "Payment received, order has been confirmed");
  assert.equal(bot.marks, 1, "the chat is marked before paying, so only later messages count");
});

test("live: Kora sent but Prime silent, or Prime confirms another amount → uncertain", async () => {
  const silent = await orderAndPay(new FakePrime(checkoutTo("9479959026")), fakeKora({ resolvedName: "PRIME THAT" }).kora);
  assert.ok(silent.order.ok && silent.order.payment.status === "uncertain", JSON.stringify(silent.order.ok && silent.order.payment));
  assert.doesNotMatch(silent.payout!.message, /received/, "never tells the student it was received when Prime did not confirm");

  const wrong = await orderAndPay(new FakePrime({ ...checkoutTo("9479959026"), paidMessage: "Payment received: ₦1,500" }), fakeKora({ resolvedName: "PRIME THAT" }).kora);
  assert.ok(wrong.order.ok && wrong.order.payment.status === "uncertain");
});

test("test keys: simulated, Prime's confirmation is not awaited, Prime not paid", async () => {
  const { kora, sent } = fakeKora({ test: true });
  const { order, payout } = await orderAndPay(new FakePrime({ ...checkoutTo("9479959026"), paidMessage: "Payment received" }), kora);
  assert.equal(payout?.status, "simulated");
  assert.ok(order.ok && order.payment.status === "simulated", "the backend still knows Prime was not paid");
  assert.equal(payout?.message, "Payment received, order has been confirmed");
  assert.equal(sent.length, 1);
});

test("a virtual account belonging to someone else is never paid", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "JOHN DOE" });
  const { order, payout } = await orderAndPay(new FakePrime(checkoutTo("9479959026")), kora);
  assert.equal(payout?.status, "blocked");
  assert.ok(order.ok && order.payment.status === "not_paid");
  assert.equal(sent.length, 0);
});

test("an order that fails before checkout never reaches Kora", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "PRIME THAT" });
  const { order, payout } = await runOrderAndPay(new FakePrime({ closed: ["Slash Shawarma"] }), [shawarma], { kora, reference: "x" });
  assert.ok(!order.ok && order.code === "VENDOR_CLOSED");
  assert.equal(payout, undefined);
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------- charges: Prime ₦600, Dine ₦100, per order

test("charges: reserve food + pack allowance + ₦600 + ₦100; charge what Prime actually asked + ₦100", () => {
  const c = orderCharges(150_000, 1, { primeFeeKobo: 60_000, dineFeeKobo: 10_000, packAllowanceKobo: 30_000 });
  assert.deepEqual(c, { foodKobo: 150_000, maxPacksKobo: 30_000, primeFeeKobo: 60_000, dineFeeKobo: 10_000, payPrimeKobo: 240_000, chargeStudentKobo: 250_000 });
  // Live 19 Nov: Potato Chips (Small) ₦1,500 + ₦200 pack → Prime asks ₦1,700 + ₦600 = ₦2,300, within the ₦2,400 limit.
  assert.equal(studentCharge(230_000, 10_000), 240_000, "student pays ₦2,400; ₦100 of the allowance goes back");
});

test("the tray conversion carries the charges, once per order however many items", () => {
  const conv = trayToCartLines([
    { itemName: "Shawarma + 1 Sausage", vendorName: "Slash Shawarma", price: 2000 },
    { itemName: "Shawarma + 1 Sausage", vendorName: "Slash Shawarma", price: 2000 },
    { itemName: "Chips (Small)", vendorName: "Grandpa Chips", price: 1500 },
  ]);
  assert.ok(conv.ok);
  assert.equal(conv.ok && conv.totalKobo, 550_000);
  assert.equal(conv.ok && conv.charges.maxPacksKobo, 3 * packAllowanceKobo(), "allowance per item (3 items)");
  assert.equal(conv.ok && conv.charges.payPrimeKobo, 550_000 + 3 * packAllowanceKobo() + primeFeeKobo());
  assert.equal(conv.ok && conv.charges.chargeStudentKobo, 550_000 + 3 * packAllowanceKobo() + primeFeeKobo() + dineFeeKobo());
});

test("Prime asking for the food without its fee is a mismatch: nothing paid", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "PRIME THAT" });
  const { order } = await orderAndPay(new FakePrime(checkoutTo("9479959026", "2,000")), kora);
  assert.ok(!order.ok && order.code === "TRANSFER_MISMATCH", JSON.stringify(!order.ok && order.detail));
  assert.equal(sent.length, 0);
});

test("never pays Prime more than the student approved (e.g. a pack fee added on top)", async () => {
  const { kora, sent } = fakeKora({ resolvedName: "PRIME THAT" });
  const { order } = await runOrderAndPay(new FakePrime({ ...checkoutTo("9479959026"), paidMessage: "Payment received" }), [shawarma], {
    kora, reference: "cap", allowedPayees: ["Prime That"], confirmTimeoutMs: 10, maxPayPrimeKobo: 250_000,
  });
  assert.ok(order.ok && order.payment.status === "not_paid", JSON.stringify(order.ok && order.payment));
  assert.equal(sent.length, 0, "Kora never called");
});

// ---------------------------------------------------------------- student wallet

test("wallet: reserve holds money, capture spends it, release returns it", async () => {
  const w = new WalletService();
  const u = `test_${Date.now()}_a`;
  await w.credit({ telegramUserId: u, amountNaira: 5000, reference: `${u}_fund` });

  const hold = await w.reserve({ telegramUserId: u, amountKobo: 300_000, reference: `${u}_o1` });
  assert.ok(hold);
  assert.equal(await w.getAvailableBalance(u), 2000);
  assert.equal(await w.getBalance(u), 5000, "nothing leaves until capture");
  assert.equal(await w.reserve({ telegramUserId: u, amountKobo: 300_000, reference: `${u}_o2` }), null, "cannot reserve more than is available");
  assert.equal(await w.reserve({ telegramUserId: u, amountKobo: 300_000, reference: `${u}_o1` }), hold, "same order, same hold");
  assert.equal(await w.debit({ telegramUserId: u, amountNaira: 2500, reference: `${u}_d1` }), null, "a debit cannot spend reserved money");

  await w.capture(`${u}_o1`);
  assert.equal(await w.getBalance(u), 2000);
  assert.equal(await w.release(`${u}_o1`), null, "a capture is never undone by release");
  await w.capture(`${u}_o1`);
  assert.equal(await w.getBalance(u), 2000, "capture is idempotent");

  await w.reserve({ telegramUserId: u, amountKobo: 150_000, reference: `${u}_o3` });
  await w.release(`${u}_o3`, "Prime refused");
  assert.equal(await w.getAvailableBalance(u), 2000);
  assert.equal(await w.capture(`${u}_o3`), null, "a released hold cannot be captured");
});
