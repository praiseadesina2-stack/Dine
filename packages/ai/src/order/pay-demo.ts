/**
 * Payment walkthrough for the demo: `pnpm --filter @dine/ai pay:demo`
 *
 * Runs the REAL ordering flow and payment checks (prime-flow.ts, prime-wallet.ts)
 * against the simulated Prime bot (sim-prime.ts: real crawled screens, SYNTHETIC
 * checkout). The student wallet below is a stand-in for the backend's ledger, and the
 * Kora collection and payout are simulated: only the AI-side logic here is real.
 */
import { runCartOrder, runOrderFlow, type OrderFlowResult, type OrderTarget } from "./prime-flow.js";
import { judgeTopUp, readPrimeWallet } from "./prime-wallet.js";
import { FakePrime } from "./sim-prime.js";
import { trayToCartLines } from "./tray.js";

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;
const say = (s = "") => console.log(s);
const step = (n: number, s: string) => say(`\n${n}. ${s}`);

/** Stand-in for the backend ledger: available and reserved per student. */
class DemoLedger {
  available = 0;
  reserved = 0;
  credit(kobo: number) { this.available += kobo; }
  reserve(kobo: number) {
    if (kobo > this.available) return false;
    this.available -= kobo; this.reserved += kobo; return true;
  }
  capture(kobo: number) { this.reserved -= kobo; }
  release(kobo: number) { this.reserved -= kobo; this.available += kobo; }
  show() { return `available ${naira(this.available)} · reserved ${naira(this.reserved)}`; }
}

function printOrder(r: OrderFlowResult) {
  for (const s of r.steps.filter((s) => /wallet|verified|payment|checkout|added/i.test(s))) say(`     · ${s}`);
  if (r.ok) say(`   → order placed${r.orderRef ? ` (${r.orderRef})` : ""}, payment ${r.payment.status.toUpperCase()}`);
  else say(`   → stopped: ${r.code}, ${r.detail}${r.payment ? `; payment ${r.payment.status.toUpperCase()}` : ""}`);
}

/** What the backend does with the agent's answer (contracts/ordering.md, "Paying Prime"). */
function settle(r: OrderFlowResult, ledger: DemoLedger, amount: number) {
  const status = r.payment?.status;
  if (status === "verified") { ledger.capture(amount); say(`   ledger: capture ${naira(amount)} (wallet drop proves it)`); }
  else if (status === "uncertain") say(`   ledger: HOLD the reservation; reconcile Prime's wallet before any retry. Never pay twice.`);
  else { ledger.release(amount); say(`   ledger: release ${naira(amount)} back to the student`); }
  say(`   student wallet: ${ledger.show()}`);
}

const meal: OrderTarget = { vendorName: "Slash Shawarma", itemName: "Shawarma + 1 Sausage", expectedPriceKobo: 200_000 };
const confirmed = { cartButtons: ["Checkout"], checkoutReply: { text: "✅ Order placed! Order ID: PR-90001", buttons: [] } };

async function main() {
  say("Dine payments: student wallet → Prime wallet → Prime order, with proof at every step");
  say("(Prime screens replayed from the 19 Oct crawl; checkout simulated; Kora simulated)");

  const ledger = new DemoLedger();
  const prime = new FakePrime({ ...confirmed, walletKobo: 50_000 });

  step(1, "Ada funds her Dine wallet with ₦12,000 by bank transfer (Kora collection, signature + lookup verified)");
  ledger.credit(1_200_000);
  say(`   student wallet: ${ledger.show()}`);

  const converted = trayToCartLines([
    { itemName: "Shawarma + 1 Sausage", vendorName: "Slash Shawarma", price: 2000 },
    { itemName: "Delish Pack + 1 Kebab", vendorName: "Delish Yamarita", price: 2200 },
    { itemName: "Shawarma + 1 Sausage", vendorName: "Slash Shawarma", price: 2000 },
  ]);
  if (!converted.ok) throw new Error(converted.problems.join("; "));
  const trayKobo = converted.totalKobo;
  step(2, `Ada's tray: 2 × Shawarma + 1 Sausage (Slash Shawarma), 1 × Delish Pack + 1 Kebab (Delish Yamarita) = ${naira(trayKobo)}.\n   She taps "Confirm & Order". Policy allows; reserve the amount.`);
  if (!ledger.reserve(trayKobo)) throw new Error("student wallet cannot cover the order");
  say(`   student wallet: ${ledger.show()}`);

  step(3, "Ordering agent checks every item on Prime and Dine's Prime wallet, before touching the cart");
  let r = await runCartOrder(prime, converted.lines);
  printOrder(r);
  if (r.ok || r.code !== "PRIME_WALLET_LOW" || !r.topUp) throw new Error("demo expected PRIME_WALLET_LOW");
  const acct = r.topUp.fundingAccount;
  say(`   top-up needed: at least ${naira(r.topUp.shortfallKobo)} to ${acct ? `${acct.accountNumber} (${acct.bankName})` : "the funding account"}`);

  step(4, "Backend tops up the Prime float: Kora payout of ₦10,000 to that account (unique reference, sent once)");
  const before = r.topUp.balanceKobo;
  prime.topUp(1_000_000);
  const landed = judgeTopUp(before, await readPrimeWallet(prime), 1_000_000);
  say(`   agent reads Prime wallet: ${naira(landed.balanceKobo)} → top-up ${landed.status.toUpperCase()}`);

  step(5, "Retry: the whole tray goes into ONE Prime cart, ONE checkout (cart was never touched, so a retry is safe)");
  r = await runCartOrder(prime, converted.lines);
  printOrder(r);
  if (r.ok) for (const l of r.lines) say(`     cart: ${l.qty} × ${l.itemName} (${l.vendorName}) ${naira(l.totalKobo)}`);
  settle(r, ledger, trayKobo);

  step(6, "What if Prime charges the wrong amount? (simulated ₦2,200 charge on a ₦2,000 order)");
  const odd = new FakePrime({ ...confirmed, walletKobo: 1_000_000, chargeOverrideKobo: 220_000 });
  if (!ledger.reserve(meal.expectedPriceKobo)) throw new Error("student wallet cannot cover the order");
  const r2 = await runOrderFlow(odd, meal);
  printOrder(r2);
  settle(r2, ledger, meal.expectedPriceKobo);

  step(7, "What if Prime returns only a Paystack link? A link is not a payment.");
  const link = new FakePrime({ cartButtons: ["Checkout"], checkoutReply: { text: "Pay here: https://checkout.paystack.com/abc123", buttons: [] } });
  if (!ledger.reserve(meal.expectedPriceKobo)) throw new Error("student wallet cannot cover the order");
  const r3 = await runOrderFlow(link, meal);
  printOrder(r3);
  settle(r3, ledger, meal.expectedPriceKobo);

  say("\nNo blind credits, no blind captures: money moves on Dine's books only when Prime's own balance proves it.");
}

main().catch((e) => { console.error(e); process.exit(1); });
