import dotenv from "dotenv";
import path from "path";

// Load .env from local or workspace root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { VENDORS, PAGE_SIZE, TOTAL_PAGES, Vendor } from "./data/vendors.js";
import {
  recommendMeals,
  getBudgetLimits,
  BudgetBracket,
  CravingType,
  Recommendation
} from "./engine/recommender.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// Simple session tray (in-memory for instant feedback)
interface TrayItem {
  itemName: string;
  vendorName: string;
  price: number;
}
const userTrays = new Map<number, TrayItem[]>();

function getTray(userId: number): TrayItem[] {
  if (!userTrays.has(userId)) {
    userTrays.set(userId, []);
  }
  return userTrays.get(userId)!;
}

// Dine Custom Bottom Keyboard
const mainKeyboard = new Keyboard()
  .text("✨ Decide For Me 🍽️")
  .row()
  .text("🔍 Browse Vendors")
  .text("🛒 My Tray")
  .row()
  .text("💰 Wallet")
  .text("👤 My Profile")
  .text("💬 Talk to Us")
  .resized()
  .persistent();

// ----------------------------------------------------
// 1. Interactive Decision Engine Flows
// ----------------------------------------------------

// Step 1: Ask for Budget
async function startDecisionFlow(ctx: any) {
  const keyboard = new InlineKeyboard()
    .text("Under ₦1,000", "budget:under_1000")
    .text("₦1,000 – ₦2,000", "budget:1000_2000")
    .row()
    .text("₦2,000 – ₦3,500", "budget:2000_3500")
    .text("Any Budget 💳", "budget:any")
    .row();

  const message =
    "🤔 *Feeding decisions made simple.*\n\n" +
    "Let's choose the perfect meal for you in 2 quick taps.\n\n" +
    "💰 *Step 1: What is your budget for this meal?*";

  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  } else {
    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }
}

bot.hears("✨ Decide For Me 🍽️", startDecisionFlow);
bot.command("decide", startDecisionFlow);

