import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DineOrderingAgent } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function runTestOrder() {
  console.log("🚀 Testing Dine Autonomous Ordering Agent against @orderfromprimebot...\n");

  const agent = new DineOrderingAgent();

  if (!agent.isConfigured()) {
    console.error("❌ Agent is not configured. Missing TELEGRAM_STRING_SESSION in .env.");
    console.log("Run: pnpm --filter @dine/ai login to generate your session string first!");
    process.exit(1);
  }

  const result = await agent.placeOrder({
    botUsername: process.env.PRIME_BOT_USERNAME || "orderfromprimebot",
    vendorName: "Grandpa Chips",
    itemName: "Potato Chips (Small)",
    expectedPriceKobo: 150_000, // ₦1,500 on Prime (19 Nov 2026), plus a ₦200 pack; stops if Prime shows another price
  });

  console.log("\n--- Agent Execution Result ---");
  console.log("Success:", result.success);
  console.log("Message:", result.message);
  console.log("Stage:", result.stage, result.code ? `(${result.code})` : "", result.cartTouched ? "· Prime cart was changed" : "");
  for (const step of result.stepsCompleted) console.log("  -", step);
  if (result.paystackUrl) {
    console.log("🎯 Paystack Checkout Link Acquired:", result.paystackUrl);
  }
  if (result.orderRef) console.log("Prime order ref:", result.orderRef);
  if (result.totalKobo != null) console.log("Prime total: ₦" + result.totalKobo / 100);
  if (result.amountDueKobo != null) console.log("Due to Prime (with its fee): ₦" + result.amountDueKobo / 100);
  if (result.transfer) console.log(`Prime's virtual account: ${result.transfer.accountNumber} (${result.transfer.bankName}) · ${result.transfer.accountName ?? "no name shown"} · ₦${result.transfer.amountKobo / 100}`);
  if (result.payout) {
    console.log(`Kora payout: ${result.payout.status} · ref ${result.payout.reference}: ${result.payout.detail}`);
    for (const c of result.payout.checks) console.log("  ✓", c);
    console.log("Student would see:", result.payout.message);
  }
  if (result.suggestions?.length) console.log("Did you mean:", result.suggestions.join(", "));
  if (result.payment) console.log(`Payment: ${result.payment.status} (${result.payment.method}): ${result.payment.detail}`);
  if (result.topUp) {
    const a = result.topUp.fundingAccount;
    console.log(`Prime wallet low: top up at least ₦${result.topUp.shortfallKobo / 100}${a ? ` to ${a.accountNumber} (${a.bankName})` : ""}`);
  }
}

// The Telegram client keeps the process alive; exit once the result is printed.
runTestOrder().catch(console.error).finally(() => process.exit(0));
