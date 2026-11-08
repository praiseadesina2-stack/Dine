import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
import { DineOrderingAgent } from "@dine/ai";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// User Session State
interface UserSession {
  step: "idle" | "awaiting_custom_budget";
  budget: BudgetBracket | number;
  budgetLabel: string;
  craving?: CravingType;
  rerollCount: number;
  activeRecs: Recommendation[];
}

const userSessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      step: "idle",
      budget: "1000_2000",
      budgetLabel: "₦1,000 – ₦2,000",
      rerollCount: 0,
      activeRecs: []
    });
  }
  return userSessions.get(userId)!;
}

// Simple in-memory Tray
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

// Step 1: Budget Selection
async function startDecisionFlow(ctx: any) {
  const userId = ctx.from?.id;
  if (userId) {
    const session = getSession(userId);
    session.step = "idle";
    session.rerollCount = 0;
  }

  const keyboard = new InlineKeyboard()
    .text("Under ₦1,000", "bgt:under_1000")
    .text("₦1,000 – ₦2,000", "bgt:1000_2000")
    .row()
    .text("₦2,000 – ₦3,500", "bgt:2000_3500")
    .text("Any Budget 💳", "bgt:any")
    .row()
    .text("✏️ Type My Exact Budget", "bgt:custom");

  const message =
    "🤔 *Feeding decisions made simple.*\n\n" +
    "Let's choose the perfect meal for you in 2 quick steps.\n\n" +
    "💰 *Step 1: Choose or type your budget for this meal:*\n" +
    "_(Pick a bracket below or tap 'Type My Exact Budget')_";

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(message, {
        reply_markup: keyboard,
        parse_mode: "Markdown"
      });
    } catch {
      await ctx.reply(message, { reply_markup: keyboard, parse_mode: "Markdown" });
    }
  } else {
    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }
}

bot.hears("✨ Decide For Me 🍽️", startDecisionFlow);
bot.command("decide", startDecisionFlow);

// Option to type exact custom budget
bot.callbackQuery("bgt:custom", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  session.step = "awaiting_custom_budget";

  await ctx.editMessageText(
    "✏️ *Type your exact budget below:*\n\n" +
      "Send a message with any amount (for example: `1500`, `2200`, or `₦800`).\n\n" +
      "Dine will find the highest-rated active meals matching your exact spending target!",
    {
      reply_markup: new InlineKeyboard().text("🔙 Back to Budget Brackets", "action_restart_decide"),
      parse_mode: "Markdown"
    }
  );
  await ctx.answerCallbackQuery();
});

// Render Craving Step (Step 2)
function renderCravingStep(budgetLabel: string) {
  const keyboard = new InlineKeyboard()
    .text("Heavy & Filling 🍛", "crv:filling")
    .text("Quick Snack 🥪", "crv:snack")
    .row()
    .text("High Protein 💪", "crv:protein")
    .text("Sweet Treat 🧋", "crv:sweet")
    .row()
    .text("Spicy & Savory 🌶️", "crv:spicy")
    .text("Surprise Me! 🎲", "crv:surprise")
    .row()
    .text("🔙 Change Budget", "action_restart_decide");

  const text =
    `💰 Budget: *${budgetLabel}* 🎯\n\n` +
    "😋 *Step 2: What vibe or craving are you feeling right now?*";

  return { text, keyboard };
}

