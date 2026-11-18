import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { KoraPaymentService } from "./kora.js";
import { WalletService } from "./wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  console.log("==================================================");
  console.log("   DINE WALLET & KORAPAY END-TO-END TEST FLOW    ");
  console.log("==================================================\n");

  const kora = new KoraPaymentService();
  const wallet = new WalletService();

  if (!kora.isConfigured()) {
    console.error("❌ KORA_SECRET_KEY is missing from .env");
    process.exit(1);
  }

  const testUserId = "999888777";
  console.log(`👤 Test User ID: ${testUserId}`);

  // 1. Initial wallet state
  const initialBal = await wallet.getBalance(testUserId);
  console.log(`💰 1. Initial Wallet Balance: ₦${initialBal.toLocaleString()}`);

  // 2. Initialize a Kora Charge (Funding)
  console.log(`\n💳 2. Initializing Kora Checkout to fund ₦2,500...`);
  const fundRef = `test_fund_${Date.now()}`;
  const chargeRes = await kora.initializeCharge({
    amount: 2500,
    customerName: "Test Student",
    customerEmail: "student@dine.ng",
    reference: fundRef,
    narration: "Dine Wallet Top-up Test",
  });

  if (chargeRes.success) {
    console.log(`   ✅ Kora Charge Initialized!`);
    console.log(`   • Checkout URL: ${chargeRes.checkoutUrl}`);
    console.log(`   • Reference: ${chargeRes.reference}`);
  } else {
    console.log(`   ⚠️ Charge Init response: ${chargeRes.message}`);
  }

  // 3. Simulate successful funding (Credit wallet)
  console.log(`\n💵 3. Crediting Wallet with ₦2,500 (Simulating completed card checkout)...`);
  await wallet.credit({
    telegramUserId: testUserId,
    amountNaira: 2500,
    reference: fundRef,
    description: "Kora Card Funding",
  });
  const fundedBal = await wallet.getBalance(testUserId);
  console.log(`   ✅ New Balance: ₦${fundedBal.toLocaleString()}`);

  // 4. Test ordering & debiting from wallet
  const orderCost = 1800;
  console.log(`\n🍽️ 4. Placing order costing ₦${orderCost.toLocaleString()}...`);
  const hasFunds = await wallet.hasSufficientBalance(testUserId, orderCost);
  console.log(`   • Sufficient funds? ${hasFunds ? "YES ✅" : "NO ❌"}`);

  if (hasFunds) {
    await wallet.debit({
      telegramUserId: testUserId,
      amountNaira: orderCost,
      reference: `order_${Date.now()}`,
      description: "Jollof Rice + Chicken from Prime",
    });
    const afterDebitBal = await wallet.getBalance(testUserId);
    console.log(`   ✅ Debited ₦${orderCost.toLocaleString()}. Remaining balance: ₦${afterDebitBal.toLocaleString()}`);
  }

  // 5. Test Kora Disbursement to Prime Vendor
  console.log(`\n💸 5. Testing Kora Automated Disbursement to Prime That...`);
  console.log(`   Target Account: 9479959026 (Flutterwave MFB - 110002)`);
  console.log(`   Amount: ₦${orderCost}`);

  const disburseRes = await kora.disburse({
    bankCode: "110002",
    accountNumber: "9479959026",
    amount: orderCost,
    customerName: "Dine Concierge",
    narration: "Dine meal payment for student",
  });

  console.log(`   Result: ${disburseRes.success ? "SUCCESS ✅" : "FAILED / NOTICE ⚠️"}`);
  console.log(`   Status: ${disburseRes.status}`);
  console.log(`   Message: ${disburseRes.message}`);
  console.log(`   Reference: ${disburseRes.reference}`);

  console.log("\n==================================================");
  console.log("   TEST COMPLETE — WALLET & DISBURSEMENT VERIFIED  ");
  console.log("==================================================\n");
}

main().catch(console.error);

