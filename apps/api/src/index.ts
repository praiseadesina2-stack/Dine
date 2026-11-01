import dotenv from "dotenv";
import path from "path";

// Load .env from local or workspace root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

import { Bot, Keyboard, InlineKeyboard } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// Persistent Main Keyboard (matching the Dine UI design)
const mainKeyboard = new Keyboard()
  .text("I'm Hungry 🍽️")
  .row()
  .text("🛒 My Cart")
  .text("💰 Wallet")
  .row()
  .text("👤 My Profile")
  .text("💬 Talk to Us")
  .resized()
  .persistent();

// Inline keyboard for order actions
const orderInlineKeyboard = new InlineKeyboard()
  .text("🍽️ Order now", "action_order_now");

// Configure Telegram command menu (the blue "Menu" button)
bot.api.setMyCommands([
  { command: "start", description: "Open main menu & get started" },
  { command: "hungry", description: "Explore food & order now" },
  { command: "menu", description: "View active campus vendors" },
  { command: "cart", description: "Check your current cart" },
  { command: "wallet", description: "Check Dine wallet balance" },
  { command: "help", description: "Get help & commands" }
]).catch((err) => console.error("Could not register bot commands:", err));

// /start command
bot.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name || "there";
  await ctx.reply(
    `Welcome to Dine, ${firstName}! 🍽️\n\n` +
      "Feeding decisions made simple.\n\n" +
      "I can help you discover meals from campus vendors, plan your food schedule, and manage your orders seamlessly.\n\n" +
      "Tap **I'm Hungry 🍽️** below to see today's available meals!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// /help command
bot.command("help", async (ctx) => {
  await ctx.reply(
    "🍽️ *Dine Quick Guide*:\n\n" +
      "• Tap *I'm Hungry 🍽️* to see live vendor menus.\n" +
      "• Tap *🛒 My Cart* to view items waiting for checkout.\n" +
      "• Tap *💰 Wallet* to inspect your Dine balance.\n" +
      "• Tap *👤 My Profile* to view your account details.\n" +
      "• Tap *💬 Talk to Us* for student support.\n\n" +
      "You can also use the blue *Menu* button in the bottom left anytime!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "I'm Hungry 🍽️" handler (also responds to /hungry and /menu)
async function sendFoodMenu(ctx: any) {
  const menuText =
    "Delish Yamarita · 🟢 Active\n\n" +
    "Delish Pack + 1 Kebab — ₦2,200\n" +
    "Delish Pack + 2 Kebabs — ₦2,600\n" +
    "Delish Pack + 3 Kebabs — ₦3,000\n" +
    "Delish Pack + 4 Kebabs — ₦3,400\n" +
    "Delish Pack + 5 Kebabs — ₦3,800\n" +
    "Egg — ₦300\n" +
    "Kings Pack + 1 Kebab — ₦3,000\n" +
    "Kings Pack + 2 Kebabs — ₦3,400\n" +
    "Kings Pack + 3 Kebabs — ₦3,800";

  await ctx.reply(menuText, {
    reply_markup: orderInlineKeyboard
  });
}

bot.hears("I'm Hungry 🍽️", sendFoodMenu);
bot.command("hungry", sendFoodMenu);
bot.command("menu", sendFoodMenu);

// Inline button callback: "🍽️ Order now"
bot.callbackQuery("action_order_now", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Opening order options..." });
  await ctx.reply(
    "🛍️ *Place your order*\n\n" +
      "Select what you'd like or reply with your meal choice (e.g. _Delish Pack + 2 Kebabs_).\n\n" +
      "Our AI ordering assistant will confirm slot availability and your delivery pickup point!",
    { parse_mode: "Markdown" }
  );
});

// "🛒 My Cart" handler
bot.hears("🛒 My Cart", async (ctx) => {
  await ctx.reply(
    "🛒 *Your Cart*\n\n" +
      "Your cart is currently empty.\n\n" +
      "Tap *I'm Hungry 🍽️* to browse meals and add items to your cart!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "💰 Wallet" handler
bot.hears("💰 Wallet", async (ctx) => {
  await ctx.reply(
    "💰 *Dine Wallet*\n\n" +
      "Current Balance: *₦0.00*\n\n" +
      "Safe payments & virtual account funding will be enabled in the upcoming payment milestone.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "👤 My Profile" handler
bot.hears("👤 My Profile", async (ctx) => {
  const user = ctx.from;
  const username = user?.username ? `@${user.username}` : "Not set";
  await ctx.reply(
    "👤 *Student Profile*\n\n" +
      `• Name: *${user?.first_name || ""} ${user?.last_name || ""}*\n` +
      `• Username: *${username}*\n` +
      `• Telegram ID: \`${user?.id}\`\n` +
      `• Consent Status: *Active (Essential Terms)*\n` +
      `• Campus: *Covenant University*`,
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "💬 Talk to Us" handler
bot.hears("💬 Talk to Us", async (ctx) => {
  await ctx.reply(
    "💬 *Dine Support*\n\n" +
      "Have a question, feedback, or need help with a vendor?\n\n" +
      "We're here for you! Send your message here or contact the cafeteria coordination team.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();
console.log("Dine Telegram bot is running with custom keyboard and menus!");
