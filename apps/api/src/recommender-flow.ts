/**
 * Recommender flow for the Dine Telegram bot.
 *
 * This module wires the multi-step "Decide For Me" questionnaire into the
 * new recommend() function from @dine/ai. It owns all callback handlers
 * whose IDs start with  rec:  and exports registerRecommenderFlow() which
 * the main index.ts must call once after the bot is created.
 *
 * Session state added:
 *   recStep   – which question the user is currently answering
 *   recMode   – "now" | "timetable"
 *   recDays   – Day[] for timetable
 *   recMealsPerDay – 1 | 2 | 3
 *   recGoals  – Goal[]
 *   recCravings – Craving[]
 *   recBudget – number (₦ per meal)
 *   recNote   – string | undefined
 *   recShownKeys – keys already shown (for rerolls)
 *   recRerollCount – reroll seed
 *   recLastResult – the last RecommendResult (for order callbacks)
 */

import { Bot, InlineKeyboard } from "grammy";
import {
  recommend,
  GOALS,
  CRAVINGS,
  DAYS,
  type RecommendRequest,
  type RecommendResult,
  type MealSuggestion,
  type Day,
  type Goal,
  type Craving,
} from "@dine/ai";


// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecSession {
  recStep:
    | "idle"
    | "mode"
    | "days"
    | "mealsPerDay"
    | "goals"
    | "cravings"
    | "budget"
    | "note"
    | "results";
  recMode: "now" | "timetable";
  recDays: Day[];
  recMealsPerDay: 1 | 2 | 3;
  recGoals: Goal[];
  recCravings: Craving[];
  recBudget: number;
  recNote?: string;
  recShownKeys: string[];
  recRerollCount: number;
  recLastResult?: RecommendResult;
  // multi-select tracking (goals / cravings / days)
  recDaysSelected: Day[];
  recGoalsSelected: Goal[];
  recCravingsSelected: Craving[];
}

export function defaultRecSession(): RecSession {
  return {
    recStep: "idle",
    recMode: "now",
    recDays: [],
    recMealsPerDay: 3,
    recGoals: [],
    recCravings: [],
    recBudget: 2000,
    recNote: undefined,
    recShownKeys: [],
    recRerollCount: 0,
    recLastResult: undefined,
    recDaysSelected: [],
    recGoalsSelected: [],
    recCravingsSelected: [],
  };
}

// ─── Budget presets ───────────────────────────────────────────────────────────

const BUDGET_PRESETS: { label: string; value: number }[] = [
  { label: "Under ₦1,000", value: 1000 },
  { label: "₦1,500", value: 1500 },
  { label: "₦2,000", value: 2000 },
  { label: "₦3,000", value: 3000 },
  { label: "₦5,000", value: 5000 },
];

// ─── Goal / craving display labels ───────────────────────────────────────────

const GOAL_LABELS: Record<Goal, string> = {
  protein_rich: "High Protein 💪",
  high_fibre: "More Fibre 🥦",
  healthy: "Healthy 🥗",
  light: "Light / Weight Loss 🏃",
  bulk: "Bulking / Big Appetite 🍖",
};

const CRAVING_LABELS: Record<Craving, string> = {
  sweet: "Something Sweet 🍰",
  filling: "Heavy & Filling 🍛",
  spicy: "Spicy 🌶️",
  savoury: "Savoury 🧂",
  snack: "Just a Snack 🥪",
  surprise: "Surprise Me 🎲",
};

const DAY_LABELS: Record<Day, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function allKeys(result: RecommendResult): string[] {
  if (result.mode === "now") return result.options.map((o) => o.key);
  return result.days.flatMap((d) =>
    d.meals.flatMap((m) => [m.pick?.key, ...m.alternatives.map((a) => a.key)].filter(Boolean) as string[])
  );
}

// ─── Step renders ────────────────────────────────────────────────────────────

function renderModeStep() {
  const kb = new InlineKeyboard()
    .text("🕐 Eat Now", "rec:mode:now")
    .text("📅 Plan a Timetable", "rec:mode:timetable");

  return {
    text:
      "✨ <b>Dine – Decide For Me</b>\n\n" +
      "Let's find the perfect meal(s) for you.\n\n" +
      "🕐 <b>Are you eating now, or planning a weekly timetable?</b>",
    kb,
  };
}

