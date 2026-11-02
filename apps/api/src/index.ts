import dotenv from "dotenv";
import path from "path";

// Load .env from local or workspace root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { VENDORS, PAGE_SIZE, TOTAL_PAGES, Vendor } from "./data/vendors.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// Persistent bottom keyboard (matching Dine design)
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

// Helper to render a page of vendors
function renderVendorsPage(page: number) {
  const startIndex = (page - 1) * PAGE_SIZE;
  const pageVendors = VENDORS.slice(startIndex, startIndex + PAGE_SIZE);

  let message = "🍽️ *Choose a vendor and let's get ordering!*\n\n";

  for (const vendor of pageVendors) {
    const statusIcon = vendor.status === "active" ? "🟢 Active" : "🔴 Closed";
    message += `*${vendor.name}* · ${statusIcon}\n`;
    message += `${vendor.sampleDescription}\n`;
    message += `From ₦${vendor.minPrice.toLocaleString()}\n\n`;
  }

  message += `_Page ${page} of ${TOTAL_PAGES}_\n\n`;
  message += "👇 *Tap a vendor to see their menu*";

  const keyboard = new InlineKeyboard();

  // One button per vendor on this page
  for (const vendor of pageVendors) {
    keyboard.text(vendor.name, `vendor:${vendor.id}`).row();
  }

  // Pagination navigation row
  const hasPrev = page > 1;
  const hasNext = page < TOTAL_PAGES;

  if (hasPrev && hasNext) {
    keyboard.text("◀️ Prev", `page:${page - 1}`).text("Next ▶️", `page:${page + 1}`).row();
  } else if (hasPrev) {
    keyboard.text("◀️ Prev", `page:${page - 1}`).row();
  } else if (hasNext) {
    keyboard.text("Next ▶️", `page:${page + 1}`).row();
  }

  // Search button on last page or all pages
  keyboard.text("🔍 Find a meal or vendor", "action_find_vendor");

  return { message, keyboard };
}

// Helper to render an expanded vendor's full menu
function renderVendorMenu(vendor: Vendor, returnPage: number = 1) {
  const statusIcon = vendor.status === "active" ? "🟢 Active" : "🔴 Closed";
  let message = `*${vendor.name}* · ${statusIcon}\n\n`;

  for (const item of vendor.items) {
    message += `${item.name} — *₦${item.price.toLocaleString()}*\n`;
  }

  const keyboard = new InlineKeyboard();

  if (vendor.status === "active") {
    keyboard.text("🍽️ Order now", `order_vendor:${vendor.id}`).row();
  }
  keyboard.text("🔙 Back to Vendors", `page:${returnPage}`);

  return { message, keyboard };
}

// Configure Telegram command menu
bot.api.setMyCommands([
  { command: "start", description: "Start Dine & open main menu" },
  { command: "hungry", description: "Browse campus vendors & menus" },
  { command: "menu", description: "Browse campus vendors & menus" },
  { command: "cart", description: "View your current cart" },
  { command: "wallet", description: "Check your Dine wallet" },
  { command: "help", description: "How to use Dine" }
]).catch((err) => console.error("Could not register bot commands:", err));