// Budget Bracket Callback
bot.callbackQuery(/^bgt:(under_1000|1000_2000|2000_3500|any)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const budgetKey = ctx.match[1] as BudgetBracket;
  const limits = getBudgetLimits(budgetKey);

  session.budget = budgetKey;
  session.budgetLabel = limits.label;
  session.step = "idle";

  const { text, keyboard } = renderCravingStep(session.budgetLabel);

  await ctx.editMessageText(text, {
    reply_markup: keyboard,
    parse_mode: "Markdown"
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("action_restart_decide", async (ctx) => {
  await startDecisionFlow(ctx);
  await ctx.answerCallbackQuery();
});

// Step 3: Present Curated Choices with Justifications
bot.callbackQuery(/^crv:(filling|snack|protein|sweet|spicy|surprise)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const craving = ctx.match[1] as CravingType;

  session.craving = craving;
  session.rerollCount = 0;

  await showRecommendations(ctx, session);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("action_reroll", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  session.rerollCount += 1;

  await showRecommendations(ctx, session);
  await ctx.answerCallbackQuery({ text: "Served 3 fresh picks! 🎲" });
});

async function showRecommendations(ctx: any, session: UserSession) {
  const craving = session.craving || "filling";
  const recs = recommendMeals(session.budget, craving, session.rerollCount);
  session.activeRecs = recs;

  if (recs.length === 0) {
    await ctx.editMessageText(
      "😕 No active meals found for that exact combination right now.\n\nTry a broader budget or different craving!",
      {
        reply_markup: new InlineKeyboard().text("🔄 Try Another Budget", "action_restart_decide"),
        parse_mode: "Markdown"
      }
    );
    return;
  }

  let message =
    `✨ *Dine Recommendations Just for You*\n` +
    `Budget: *${session.budgetLabel}* · Vibe: *${craving.toUpperCase()}*\n\n`;

  const keyboard = new InlineKeyboard();

  recs.forEach((rec, idx) => {
    message += `${rec.badge}:\n`;
    message += `🍽️ *${rec.itemName}*\n`;
    message += `🏪 *${rec.vendorName}* · 💵 *₦${rec.price.toLocaleString()}*\n`;
    message += `💡 _${rec.reason}_\n\n`;

    // Short callback_data to strictly prevent Telegram 64-byte BUTTON_DATA_INVALID error
    keyboard.text(
      `Pick #${idx + 1}: ${rec.itemName.slice(0, 18)} (₦${rec.price})`,
      `pick:${idx}`
    ).row();
  });

  message += "👇 *Tap your choice to add to tray, or reroll for 3 others:*";

  keyboard
    .text("🎲 Reroll Choices", "action_reroll")
    .text("🔄 Start Over", "action_restart_decide");

  try {
    await ctx.editMessageText(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  } catch (err) {
    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }
}

// User Chooses a Recommendation
bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const index = parseInt(ctx.match[1], 10);
  const chosen = session.activeRecs[index];

  if (!chosen) {
    await ctx.answerCallbackQuery({ text: "Selection expired, please try again." });
    return;
  }

  const tray = getTray(userId);
  tray.push({
    itemName: chosen.itemName,
    vendorName: chosen.vendorName,
    price: chosen.price
  });

  const keyboard = new InlineKeyboard()
    .text("🛒 View My Tray", "action_view_tray")
    .text("✨ Pick Another Meal", "action_restart_decide");

  await ctx.editMessageText(
    `🎉 *Choice Made!*\n\n` +
      `We've added *${chosen.itemName}* from *${chosen.vendorName}* (₦${chosen.price.toLocaleString()}) to your tray!\n\n` +
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
      .text("✨ Decide For Me 🍽️", "action_restart_decide")
      .row()
      .text("🔍 Browse Vendors", "action_browse_vendors");

    const text =
      "🛒 *Your Tray is Empty*\n\n" +
      "Don't know what to eat? Tap *Decide For Me* and let Dine pick for you!";

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
  text += "Ready to place your order or want to add another meal?";

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

const orderingAgent = new DineOrderingAgent();

bot.callbackQuery("action_confirm_order", async (ctx) => {
  const userId = ctx.from.id;
  const tray = getTray(userId);

  if (tray.length === 0) {
    await ctx.answerCallbackQuery({ text: "Your tray is empty." });
    return;
  }

  const total = tray.reduce((sum, item) => sum + item.price, 0);
  await ctx.answerCallbackQuery();

  // If agent is not configured, fall back to informative message
  if (!orderingAgent.isConfigured()) {
    await ctx.reply(
      `✅ *Order Confirmed!*\n\n` +
        `Items: *${tray.length}*\n` +
        `Total: *₦${total.toLocaleString()}*\n\n` +
        `⚙️ _Autonomous ordering is not yet activated on this deployment._\n` +
        `Please contact Dine support to place your order manually.`,
      { reply_markup: mainKeyboard, parse_mode: "Markdown" }
    );
    return;
  }

  // Show processing message
  const processingMsg = await ctx.reply(
    `⏳ *Placing your order on Prime...*\n\n` +
      `Processing *${tray.length} item(s)* — Total: *₦${total.toLocaleString()}*\n\n` +
      `_This usually takes 10–20 seconds. Hang tight!_`,
    { parse_mode: "Markdown" }
  );

  const results: string[] = [];
  const paystackLinks: string[] = [];

  // Place each tray item as a separate order sequentially
  for (let i = 0; i < tray.length; i++) {
    const item = tray[i];
    const label = `#${i + 1} ${item.itemName} (${item.vendorName})`;

    try {
      const result = await orderingAgent.placeOrder({
        vendorName: item.vendorName,
        itemName: item.itemName
      });

      if (result.success) {
        results.push(`✅ ${label}`);
        if (result.paystackUrl) {
          paystackLinks.push(`💳 [Pay for ${item.itemName}](${result.paystackUrl})`);
        }
      } else {
        results.push(`❌ ${label}\n   _${result.message}_`);
      }
    } catch (err: any) {
      results.push(`❌ ${label}\n   _Error: ${err?.message || "Unknown error"}_`);
    }
  }

  // Clear tray after ordering attempt
  userTrays.set(userId, []);

  // Build summary message
  let summary = `🎉 *Order Summary*\n\n`;
  summary += results.join("\n") + "\n\n";
  summary += `💵 *Total: ₦${total.toLocaleString()}*\n\n`;

  if (paystackLinks.length > 0) {
    summary += `*Payment Links:*\n${paystackLinks.join("\n")}\n\n`;
    summary += `_Tap a link above to complete payment via Paystack._`;
  } else {
    summary += `_No Paystack links were returned yet. The vendor may have a different checkout flow._`;
  }

  // Edit the processing message to show the summary (no reply keyboard on edit — send that separately)
  try {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      summary,
      { parse_mode: "Markdown" }
    );
  } catch {
    // ignore if message couldn't be edited
  }
  await ctx.reply("👆 Order complete! What's next?", {
    reply_markup: mainKeyboard,
    parse_mode: "Markdown"
  });
});

// ----------------------------------------------------
// 3. Browse Vendors (Directory Mode)
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
    const userId = ctx.from.id;
    const session = getSession(userId);
    session.activeRecs = vendor.items.slice(0, 5).map((item) => ({
      badge: "⭐ Menu Item",
      title: item.name,
      vendorName: vendor.name,
      vendorId: vendor.id,
      itemName: item.name,
      price: item.price,
      reason: "Available from vendor"
    }));

    vendor.items.slice(0, 5).forEach((item, idx) => {
      keyboard.text(
        `Add ${item.name.slice(0, 18)} (₦${item.price})`,
        `pick:${idx}`
      ).row();
    });
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
      "Tap *✨ Decide For Me 🍽️* below and Dine will choose the best meal for your budget and cravings!",
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
      "• You can also type any budget directly (e.g. `1500` or `2000`).\n" +
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
      `• Preference Profile: *Active*`,
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

// ----------------------------------------------------
// 5. Intelligent Message Handler (Typed Budgets & Natural Chat)
// ----------------------------------------------------

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;
  const session = getSession(userId);

  // If it's one of our persistent bottom keyboard buttons or commands, ignore here
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

  // Check if text is a typed budget number (e.g. "1500", "2000", "₦1,500", "2500 naira", "1.5k", "2k")
  let typedNumber: number | null = null;
  const lower = text.toLowerCase();

  const kMatch = lower.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) {
    typedNumber = Math.round(parseFloat(kMatch[1]) * 1000);
  } else {
    const rawDigits = text.replace(/[^\d]/g, "");
    if (rawDigits.length > 0) {
      const parsed = parseInt(rawDigits, 10);
      if (parsed >= 100 && parsed <= 50000) {
        typedNumber = parsed;
      }
    }
  }

  // If user is waiting for custom budget OR simply typed a number
  if (typedNumber !== null) {
    session.budget = typedNumber;
    session.budgetLabel = `₦${typedNumber.toLocaleString()}`;
    session.step = "idle";

    const { text: cravingText, keyboard } = renderCravingStep(session.budgetLabel);

    await ctx.reply(
      `🎯 *Budget set to ₦${typedNumber.toLocaleString()}!*\n\n` + cravingText,
      {
        reply_markup: keyboard,
        parse_mode: "Markdown"
      }
    );
    return;
  }

  // Freeform natural language query (e.g. "I want chicken and rice under 2000")
  let craving: CravingType = "filling";

  if (lower.includes("protein") || lower.includes("chicken") || lower.includes("beef") || lower.includes("fish") || lower.includes("suya") || lower.includes("egg")) {
    craving = "protein";
  } else if (lower.includes("sweet") || lower.includes("parfait") || lower.includes("shake") || lower.includes("waffle")) {
    craving = "sweet";
  } else if (lower.includes("snack") || lower.includes("quick") || lower.includes("light") || lower.includes("chips")) {
    craving = "snack";
  } else if (lower.includes("spicy") || lower.includes("pepper")) {
    craving = "spicy";
  }

  session.craving = craving;
  session.rerollCount = 0;
  await showRecommendations(ctx, session);
});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();
console.log("Dine Telegram bot is running with custom typed budget and fixed decision engine!");
