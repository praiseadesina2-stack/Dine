import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const apiHash = process.env.TELEGRAM_API_HASH || "";

async function generateSession() {
  if (!apiId || !apiHash) {
    console.error("❌ TELEGRAM_API_ID or TELEGRAM_API_HASH is missing from your .env file!");
    console.log("\n👉 How to get them (free, takes 1 minute):");
    console.log("1. Go to https://my.telegram.org and log in with your phone number.");
    console.log("2. Click 'API development tools'.");
    console.log("3. Fill in app name (e.g. 'Dine Agent') and submit.");
    console.log("4. Copy 'api_id' and 'api_hash' into your .env file:\n");
    console.log("TELEGRAM_API_ID=12345678");
    console.log("TELEGRAM_API_HASH=abcdef1234567890abcdef\n");
    process.exit(1);
  }

  console.log("🔐 Dine Agent Telegram Session Generator");
  console.log("Connecting to Telegram MTProto Client...\n");

  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your phone number (with country code, e.g. +234...): "),
    password: async () => await input.password("🔒 Enter your Telegram 2FA password (if enabled, or press enter): "),
    phoneCode: async () => await input.text("💬 Enter the code Telegram just sent to your app: "),
    onError: (err) => console.error("Authentication error:", err),
  });

  const sessionString = client.session.save() as unknown as string;

  console.log("\n✅ Success! Telegram session authenticated.");
  console.log("\n📋 Copy this session string and paste it into your .env file:\n");
  console.log(`TELEGRAM_STRING_SESSION=${sessionString}\n`);

  await client.disconnect();
}

generateSession().catch(console.error);
