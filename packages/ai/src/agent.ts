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
  runCartOrder,
  type BotButton, type BotScreen, type CartLine, type OrderFailure, type OrderFlowResult, type OrderStage, type OrderTarget as FlowTarget, type PayWith, type PrimeBot, type VerifiedLine,
} from "./order/prime-flow.js";
import { judgeTopUp, readPrimeWallet, type FundingAccount, type PaymentEvidence, type PrimeWallet, type TopUpCheck } from "./order/prime-wallet.js";
import type { BankTransfer } from "./order/prime-transfer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface OrderTarget extends FlowTarget {
  botUsername?: string; // defaults to process.env.PRIME_BOT_USERNAME || "orderfromprimebot"
  /** Ignored: Prime delivers to the Dine account's profile (ordering.md guarantee 9). Kept so older callers compile. */
  hall?: string;
  /** Ignored, as `hall`. */
  room?: string;
}

/** Older shape of Prime's transfer details (amount in naira). Prefer `transfer` + payPrimeTransfer(). */
export interface BankPaymentDetails {
  accountNumber: string;
  bankName: string;
  accountName: string;
  amount: number;
}

/** PRIME_PAY_MODE: "wallet" (Prime wallet float) or "transfer" (bank transfer per order, the default). */
function payModeFromEnv(): PayWith {
  return process.env.PRIME_PAY_MODE === "wallet" ? "wallet" : "transfer";
}

export interface AgentOrderResult {
  /** True only when Prime gave a payment link or confirmed the order. */
  success: boolean;
  message: string;
  /** Set when success is false. */
  code?: OrderFailure;
  /** How far the order got. */
  stage: OrderStage;
  /** True once "Add to cart" was pressed: the Prime cart may hold items and must be cleared before a retry. */
  cartTouched: boolean;
  /** Prime's total for the whole tray in kobo (items × qty plus packs). This is what Dine pays: reserve against it. */
  totalKobo?: number;
  /** Success only: every line as Prime showed it when added. */
  lines?: VerifiedLine[];
  /** Failure only: the tray line the order stopped on, when it stopped on one. */
  item?: { vendorName: string; itemName: string };
  paystackUrl?: string;
  orderRef?: string;
  /**
   * Proof of payment from the Prime wallet balance (set once checkout was pressed).
   * Capture the student's reservation only on status "verified"; on "uncertain",
   * reconcile before any retry; on "not_paid", release it.
   */
  payment?: PaymentEvidence;
  /**
   * Prime asked for a bank transfer of exactly totalKobo (payment.status "awaiting_transfer").
   * Pay it with payPrimeTransfer({ kora, transfer, totalKobo, reference }); never directly.
   */
  transfer?: BankTransfer;
  /** Same as `transfer`, in the older naira shape. */
  bankPaymentDetails?: BankPaymentDetails;
  /** VENDOR_NOT_FOUND / ITEM_NOT_FOUND: similar names on Prime, for "Did you mean…?". Never ordered automatically. */
  suggestions?: string[];
  /** PRIME_WALLET_LOW only: top the Prime wallet up by at least shortfallKobo, then retry. */
  topUp?: { shortfallKobo: number; balanceKobo: number; fundingAccount?: FundingAccount };
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

  /** Places one item on Prime. Same as placeTrayOrder with a one-line tray. */
  public async placeOrder(target: OrderTarget): Promise<AgentOrderResult> {
    const { botUsername, hall: _hall, room: _room, ...line } = target;
    return this.placeTrayOrder([line], botUsername);
  }

  /**
   * Orders a whole tray from Prime: every line (any vendors) in ONE Prime cart, ONE
   * checkout. Every item is checked before anything goes in the cart. Queues behind any
   * order already running on this session. Build `lines` with trayToCartLines().
   * Payment follows PRIME_PAY_MODE unless `payWith` is given: "transfer" returns
   * `transfer` for payPrimeTransfer(); "wallet" pays from the Prime wallet float.
   */
  public async placeTrayOrder(lines: CartLine[], botUsername?: string, opts: { payWith?: PayWith } = {}): Promise<AgentOrderResult> {
    const payWith = opts.payWith ?? payModeFromEnv();
    return this.withSession(() => this.placeTrayOrderNow(lines, botUsername, payWith));
  }

