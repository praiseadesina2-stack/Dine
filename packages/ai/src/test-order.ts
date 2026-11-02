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
    itemName: "Delish Pack + 1 Kebab"
  });

  console.log("\n--- Agent Execution Result ---");
  console.log("Success:", result.success);
  console.log("Message:", result.message);
  if (result.paystackUrl) {
    console.log("🎯 Paystack Checkout Link Acquired:", result.paystackUrl);
  }
  if (result.rawResponse) {
    console.log("\nRaw Bot Response:\n", result.rawResponse);
  }
}

runTestOrder().catch(console.error);
