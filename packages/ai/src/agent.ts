/**
 * Dine ordering agent (contracts/ordering.md): places an order on Prime's Telegram
 * bot for a student, through a Dine-owned Telegram session. Code, not a model.
 *
 * The backend calls placeOrder() only after the policy check allowed the order and
 * the student's wallet amount is reserved. The flow itself lives in
 * order/prime-flow.ts (exact button matching, price check, fail closed); this file
 * is the Telegram driver plus a lock so one session runs one order at a time.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import {
  runOrderFlow,
  type BotButton, type BotScreen, type OrderFailure, type OrderStage, type OrderTarget as FlowTarget, type PrimeBot,
} from "./order/prime-flow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface OrderTarget extends FlowTarget {
  botUsername?: string; // defaults to process.env.PRIME_BOT_USERNAME || "orderfromprimebot"
}

export interface AgentOrderResult {
  /** True only when Prime gave a payment link or confirmed the order. */
  success: boolean;
  message: string;
  /** Set when success is false. */
  code?: OrderFailure;
  /** How far the order got. */
  stage: OrderStage;
  /** True once "Add to cart" was pressed: the Prime cart may hold this item and must be cleared before a retry. */
  cartTouched: boolean;
  /** Prime's total (item plus packs) in kobo, once the item screen was read. */
  totalKobo?: number;
  paystackUrl?: string;
  orderRef?: string;
  stepsCompleted: string[];
}

/** How long to wait for Prime to answer one message or button press. */
const REPLY_TIMEOUT_MS = 12_000;
const POLL_MS = 400;

/** One order at a time per Telegram session: concurrent orders would read each other's bot replies. */
const sessionLocks = new Map<string, Promise<unknown>>();

export class DineOrderingAgent {
  private client: TelegramClient | null = null;
  private apiId: number;
  private apiHash: string;
  private sessionString: string;

  constructor() {
    this.apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
    this.apiHash = process.env.TELEGRAM_API_HASH || "";
    this.sessionString = process.env.TELEGRAM_STRING_SESSION || "";
  }

  public isConfigured(): boolean {
    return Boolean(this.apiId && this.apiHash && this.sessionString);
  }

  public async getClient(): Promise<TelegramClient> {
    if (this.client && this.client.connected) {
      return this.client;
    }

    if (!this.isConfigured()) {
      throw new Error(
        "DineOrderingAgent is missing credentials. Please set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_STRING_SESSION in .env"
      );
    }

    const session = new StringSession(this.sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    await this.client.connect();
    return this.client;
  }

  /** Places one order on Prime. Queues behind any order already running on this session. */
  public async placeOrder(target: OrderTarget): Promise<AgentOrderResult> {
    const key = this.sessionString || "default";
    const previous = sessionLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.placeOrderNow(target));
    sessionLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (sessionLocks.get(key) === run) sessionLocks.delete(key);
    }
  }

  private async placeOrderNow(target: OrderTarget): Promise<AgentOrderResult> {
    let bot: PrimeBot;
    try {
      const client = await this.getClient();
      const username = (target.botUsername || process.env.PRIME_BOT_USERNAME || "orderfromprimebot").replace(/^@/, "");
      bot = new TelegramPrimeBot(client, await client.getEntity(username));
    } catch (err: any) {
      return { success: false, code: "BOT_ERROR", stage: "start", cartTouched: false, message: `Could not reach Prime: ${err?.message ?? err}`, stepsCompleted: [] };
    }

    const r = await runOrderFlow(bot, target);
    if (r.ok) {
      return {
        success: true,
        stage: "done",
        cartTouched: true,
        message: r.paystackUrl ? "Order placed on Prime; checkout link ready." : "Order placed on Prime.",
        totalKobo: r.totalKobo,
        paystackUrl: r.paystackUrl,
        orderRef: r.orderRef,
        stepsCompleted: r.steps,
      };
    }
    return {
      success: false,
      code: r.code,
      stage: r.stage,
      cartTouched: r.cartTouched,
      message: r.detail,
      totalKobo: r.totalKobo,
      stepsCompleted: r.steps,
    };
  }
}

/**
 * PrimeBot over GramJS. Prime either edits its message in place or sends a new one,
 * so a reply is "the latest incoming message, once it differs from what we had".
 */
class TelegramPrimeBot implements PrimeBot {
  private messages = new WeakMap<BotScreen, any>();

  constructor(private client: TelegramClient, private bot: any) {}

  async start(): Promise<BotScreen> {
    const before = await this.latestKey();
    await this.client.sendMessage(this.bot, { message: "/start" });
    return this.waitForReply(before);
  }

  async click(screen: BotScreen, button: BotButton): Promise<BotScreen> {
    const message = this.messages.get(screen);
    if (!message) throw new Error("screen has no Telegram message");
    const before = await this.latestKey();
    await message.click({ i: button.row, j: button.col });
    return this.waitForReply(before);
  }

  private async latest(): Promise<any | null> {
    const [m] = await this.client.getMessages(this.bot, { limit: 1 });
    return m && !m.out ? m : null;
  }

  private key(m: any): string {
    return m ? `${m.id}:${m.editDate ?? 0}:${m.message ?? ""}` : "";
  }

  private async latestKey(): Promise<string> {
    return this.key(await this.latest());
  }

  private async waitForReply(beforeKey: string): Promise<BotScreen> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const m = await this.latest();
      if (m && this.key(m) !== beforeKey) {
        // Give Prime a moment to finish editing a multi-step update, then take the settled message.
        await new Promise((r) => setTimeout(r, POLL_MS));
        const settled = (await this.latest()) ?? m;
        return this.toScreen(settled);
      }
    }
    throw new Error("Prime did not reply in time");
  }

  private toScreen(m: any): BotScreen {
    const buttons: BotButton[] = [];
    (m.replyMarkup?.rows ?? []).forEach((row: any, r: number) =>
      (row.buttons ?? []).forEach((btn: any, c: number) => buttons.push({ row: r, col: c, label: String(btn.text ?? ""), ...(btn.url ? { url: btn.url } : {}) })),
    );
    const screen: BotScreen = { text: String(m.message ?? ""), buttons };
    this.messages.set(screen, m);
    return screen;
  }
}
