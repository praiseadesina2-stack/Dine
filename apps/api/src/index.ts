import dotenv from "dotenv";
import path from "path";

// Load .env from local or workspace root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// Welcome command
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Welcome to Dine! 🍽️\n\n" +
      "Feeding decisions made simple.\n\n" +
      "I can help you discover meals, plan your food " +
      "and manage your orders.\n\n" +
      "Send /help to see what I can do."
  );
});

// Help command
bot.command("help", async (ctx) => {
  await ctx.reply(
    "Here's how to use Dine:\n\n" +
      "/start - Start using Dine\n" +
      "/help - See available commands\n" +
      "/menu - Explore available meals\n" +
      "/find - Find something to eat\n" +
      "/plan - Plan your meals\n" +
      "/wallet - Check your wallet\n" +
      "/orders - View your orders\n\n" +
      "More features are coming soon!"
  );
});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();
console.log("Dine Telegram bot is running!");
