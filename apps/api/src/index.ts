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
import { DineOrderingAgent, type MealSuggestion } from "@dine/ai";
import {
  registerRecommenderFlow,
  defaultRecSession,
  type RecSession
} from "./recommender-flow.js";


const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new Bot(token);

// User Session State
interface UserSession extends RecSession {
  step: "idle" | "awaiting_custom_budget" | "awaiting_hall" | "awaiting_room";
  budget: BudgetBracket | number;
  budgetLabel: string;
  craving?: CravingType;
  rerollCount: number;
  activeRecs: Recommendation[];
  // Delivery details — collected once per user, persisted in session
  hall?: string;
  room?: string;
}

const userSessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      ...defaultRecSession(),
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
// 1. Interactive Decision Engine (New Recommend System)
// ----------------------------------------------------

const recommender = registerRecommenderFlow(
  bot,
  (userId: number) => getSession(userId),
  async (ctx: any, suggestion: MealSuggestion) => {
    const userId = ctx.from.id;
    const tray = getTray(userId);

    // Add Prime items to tray
    for (const itm of suggestion.items) {
      tray.push({
        itemName: itm.name,
        vendorName: suggestion.vendorName || "Prime Vendor",
        price: itm.price || 0,
      });
    }

    const kb = new InlineKeyboard()
      .text("🛒 View Tray & Checkout", "action_view_tray")
      .text("✨ Pick Another Meal", "action_restart_decide");

    await ctx.reply(
      `🎉 <b>Added to your Tray!</b>\n\n` +
        `Added <b>${suggestion.name}</b> (${suggestion.vendorName}) — ₦${suggestion.totalPrice?.toLocaleString() ?? 0}.\n\n` +
        `Your tray now has <b>${tray.length} item(s)</b>.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  }
);

bot.hears("✨ Decide For Me 🍽️", recommender.startRecommenderFlow);
bot.command("decide", recommender.startRecommenderFlow);
bot.callbackQuery("action_restart_decide", recommender.startRecommenderFlow);



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

// Known halls at Covenant University for quick-pick keyboard
const KNOWN_HALLS = [
  "Paul Hall",
  "Juanita Hall",
  "Charles Hall",
  "Peter Hall",
  "Deborah Hall",
  "Faith Hall",
  "Lydia Hall",
  "Mary Hall",
  "Daniel Hall",
  "Joseph Hall",
];

/** Build the hall selection inline keyboard */
function buildHallKeyboard() {
  const kb = new InlineKeyboard();
  KNOWN_HALLS.forEach((hall, i) => {
    kb.text(hall, `hall:${hall}`);
    if (i % 2 === 1) kb.row(); // 2 per row
  });
  kb.row().text("✏️ Type My Hall Name", "hall:custom");
  return kb;
}

// ── Confirm & Order ──────────────────────────────────────────────────────────

bot.callbackQuery("action_confirm_order", async (ctx) => {
  const userId = ctx.from.id;
  const tray = getTray(userId);

  if (tray.length === 0) {
    await ctx.answerCallbackQuery({ text: "Your tray is empty." });
    return;
  }

  await ctx.answerCallbackQuery();
  const session = getSession(userId);

  // If we don't have delivery details yet, collect them first
  if (!session.hall) {
    session.step = "awaiting_hall";
    await ctx.reply(
      "🏠 *Where should we deliver your order?*\n\n" +
        "Pick your hall below or type it manually:",
      { reply_markup: buildHallKeyboard(), parse_mode: "Markdown" }
    );
    return;
  }

  if (!session.room) {
    session.step = "awaiting_room";
    await ctx.reply(
      `🏠 Hall: *${session.hall}*\n\n` +
        "🚪 What's your *room number*? (e.g. `D208`)\n\n" +
        "_Type it below and we'll place your order right after._",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Hall & room are set — place the order
  await runOrderPlacement(ctx, userId);
});

// Hall picked from inline keyboard
bot.callbackQuery(/^hall:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const picked = ctx.match[1];

  await ctx.answerCallbackQuery();

  if (picked === "custom") {
    session.step = "awaiting_hall";
    await ctx.editMessageText(
      "✏️ *Type your hall name below:*\n_(e.g. Paul Hall, Juanita Hall)_",
      { parse_mode: "Markdown" }
    );
    return;
  }

  session.hall = picked;
  session.step = "awaiting_room";

  await ctx.editMessageText(
    `✅ Hall set to *${picked}*\n\n` +
      "🚪 Now type your *room number* (e.g. `D208`):",
    { parse_mode: "Markdown" }
  );
});

// ── The actual order runner (called once hall + room are known) ──────────────

async function runOrderPlacement(ctx: any, userId: number) {
  const tray = getTray(userId);
  const session = getSession(userId);
  const total = tray.reduce((sum, item) => sum + item.price, 0);

  if (!orderingAgent.isConfigured()) {
    await ctx.reply(
      `✅ *Order Recorded!*\n\n` +
        `Items: *${tray.length}* · Total: *₦${total.toLocaleString()}*\n` +
        `Hall: *${session.hall}* · Room: *${session.room}*\n\n` +
        `⚙️ _Autonomous ordering is not yet activated on this deployment._`,
      { reply_markup: mainKeyboard, parse_mode: "Markdown" }
    );
    return;
  }

  const processingMsg = await ctx.reply(
    `⏳ *Placing your order on Prime...*\n\n` +
      `📦 *${tray.length} item(s)* · ₦${total.toLocaleString()}\n` +
      `📍 *${session.hall}*, Room *${session.room}*\n\n` +
      `_This usually takes 10–20 seconds. Hang tight!_`,
    { parse_mode: "Markdown" }
  );

  const results: string[] = [];
  const paystackLinks: string[] = [];

  for (let i = 0; i < tray.length; i++) {
    const item = tray[i];
    const label = `#${i + 1} ${item.itemName} (${item.vendorName})`;

    try {
      const result = await orderingAgent.placeOrder({
        vendorName: item.vendorName,
        itemName: item.itemName,
        hall: session.hall,
        room: session.room,
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

  // Clear tray after attempt
  userTrays.set(userId, []);

  let summary = `🎉 *Order Summary*\n`;
  summary += `📍 *${session.hall}*, Room *${session.room}*\n\n`;
  summary += results.join("\n") + "\n\n";
  summary += `💵 *Total: ₦${total.toLocaleString()}*\n\n`;

  if (paystackLinks.length > 0) {
    summary += `*Payment Links:*\n${paystackLinks.join("\n")}\n\n`;
    summary += `_Tap a link above to complete payment._`;
  } else {
    summary += `_Check server logs — Prime's bot may have a different checkout flow._`;
  }

  try {
    await ctx.api.editMessageText(ctx.chat!.id, processingMsg.message_id, summary, {
      parse_mode: "Markdown",
    });
  } catch {
    // ignore edit failure
  }

  await ctx.reply("👆 Order complete! What's next?", {
    reply_markup: mainKeyboard,
    parse_mode: "Markdown",
  });
}

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
// 5. Intelligent Message Handler (Typed Budgets, Delivery Details & Natural Chat)
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

  // ── Delivery: awaiting hall name (typed manually) ──────────────────────────
  if (session.step === "awaiting_hall") {
    session.hall = text;
    session.step = "awaiting_room";
    await ctx.reply(
      `✅ Hall set to *${text}*\n\n` +
        "🚪 Now type your *room number* (e.g. `D208`):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Delivery: awaiting room number ─────────────────────────────────────────
  if (session.step === "awaiting_room") {
    session.room = text.toUpperCase();
    session.step = "idle";

    await ctx.reply(
      `✅ Room set to *${session.room}*\n\n` +
        `📍 Delivering to: *${session.hall}*, Room *${session.room}*\n\n` +
        `_Placing your order now..._`,
      { parse_mode: "Markdown" }
    );

    await runOrderPlacement(ctx, userId);
    return;
  }

  // ── Handled by recommender flow (note or custom typed budget) ───────────
  const handledByRecommender = await recommender.handleText(ctx);
  if (handledByRecommender) {
    return;
  }

});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();
console.log("Dine Telegram bot is running with custom typed budget and fixed decision engine!");
