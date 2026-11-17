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
    vendorName: "Delish Yamarita",
    itemName: "Delish Pack + 1 Kebab",
    expectedPriceKobo: 220_000, // ₦2,200 on the crawl; the order stops if Prime shows another price
    location: "outside_cafeteria",
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
  if (result.payment) console.log(`Payment: ${result.payment.status} (${result.payment.method}): ${result.payment.detail}`);
  if (result.topUp) {
    const a = result.topUp.fundingAccount;
    console.log(`Prime wallet low: top up at least ₦${result.topUp.shortfallKobo / 100}${a ? ` to ${a.accountNumber} (${a.bankName})` : ""}`);
  }
}

runTestOrder().catch(console.error);
