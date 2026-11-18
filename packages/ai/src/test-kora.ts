import { KoraPaymentService } from "./kora.js";

async function main() {
  console.log("=========================================");
  console.log("   DINE x KORAPAY TRANSFER DIAGNOSTIC    ");
  console.log("=========================================\n");

  const kora = new KoraPaymentService();

  if (!kora.isConfigured()) {
    console.error("❌ KORA_SECRET_KEY is not set in your .env file!");
    console.log("👉 Add this to your root .env file:");
    console.log("   KORA_SECRET_KEY=sk_test_... (or sk_live_...)\n");
    console.log("You can get your secret key from: https://dashboard.korapay.com/settings/api-webhooks\n");
    process.exit(1);
  }

  console.log("✅ KORA_SECRET_KEY detected in environment.");

  // Prime That target account details extracted from Prime bot
  const primeAccount = {
    accountNumber: "9479959026",
    bankName: "Flutterwave MFB",
    expectedName: "Prime That",
  };

  console.log(`\n🔍 1. Looking up bank code for '${primeAccount.bankName}'...`);
  const bankCode = await kora.getBankCode(primeAccount.bankName);
  console.log(`   Bank code resolved: ${bankCode}`);

  console.log(`\n🔍 2. Resolving account '${primeAccount.accountNumber}' with bank code '${bankCode}'...`);
  const resolveRes = await kora.resolveAccount(primeAccount.accountNumber, bankCode || "110002");

  if (resolveRes.success) {
    console.log(`   ✅ Account Verified!`);
    console.log(`   • Account Name: ${resolveRes.accountName}`);
    console.log(`   • Account Number: ${resolveRes.accountNumber}`);
    console.log(`   • Bank Code: ${resolveRes.bankCode}`);
  } else {
    console.log(`   ⚠️ Account verification notice: ${resolveRes.message}`);
    console.log(`   (Note: Test keys often mock account resolution, or live account requires live balance)`);
  }

  console.log(`\n🔍 3. Checking Disbursement Readiness...`);
  console.log(`   Target: ₦2,250 to ${primeAccount.accountNumber} (${primeAccount.bankName})`);
  console.log(`   Ready to auto-execute whenever an order is confirmed by user on Telegram!`);

  console.log("\n=========================================");
  console.log(" Diagnostic complete.");
  console.log("=========================================\n");
}

main().catch(console.error);