// /start command
bot.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name || "there";
  await ctx.reply(
    `Welcome to Dine, ${firstName}! 🍽️\n\n` +
      "Feeding decisions made simple.\n\n" +
      "I can help you discover meals, plan your food schedule, and manage your orders.\n\n" +
      "Tap *I'm Hungry 🍽️* below to see what's cooking right now!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// /help command
bot.command("help", async (ctx) => {
  await ctx.reply(
    "🍽️ *Here's how to use Dine:*\n\n" +
      "• Tap *I'm Hungry 🍽️* to choose a vendor and browse their full menu.\n" +
      "• Tap *🛒 My Cart* to view items waiting for order.\n" +
      "• Tap *💰 Wallet* to inspect your balance.\n" +
      "• Tap *👤 My Profile* to view student information.\n" +
      "• Tap *💬 Talk to Us* to reach cafeteria support.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "I'm Hungry 🍽️" handler (also responds to /hungry and /menu)
async function sendVendorList(ctx: any) {
  const { message, keyboard } = renderVendorsPage(1);
  await ctx.reply(message, {
    reply_markup: keyboard,
    parse_mode: "Markdown"
  });
}

bot.hears("I'm Hungry 🍽️", sendVendorList);
bot.command("hungry", sendVendorList);
bot.command("menu", sendVendorList);

// Callback: Pagination ("page:1", "page:2", etc.)
bot.callbackQuery(/^page:(\d+)$/, async (ctx) => {
  const pageNum = parseInt(ctx.match[1], 10);
  const { message, keyboard } = renderVendorsPage(pageNum);

  try {
    await ctx.editMessageText(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  } catch (e) {
    // If text didn't change or cannot be edited, reply directly
    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }
  await ctx.answerCallbackQuery();
});

// Callback: Vendor selection ("vendor:<vendor_id>") -> expands to show item prices!
bot.callbackQuery(/^vendor:(.+)$/, async (ctx) => {
  const vendorId = ctx.match[1];
  const vendor = VENDORS.find((v) => v.id === vendorId);

  if (!vendor) {
    await ctx.answerCallbackQuery({ text: "Vendor not found." });
    return;
  }

  const { message, keyboard } = renderVendorMenu(vendor, 1);

  try {
    await ctx.editMessageText(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  } catch (e) {
    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }
  await ctx.answerCallbackQuery();
});

// Callback: Order now ("order_vendor:<vendor_id>")
bot.callbackQuery(/^order_vendor:(.+)$/, async (ctx) => {
  const vendorId = ctx.match[1];
  const vendor = VENDORS.find((v) => v.id === vendorId);

  await ctx.answerCallbackQuery({ text: "Opening order..." });

  const keyboard = new InlineKeyboard();
  if (vendor) {
    for (const item of vendor.items.slice(0, 5)) {
      keyboard.text(`Add ${item.name} (₦${item.price})`, `add_item:${vendor.id}:${item.price}`).row();
    }
  }
  keyboard.text("🔙 Back to Menu", `vendor:${vendorId}`);

  await ctx.reply(
    `🛍️ *Ordering from ${vendor?.name || "Vendor"}*\n\n` +
      "Select an item below or type what you would like to eat:",
    {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    }
  );
});

// Callback: Add item to cart
bot.callbackQuery(/^add_item:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Added to your order! 🍽️" });
  await ctx.reply(
    "✅ Item added to your tray! You can view your selections anytime under *🛒 My Cart*.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// Callback: Find vendor or meal
bot.callbackQuery("action_find_vendor", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🔍 *Find a Meal or Vendor*\n\n" +
      "Type the name of what you're craving (e.g. _Shawarma_, _Parfait_, _Pizza_, _Yamarita_) and Dine's AI will find the best match for you!",
    { parse_mode: "Markdown" }
  );
});

// "🛒 My Cart" handler
bot.hears("🛒 My Cart", async (ctx) => {
  await ctx.reply(
    "🛒 *Your Cart*\n\n" +
      "Your cart is currently empty.\n\n" +
      "Tap *I'm Hungry 🍽️* to choose a vendor and add delicious meals to your cart!",
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
      "• Available Balance: *₦0.00*\n" +
      "• Virtual Account: *Pending Setup*\n\n" +
      "Funding and direct campus cafeteria checkout will be enabled in the payment milestone.",
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
      `• University: *Covenant University*\n` +
      `• Status: *Active Student*`,
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// "💬 Talk to Us" handler
bot.hears("💬 Talk to Us", async (ctx) => {
  await ctx.reply(
    "💬 *Dine Support & Cafeteria Help*\n\n" +
      "Got questions, issues with an order, or vendor feedback?\n\n" +
      "Send your message directly here and our team will get back to you promptly!",
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
console.log("Dine Telegram bot is running with paginated vendors and expandable menus!");