  /**
   * Reads the Dine account's Prime wallet: balance and the bank account that funds it.
   * The backend uses it for the float check and before a top-up.
   */
  public async readPrimeWallet(botUsername?: string): Promise<PrimeWallet> {
    return this.withSession(async () => readPrimeWallet(await this.primeBot(botUsername)));
  }

  /**
   * After a Kora payout to the Prime funding account: has it reached the Prime wallet?
   * Polls until the balance rose by at least amountKobo over previousBalanceKobo, or the
   * time runs out. "not_yet" never means pay again: reconcile the payout with Kora first.
   */
  public async checkTopUp(args: { previousBalanceKobo: number; amountKobo: number; timeoutMs?: number; pollMs?: number; botUsername?: string }): Promise<TopUpCheck> {
    const pollMs = args.pollMs ?? 10_000;
    const deadline = Date.now() + (args.timeoutMs ?? 60_000);
    while (true) {
      const check = judgeTopUp(args.previousBalanceKobo, await this.readPrimeWallet(args.botUsername), args.amountKobo);
      if (check.status === "landed" || Date.now() + pollMs > deadline) return check;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** One Prime conversation at a time per Telegram session. */
  private async withSession<T>(work: () => Promise<T>): Promise<T> {
    const key = this.sessionString || "default";
    const previous = sessionLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    sessionLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (sessionLocks.get(key) === run) sessionLocks.delete(key);
    }
  }

  private async primeBot(botUsername?: string): Promise<PrimeBot> {
    const client = await this.getClient();
    const username = (botUsername || process.env.PRIME_BOT_USERNAME || "orderfromprimebot").replace(/^@/, "");
    return new TelegramPrimeBot(client, await client.getEntity(username));
  }

  private async placeTrayOrderNow(lines: CartLine[], botUsername: string | undefined, payWith: PayWith): Promise<AgentOrderResult> {
    let bot: PrimeBot;
    try {
      bot = await this.primeBot(botUsername);
    } catch (err: any) {
      return { success: false, code: "BOT_ERROR", stage: "start", cartTouched: false, message: `Could not reach Prime: ${err?.message ?? err}`, stepsCompleted: [] };
    }
    return toAgentResult(await runCartOrder(bot, lines, { payWith }));
  }
}

/** The flow's result in the shape the backend reads. */
export function toAgentResult(r: OrderFlowResult): AgentOrderResult {
  if (r.ok) {
    return {
      success: true,
      stage: "done",
      cartTouched: true,
      message:
        r.payment.status === "verified" ? "Order placed on Prime and paid from the Prime wallet."
        : r.payment.status === "awaiting_transfer" ? "Order placed on Prime; waiting for the bank transfer."
        : r.payment.status === "uncertain" ? "Order placed on Prime; payment is uncertain, reconcile before any retry."
        : r.paystackUrl ? "Order placed on Prime; not paid yet, Prime returned a checkout link."
        : "Order placed on Prime; not paid yet.",
      totalKobo: r.totalKobo,
      lines: r.lines,
      paystackUrl: r.paystackUrl,
      orderRef: r.orderRef,
      payment: r.payment,
      ...(r.transfer
        ? {
            transfer: r.transfer,
            bankPaymentDetails: { accountNumber: r.transfer.accountNumber, bankName: r.transfer.bankName, accountName: r.transfer.accountName ?? "", amount: r.transfer.amountKobo / 100 },
          }
        : {}),
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
    ...(r.item ? { item: r.item } : {}),
    ...(r.payment ? { payment: r.payment } : {}),
    ...(r.suggestions ? { suggestions: r.suggestions } : {}),
    ...(r.topUp ? { topUp: r.topUp } : {}),
    stepsCompleted: r.steps,
  };
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