// Step 2: Ask for Craving / Vibe
bot.callbackQuery(/^budget:(under_1000|1000_2000|2000_3500|any)$/, async (ctx) => {
  const budget = ctx.match[1] as BudgetBracket;
  const limits = getBudgetLimits(budget);

  const keyboard = new InlineKeyboard()
    .text("Heavy & Filling 🍛", `craving:${budget}:filling:0`)
    .text("Quick Snack 🥪", `craving:${budget}:snack:0`)
    .row()
    .text("High Protein 💪", `craving:${budget}:protein:0`)
    .text("Sweet Treat 🧋", `craving:${budget}:sweet:0`)
    .row()
    .text("Spicy & Savory 🌶️", `craving:${budget}:spicy:0`)
    .text("Surprise Me! 🎲", `craving:${budget}:surprise:0`)
    .row()
    .text("🔙 Change Budget", "action_restart_decide");

  await ctx.editMessageText(
    `💰 Budget: *${limits.label}* 🎯\n\n` +
      "😋 *Step 2: What vibe or craving are you feeling right now?*",
    {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("action_restart_decide", async (ctx) => {
  await startDecisionFlow(ctx);
  await ctx.answerCallbackQuery();
});

// Step 3: Present Curated Choices with Justifications
bot.callbackQuery(/^craving:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  const budget = ctx.match[1] as BudgetBracket;
  const craving = ctx.match[2] as CravingType;
  const offset = parseInt(ctx.match[3], 10);

  const limits = getBudgetLimits(budget);
  const recommendations = recommendMeals(budget, craving, offset);

  if (recommendations.length === 0) {
    await ctx.editMessageText(
      "😕 No active meals found for that exact combination right now.\n\nTry a broader budget or different craving!",
      {
        reply_markup: new InlineKeyboard().text("🔄 Try Again", "action_restart_decide"),
        parse_mode: "Markdown"
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  let message =
    `✨ *Dine Recommendations Just for You*\n` +
    `Budget: *${limits.label}* · Vibe: *${craving.toUpperCase()}*\n\n`;

  const keyboard = new InlineKeyboard();

  recommendations.forEach((rec, idx) => {
    message += `${rec.badge}:\n`;
    message += `🍽️ *${rec.itemName}*\n`;
    message += `🏪 *${rec.vendorName}* · 💵 *₦${rec.price.toLocaleString()}*\n`;
    message += `💡 _${rec.reason}_\n\n`;

    // Add button to choose this meal
    keyboard.text(
      `Pick #${idx + 1}: ${rec.itemName.slice(0, 20)} (₦${rec.price})`,
      `choose_rec:${rec.vendorId}:${encodeURIComponent(rec.itemName)}:${rec.price}`
    ).row();
  });

  message += "👇 *Tap a button to choose your meal, or reroll for 3 others:*";

  keyboard
    .text("🎲 Reroll Choices", `craving:${budget}:${craving}:${offset + 1}`)
    .text("🔄 Start Over", "action_restart_decide");

  await ctx.editMessageText(message, {
    reply_markup: keyboard,
    parse_mode: "Markdown"
  });
  await ctx.answerCallbackQuery();
});

// User Chooses a Meal
bot.callbackQuery(/^choose_rec:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  const vendorId = ctx.match[1];
  const itemName = decodeURIComponent(ctx.match[2]);
  const price = parseInt(ctx.match[3], 10);
  const vendor = VENDORS.find((v) => v.id === vendorId);

  const userId = ctx.from.id;
  const tray = getTray(userId);
  tray.push({
    itemName,
    vendorName: vendor?.name || "Vendor",
    price
  });

  const keyboard = new InlineKeyboard()
    .text("🛒 View My Tray", "action_view_tray")
    .text("✨ Pick Another Meal", "action_restart_decide");

  await ctx.editMessageText(
    `🎉 *Choice Made!*\n\n` +
      `We've added *${itemName}* from *${vendor?.name || "Vendor"}* (₦${price.toLocaleString()}) to your tray.\n\n` +
      `Your tray now has *${tray.length} item(s)*.`,
    {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    }
  );
  await ctx.answerCallbackQuery({ text: "Added to tray! 🍽️" });
});

// ----------------------------------------------------
// 2. Tray / Cart Management
// ----------------------------------------------------

async function showTray(ctx: any) {
  const userId = ctx.from?.id;
  const tray = getTray(userId);

  if (tray.length === 0) {
    const emptyKeyboard = new InlineKeyboard()
      .text("✨ Decide For Me 🍽️", "action_start_decide")
      .row()
      .text("🔍 Browse Vendors", "action_browse_vendors");

    const text =
      "🛒 *Your Tray is Empty*\n\n" +
      "Don't know what to eat? Tap *Decide For Me* and let Dine choose your meal!";

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: emptyKeyboard, parse_mode: "Markdown" });
    } else {
      await ctx.reply(text, { reply_markup: emptyKeyboard, parse_mode: "Markdown" });
    }
    return;
  }

  let total = 0;
  let text = "🛒 *Your Current Tray:*\n\n";

  tray.forEach((item, idx) => {
    total += item.price;
    text += `${idx + 1}. *${item.itemName}* (${item.vendorName}) — ₦${item.price.toLocaleString()}\n`;
  });

  text += `\n💵 *Total: ₦${total.toLocaleString()}*\n\n`;
  text += "Ready to place your order or need another item?";

  const keyboard = new InlineKeyboard()
    .text("💳 Confirm & Order", "action_confirm_order")
    .row()
    .text("✨ Add Another Meal", "action_restart_decide")
    .text("🗑️ Clear Tray", "action_clear_tray");

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  } else {
    await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}

bot.hears("🛒 My Tray", showTray);
bot.command("tray", showTray);
bot.command("cart", showTray);
bot.callbackQuery("action_view_tray", async (ctx) => {
  await showTray(ctx);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("action_clear_tray", async (ctx) => {
  const userId = ctx.from.id;
  userTrays.set(userId, []);
  await ctx.answerCallbackQuery({ text: "Tray cleared." });
  await showTray(ctx);
});

bot.callbackQuery("action_confirm_order", async (ctx) => {
  const userId = ctx.from.id;
  const tray = getTray(userId);
  const total = tray.reduce((sum, item) => sum + item.price, 0);

  await ctx.answerCallbackQuery();
  await ctx.reply(
    `✅ *Order Intent Recorded!*\n\n` +
      `Items: *${tray.length}*\n` +
      `Total Amount: *₦${total.toLocaleString()}*\n\n` +
      `Campus pickup and direct wallet payment will be finalized in the upcoming transactions milestone.`,
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// ----------------------------------------------------
// 3. Browse Vendors (Optional Explore View)
// ----------------------------------------------------

function renderVendorsPage(page: number) {
  const startIndex = (page - 1) * PAGE_SIZE;
  const pageVendors = VENDORS.slice(startIndex, startIndex + PAGE_SIZE);

  let message = "🍽️ *Campus Vendors Directory*\n\n";

  for (const vendor of pageVendors) {
    const statusIcon = vendor.status === "active" ? "🟢 Active" : "🔴 Closed";
    message += `*${vendor.name}* · ${statusIcon}\n`;
    message += `${vendor.sampleDescription}\n`;
    message += `From ₦${vendor.minPrice.toLocaleString()}\n\n`;
  }

  message += `_Page ${page} of ${TOTAL_PAGES}_\n\n`;
  message += "👇 *Tap a vendor to inspect full menu:*";

  const keyboard = new InlineKeyboard();

  for (const vendor of pageVendors) {
    keyboard.text(vendor.name, `vendor:${vendor.id}`).row();
  }

  const hasPrev = page > 1;
  const hasNext = page < TOTAL_PAGES;

  if (hasPrev && hasNext) {
    keyboard.text("◀️ Prev", `page:${page - 1}`).text("Next ▶️", `page:${page + 1}`).row();
  } else if (hasPrev) {
    keyboard.text("◀️ Prev", `page:${page - 1}`).row();
  } else if (hasNext) {
    keyboard.text("Next ▶️", `page:${page + 1}`).row();
  }

  keyboard.text("✨ Help Me Decide Instead 🍽️", "action_restart_decide");

  return { message, keyboard };
}

function renderVendorMenu(vendor: Vendor, returnPage: number = 1) {
  const statusIcon = vendor.status === "active" ? "🟢 Active" : "🔴 Closed";
  let message = `*${vendor.name}* · ${statusIcon}\n\n`;

  for (const item of vendor.items) {
    message += `${item.name} — *₦${item.price.toLocaleString()}*\n`;
  }

  const keyboard = new InlineKeyboard();

  if (vendor.status === "active") {
    keyboard.text("➕ Add Items", `order_vendor:${vendor.id}`).row();
  }
  keyboard.text("🔙 Back to Vendors", `page:${returnPage}`);

  return { message, keyboard };
}

async function sendVendorList(ctx: any) {
  const { message, keyboard } = renderVendorsPage(1);
  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  } else {
    await ctx.reply(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}

bot.hears("🔍 Browse Vendors", sendVendorList);
bot.command("vendors", sendVendorList);
bot.callbackQuery("action_browse_vendors", async (ctx) => {
  await sendVendorList(ctx);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^page:(\d+)$/, async (ctx) => {
  const pageNum = parseInt(ctx.match[1], 10);
  const { message, keyboard } = renderVendorsPage(pageNum);
  try {
    await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^vendor:(.+)$/, async (ctx) => {
  const vendorId = ctx.match[1];
  const vendor = VENDORS.find((v) => v.id === vendorId);

  if (!vendor) {
    await ctx.answerCallbackQuery({ text: "Vendor not found." });
    return;
  }

  const { message, keyboard } = renderVendorMenu(vendor, 1);
  try {
    await ctx.editMessageText(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply(message, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^order_vendor:(.+)$/, async (ctx) => {
  const vendorId = ctx.match[1];
  const vendor = VENDORS.find((v) => v.id === vendorId);

  await ctx.answerCallbackQuery({ text: "Opening items..." });

  const keyboard = new InlineKeyboard();
  if (vendor) {
    for (const item of vendor.items.slice(0, 5)) {
      keyboard.text(
        `Add ${item.name.slice(0, 20)} (₦${item.price})`,
        `choose_rec:${vendor.id}:${encodeURIComponent(item.name)}:${item.price}`
      ).row();
    }
  }
  keyboard.text("🔙 Back to Menu", `vendor:${vendorId}`);

  await ctx.reply(
    `🛍️ *Select an item from ${vendor?.name || "Vendor"}:*`,
    {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    }
  );
});

// ----------------------------------------------------
// 4. Utility Commands & Info
// ----------------------------------------------------

bot.api.setMyCommands([
  { command: "start", description: "Start Dine & open main menu" },
  { command: "decide", description: "✨ Help me decide what to eat" },
  { command: "tray", description: "🛒 View my meal tray" },
  { command: "vendors", description: "🔍 Browse campus vendors directory" },
  { command: "wallet", description: "💰 Check Dine wallet balance" },
  { command: "help", description: "ℹ️ How to use Dine" }
]).catch((err) => console.error("Could not register bot commands:", err));

bot.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name || "there";
  await ctx.reply(
    `Welcome to Dine, ${firstName}! 🍽️\n\n` +
      "Feeding decisions made simple.\n\n" +
      "Tired of wondering what to eat or scrolling through endless menus?\n\n" +
      "Tap *✨ Decide For Me 🍽️* below and Dine will pick the best meal for your budget and cravings!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🍽️ *Dine Quick Guide:*\n\n" +
      "• Tap *✨ Decide For Me 🍽️* to get 3 smart meal recommendations based on your budget and craving.\n" +
      "• Tap *🛒 My Tray* to view chosen meals.\n" +
      "• Tap *🔍 Browse Vendors* to view the full directory.\n" +
      "• Tap *💰 Wallet* to inspect your balance.\n" +
      "• Tap *👤 My Profile* to view your details.\n" +
      "• Tap *💬 Talk to Us* for cafeteria support.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

bot.hears("💰 Wallet", async (ctx) => {
  await ctx.reply(
    "💰 *Dine Wallet*\n\n" +
      "• Available Balance: *₦0.00*\n" +
      "• Status: *Active (Demo Mode)*\n\n" +
      "Funding and direct campus cafeteria checkout will be enabled in the payment milestone.",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

bot.hears("👤 My Profile", async (ctx) => {
  const user = ctx.from;
  const username = user?.username ? `@${user.username}` : "Not set";
  await ctx.reply(
    "👤 *Student Profile*\n\n" +
      `• Name: *${user?.first_name || ""} ${user?.last_name || ""}*\n` +
      `• Username: *${username}*\n` +
      `• Telegram ID: \`${user?.id}\`\n` +
      `• Campus: *Covenant University*\n` +
      `• Preference Profile: *Ready*`,
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

bot.hears("💬 Talk to Us", async (ctx) => {
  await ctx.reply(
    "💬 *Dine Student Support*\n\n" +
      "Need food suggestions or having trouble with a vendor?\n\n" +
      "Send your message directly here and we will assist you!",
    {
      reply_markup: mainKeyboard,
      parse_mode: "Markdown"
    }
  );
});

// Natural Language query fallback (if student writes text instead of tapping)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  // If it's one of our button labels or commands, let existing handlers run
  if (
    text.startsWith("/") ||
    text === "✨ Decide For Me 🍽️" ||
    text === "🔍 Browse Vendors" ||
    text === "🛒 My Tray" ||
    text === "💰 Wallet" ||
    text === "👤 My Profile" ||
    text === "💬 Talk to Us"
  ) {
    return;
  }

  // Parse natural queries like "I have 1500 and want chicken"
  const lower = text.toLowerCase();
  let budget: BudgetBracket = "1000_2000";
  let craving: CravingType = "filling";

  if (lower.includes("1000") || lower.includes("1k") || lower.includes("under 1000")) {
    budget = "under_1000";
  } else if (lower.includes("3000") || lower.includes("3500") || lower.includes("2500")) {
    budget = "2000_3500";
  }

  if (lower.includes("protein") || lower.includes("chicken") || lower.includes("beef") || lower.includes("fish") || lower.includes("suya")) {
    craving = "protein";
  } else if (lower.includes("sweet") || lower.includes("parfait") || lower.includes("shake") || lower.includes("waffle")) {
    craving = "sweet";
  } else if (lower.includes("snack") || lower.includes("quick") || lower.includes("light")) {
    craving = "snack";
  } else if (lower.includes("spicy") || lower.includes("pepper")) {
    craving = "spicy";
  }

  const recs = recommendMeals(budget, craving, 0);

  if (recs.length > 0) {
    let response = `🤖 *I heard:* "${text}"\n\nHere are *3 options* I picked for you:\n\n`;
    const keyboard = new InlineKeyboard();

    recs.forEach((rec, idx) => {
      response += `${rec.badge}:\n`;
      response += `🍽️ *${rec.itemName}* (${rec.vendorName}) — *₦${rec.price.toLocaleString()}*\n`;
      response += `💡 _${rec.reason}_\n\n`;

      keyboard.text(
        `Pick #${idx + 1}: ${rec.itemName.slice(0, 18)} (₦${rec.price})`,
        `choose_rec:${rec.vendorId}:${encodeURIComponent(rec.itemName)}:${rec.price}`
      ).row();
    });

    keyboard.text("✨ Open Decision Guide", "action_restart_decide");

    await ctx.reply(response, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  } else {
    await ctx.reply(
      "I'm here to help you choose! Tap *✨ Decide For Me 🍽️* below to find something delicious.",
      { reply_markup: mainKeyboard }
    );
  }
});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();
console.log("Dine Telegram bot is running with AI decision engine!");