function renderDaysStep(selected: Day[]) {
  const kb = new InlineKeyboard();
  DAYS.forEach((d, i) => {
    const checked = selected.includes(d) ? "✅ " : "";
    kb.text(`${checked}${DAY_LABELS[d]}`, `rec:day:${d}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row().text("✅ Done →", "rec:days:done");
  return {
    text:
      `📅 <b>Which days do you want to plan?</b>\n\n` +
      `<i>Tap to select (multi-select). ${selected.length} selected so far.</i>`,
    kb,
  };
}

function renderMealsPerDayStep() {
  const kb = new InlineKeyboard()
    .text("1 meal (dinner)", "rec:mpd:1")
    .row()
    .text("2 meals (lunch + dinner)", "rec:mpd:2")
    .row()
    .text("3 meals (breakfast + lunch + dinner)", "rec:mpd:3");
  return {
    text: "🍽️ <b>How many meals per day?</b>",
    kb,
  };
}

function renderGoalsStep(selected: Goal[]) {
  const kb = new InlineKeyboard();
  GOALS.forEach((g, i) => {
    const checked = selected.includes(g) ? "✅ " : "";
    kb.text(`${checked}${GOAL_LABELS[g]}`, `rec:goal:${g}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row()
    .text("⏭️ Skip (no goal)", "rec:goals:done")
    .text("✅ Done →", "rec:goals:done");
  return {
    text:
      "🏋️ <b>Any diet or gym goals?</b>\n\n" +
      "<i>Tap to select (multi-select). Tap Done when ready, or skip.</i>",
    kb,
  };
}

function renderCravingsStep(selected: Craving[]) {
  const kb = new InlineKeyboard();
  CRAVINGS.forEach((c, i) => {
    const checked = selected.includes(c) ? "✅ " : "";
    kb.text(`${checked}${CRAVING_LABELS[c]}`, `rec:craving:${c}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row()
    .text("⏭️ Skip", "rec:cravings:done")
    .text("✅ Done →", "rec:cravings:done");
  return {
    text:
      "😋 <b>What are you craving?</b>\n\n" +
      "<i>Tap to select (multi-select). Tap Done when ready, or skip.</i>",
    kb,
  };
}

function renderBudgetStep() {
  const kb = new InlineKeyboard();
  BUDGET_PRESETS.forEach((p, i) => {
    kb.text(p.label, `rec:budget:${p.value}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("✏️ Type a custom amount", "rec:budget:custom");
  return {
    text: "💰 <b>What's your budget per meal?</b>",
    kb,
  };
}

function renderNoteStep() {
  const kb = new InlineKeyboard().text("⏭️ Skip", "rec:note:skip");
  return {
    text:
      "📝 <b>Anything else?</b>\n\n" +
      "Type allergies, dislikes, or requests (e.g. <i>\"allergic to groundnut, no amala\"</i>).\n\n" +
      "<i>Or tap Skip to get your picks now.</i>",
    kb,
  };
}

// ─── Result formatter ─────────────────────────────────────────────────────────

function formatSuggestion(s: MealSuggestion, pos: number): string {
  let text = `<b>${pos}. ${esc(s.name)}</b>\n`;
  if (s.orderable) {
    text += `🛍️ Order on Dine · ${esc(s.vendorName!)} · ₦${s.totalPrice!.toLocaleString()}\n`;
  }
  if (s.reasons.length) text += `💡 ${s.reasons.slice(0, 2).map(esc).join(" · ")}\n`;
  if (s.warnings.length) text += `⚠️ ${s.warnings.slice(0, 1).map(esc).join(", ")}\n`;
  return text;
}

function buildEatNowResultMessage(result: Extract<RecommendResult, { mode: "now" }>, budget: number): string {
  const slot = ["breakfast", "lunch", "dinner"].find((s) =>
    result.options.some(() => true)
  );
  let msg = `🍽️ <b>Here are your picks</b> (₦${budget.toLocaleString()} per meal):\n\n`;
  result.options.forEach((s, i) => {
    msg += formatSuggestion(s, i + 1) + "\n";
  });
  if (result.notices.length) {
    msg += `<i>${result.notices.map(esc).join(" · ")}</i>`;
  }
  return msg;
}

function buildEatNowResultKeyboard(result: Extract<RecommendResult, { mode: "now" }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  result.options.forEach((s, i) => {
    if (s.orderable) {
      kb.row().text(`🛒 Order #${i + 1}: ${s.name.slice(0, 24)}`, `rec:order:${i}`);
    }
  });
  kb.row()
    .text("🎲 Show Me Others", "rec:reroll")
    .text("🔄 Start Over", "rec:restart");
  return kb;
}

function buildTimetableMessage(result: Extract<RecommendResult, { mode: "timetable" }>, budget: number): string {
  let msg = `📅 <b>Your Meal Timetable</b> (₦${budget.toLocaleString()}/meal):\n\n`;
  for (const dayPlan of result.days) {
    msg += `<b>── ${DAY_LABELS[dayPlan.day].toUpperCase()} ──</b>\n`;
    for (const meal of dayPlan.meals) {
      const slotLabel = meal.slot.charAt(0).toUpperCase() + meal.slot.slice(1);
      msg += `<b>${slotLabel}:</b> `;
      if (!meal.pick) {
        msg += `<i>Nothing fits your budget here.</i>\n`;
      } else {
        msg += `${esc(meal.pick.name)}\n`;
        if (meal.pick.orderable) msg += `  🛍️ Order on Dine · ₦${meal.pick.totalPrice!.toLocaleString()}\n`;
        if (meal.pick.reasons[0]) msg += `  💡 ${esc(meal.pick.reasons[0])}\n`;
      }
    }
    msg += "\n";
  }
  if (result.notices.length) {
    msg += `<i>${result.notices.map(esc).join(" · ")}</i>`;
  }
  return msg;
}

function buildTimetableKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎲 Regenerate", "rec:reroll")
    .text("🔄 Start Over", "rec:restart");
}

// ─── Core function that calls recommend() and shows results ───────────────────

async function runRecommend(ctx: any, recSess: RecSession) {
  await ctx.reply("🔍 <i>Finding meals…</i>", { parse_mode: "HTML" });

  const req: RecommendRequest = {
    mode: recSess.recMode,
    days: recSess.recMode === "timetable" ? (recSess.recDaysSelected.length ? recSess.recDaysSelected : ["mon"]) : undefined,
    mealsPerDay: recSess.recMealsPerDay,
    goals: recSess.recGoalsSelected,
    cravings: recSess.recCravingsSelected,
    budgetPerMeal: recSess.recBudget,
    note: recSess.recNote,
    excludeMealKeys: recSess.recShownKeys,
    seed: recSess.recRerollCount,
  };

  let result: RecommendResult;
  try {
    result = await recommend(req, { now: new Date() });
  } catch (err: any) {
    await ctx.reply(
      "😕 Something went wrong fetching meal recommendations.\n\n_Try again or change your preferences._",
      { parse_mode: "Markdown" }
    );
    console.error("[Recommender] Error:", err);
    return;
  }

  recSess.recLastResult = result;
  recSess.recShownKeys.push(...allKeys(result));
  recSess.recStep = "results";

  if (result.mode === "now") {
    if (result.options.length === 0) {
      await ctx.reply(
        "😕 No meals found for that combination. Try a bigger budget or different preferences.",
        {
          reply_markup: new InlineKeyboard()
            .text("🔄 Start Over", "rec:restart")
            .text("💰 Change Budget", "rec:restart"),
          parse_mode: "HTML",
        }
      );
      return;
    }
    await ctx.reply(buildEatNowResultMessage(result, recSess.recBudget), {
      parse_mode: "HTML",
      reply_markup: buildEatNowResultKeyboard(result),
    });
  } else {
    const msg = buildTimetableMessage(result, recSess.recBudget);
    // Split if too long for Telegram (4096 char limit)
    if (msg.length > 3800) {
      const days = result.days;
      for (const dayPlan of days) {
        const single: Extract<RecommendResult, { mode: "timetable" }> = {
          mode: "timetable",
          days: [dayPlan],
          notices: result.notices,
          note: result.note,
          menuAsOf: result.menuAsOf,
        };
        await ctx.reply(buildTimetableMessage(single, recSess.recBudget), { parse_mode: "HTML" });
      }
      await ctx.reply("That's your full timetable! 🎉", {
        reply_markup: buildTimetableKeyboard(),
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(msg, {
        parse_mode: "HTML",
        reply_markup: buildTimetableKeyboard(),
      });
    }
  }

  // Show note confirmation if note was understood
  const note = result.note;
  const filters: string[] = [];
  if (note.excludeAllergens.length) filters.push(`no ${note.excludeAllergens.join(", ")}`);
  if (note.excludeComponents.length) filters.push(`no ${note.excludeComponents.join(", ")}`);
  if (note.vegetarian) filters.push("vegetarian");
  if (note.noPork) filters.push("no pork");
  if (filters.length && note.parsedBy !== "none") {
    await ctx.reply(`<i>Got it: ${esc(filters.join(", "))}.</i>`, { parse_mode: "HTML" });
  }
}

// ─── Flow registration ────────────────────────────────────────────────────────

/**
 * Call this once after creating the grammY Bot, passing:
 *  - bot: the grammY Bot instance
 *  - getRecSession: a function that returns (or creates) a RecSession for a user ID
 *  - onOrderPrime: callback when user taps "Order on Dine" for a Prime meal suggestion
 */
export function registerRecommenderFlow(
  bot: Bot<any>,
  getRecSession: (userId: number) => RecSession,
  onOrderPrime: (ctx: any, suggestion: MealSuggestion) => Promise<void>
) {
  // ── Entry point (also called on restart) ─────────────────────────────────
  async function startRecommenderFlow(ctx: any) {
    const userId = ctx.from?.id ?? 0;
    const rs = getRecSession(userId);
    // Reset
    Object.assign(rs, defaultRecSession());
    rs.recStep = "mode";

    const { text, kb } = renderModeStep();
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
  }

  // Expose for external callers (hears, command)
  (bot as any).__startRecommenderFlow = startRecommenderFlow;

  // ── Mode ──────────────────────────────────────────────────────────────────
  bot.callbackQuery(/^rec:mode:(now|timetable)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recMode = ctx.match[1] as "now" | "timetable";

    if (rs.recMode === "timetable") {
      rs.recStep = "days";
      rs.recDaysSelected = [];
      const { text, kb } = renderDaysStep([]);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } else {
      rs.recStep = "goals";
      rs.recGoalsSelected = [];
      const { text, kb } = renderGoalsStep([]);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  // ── Days (multi-select) ───────────────────────────────────────────────────
  bot.callbackQuery(/^rec:day:(mon|tue|wed|thu|fri|sat|sun)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    const day = ctx.match[1] as Day;
    if (rs.recDaysSelected.includes(day)) {
      rs.recDaysSelected = rs.recDaysSelected.filter((d) => d !== day);
    } else {
      rs.recDaysSelected.push(day);
    }
    const { text, kb } = renderDaysStep(rs.recDaysSelected);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {}
  });

  bot.callbackQuery("rec:days:done", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    if (rs.recDaysSelected.length === 0) rs.recDaysSelected = ["mon"];
    rs.recDays = rs.recDaysSelected;
    rs.recStep = "mealsPerDay";
    const { text, kb } = renderMealsPerDayStep();
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── Meals per day ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^rec:mpd:(1|2|3)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recMealsPerDay = parseInt(ctx.match[1]) as 1 | 2 | 3;
    rs.recStep = "goals";
    rs.recGoalsSelected = [];
    const { text, kb } = renderGoalsStep([]);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── Goals (multi-select) ──────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^rec:goal:(${GOALS.join("|")})$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    const goal = ctx.match[1] as Goal;
    if (rs.recGoalsSelected.includes(goal)) {
      rs.recGoalsSelected = rs.recGoalsSelected.filter((g) => g !== goal);
    } else {
      rs.recGoalsSelected.push(goal);
    }
    const { text, kb } = renderGoalsStep(rs.recGoalsSelected);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {}
  });

  bot.callbackQuery("rec:goals:done", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recGoals = rs.recGoalsSelected;
    rs.recStep = "cravings";
    rs.recCravingsSelected = [];
    const { text, kb } = renderCravingsStep([]);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── Cravings (multi-select) ───────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^rec:craving:(${CRAVINGS.join("|")})$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    const craving = ctx.match[1] as Craving;
    if (rs.recCravingsSelected.includes(craving)) {
      rs.recCravingsSelected = rs.recCravingsSelected.filter((c) => c !== craving);
    } else {
      rs.recCravingsSelected.push(craving);
    }
    const { text, kb } = renderCravingsStep(rs.recCravingsSelected);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {}
  });

  bot.callbackQuery("rec:cravings:done", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recCravings = rs.recCravingsSelected;
    rs.recStep = "budget";
    const { text, kb } = renderBudgetStep();
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── Budget (preset) ───────────────────────────────────────────────────────
  bot.callbackQuery(/^rec:budget:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recBudget = parseInt(ctx.match[1]);
    rs.recStep = "note";
    const { text, kb } = renderNoteStep();
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // Custom budget — ask user to type it
  bot.callbackQuery("rec:budget:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recStep = "budget"; // stay on budget step, waiting for text
    await ctx.editMessageText(
      "✏️ <b>Type your budget per meal</b> (e.g. <code>2500</code> or <code>1.5k</code>):",
      { parse_mode: "HTML" }
    );
  });

  // ── Note ──────────────────────────────────────────────────────────────────
  bot.callbackQuery("rec:note:skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    rs.recNote = undefined;
    await runRecommend(ctx, rs);
  });

  // ── Reroll ────────────────────────────────────────────────────────────────
  bot.callbackQuery("rec:reroll", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "🎲 Finding new options…" });
    const rs = getRecSession(ctx.from.id);
    rs.recRerollCount += 1;
    await runRecommend(ctx, rs);
  });

  // ── Restart ───────────────────────────────────────────────────────────────
  bot.callbackQuery("rec:restart", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startRecommenderFlow(ctx);
  });

  // ── Order a Prime meal from results ───────────────────────────────────────
  bot.callbackQuery(/^rec:order:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rs = getRecSession(ctx.from.id);
    const idx = parseInt(ctx.match[1]);
    if (!rs.recLastResult || rs.recLastResult.mode !== "now") {
      await ctx.reply("Session expired. Please start over.", {
        reply_markup: new InlineKeyboard().text("🔄 Start Over", "rec:restart"),
      });
      return;
    }
    const suggestion = rs.recLastResult.options[idx];
    if (!suggestion || !suggestion.orderable) {
      await ctx.answerCallbackQuery({ text: "This meal can't be ordered through Dine." });
      return;
    }
    await onOrderPrime(ctx, suggestion);
  });

  // ── Text handler (for custom budget and note) ─────────────────────────────
  // This is a named function so the caller can register it in the message handler chain.
  return {
    startRecommenderFlow,
    handleText: async (ctx: any): Promise<boolean> => {
      const userId = ctx.from?.id;
      if (!userId) return false;
      const rs = getRecSession(userId);
      const text: string = ctx.message?.text?.trim() ?? "";

      if (rs.recStep === "budget") {
        // Try to parse as number
        const kMatch = text.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*k$/);
        let amount: number | null = null;
        if (kMatch) {
          amount = Math.round(parseFloat(kMatch[1]) * 1000);
        } else {
          const digits = text.replace(/[^\d]/g, "");
          if (digits.length) {
            const n = parseInt(digits, 10);
            if (n >= 100 && n <= 50000) amount = n;
          }
        }
        if (amount !== null) {
          rs.recBudget = amount;
          rs.recStep = "note";
          const { text: noteText, kb } = renderNoteStep();
          await ctx.reply(
            `💰 Budget set to ₦${amount.toLocaleString()}!\n\n${noteText}`,
            { parse_mode: "HTML", reply_markup: kb }
          );
          return true;
        }
        await ctx.reply("Please enter a valid amount (e.g. <code>2000</code> or <code>1.5k</code>).", {
          parse_mode: "HTML",
        });
        return true;
      }

      if (rs.recStep === "note") {
        rs.recNote = text.slice(0, 500);
        await runRecommend(ctx, rs);
        return true;
      }

      return false;
    },
  };
}

