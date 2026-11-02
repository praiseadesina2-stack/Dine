import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface OrderTarget {
  botUsername?: string; // defaults to process.env.PRIME_BOT_USERNAME || "orderfromprimebot"
  vendorName: string;   // e.g. "Delish Yamarita"
  itemName: string;     // e.g. "Delish Pack + 1 Kebab"
  hall?: string;
  room?: string;
}

export interface AgentOrderResult {
  success: boolean;
  message: string;
  paystackUrl?: string;
  rawResponse?: string;
  stepsCompleted: string[];
}

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

  /**
   * Helper to wait for the latest incoming message from the target bot
   */
  private async getLatestBotMessage(botEntity: any, waitSeconds = 5): Promise<any> {
    const client = await this.getClient();
    for (let i = 0; i < waitSeconds * 2; i++) {
      const messages = await client.getMessages(botEntity, { limit: 1 });
      if (messages.length > 0 && !messages[0].out) {
        return messages[0];
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const fallback = await client.getMessages(botEntity, { limit: 1 });
    return fallback[0] || null;
  }

  /**
   * Helper to click an inline or keyboard button matching a name
   */
  private async clickButtonByText(message: any, targetText: string): Promise<boolean> {
    if (!message || !message.replyMarkup) return false;

    const rows = (message.replyMarkup as any).rows || [];
    for (let r = 0; r < rows.length; r++) {
      const buttons = rows[r].buttons || [];
      for (let b = 0; b < buttons.length; b++) {
        const btn = buttons[b];
        const btnText = (btn.text || "").trim().toLowerCase();
        const search = targetText.trim().toLowerCase();

        if (btnText.includes(search) || search.includes(btnText)) {
          try {
            await message.click(b, r);
            return true;
          } catch (e) {
            console.warn(`Click failed on [${btn.text}]:`, e);
          }
        }
      }
    }
    return false;
  }

  /**
   * Autonomous Order Placement on Prime's Bot
   */
  public async placeOrder(target: OrderTarget): Promise<AgentOrderResult> {
    const stepsCompleted: string[] = [];
    const client = await this.getClient();

    try {
      const botUsername = (target.botUsername || process.env.PRIME_BOT_USERNAME || "orderfromprimebot").replace(/^@/, "");
      console.log(`🤖 Dine Agent starting order on @${botUsername} for "${target.vendorName} -> ${target.itemName}"...`);

      const botEntity = await client.getEntity(botUsername);
      stepsCompleted.push(`Connected to @${botUsername}`);

      // Step 1: Initialize conversation
      await client.sendMessage(botEntity, { message: "/start" });
      await new Promise((r) => setTimeout(r, 2000));
      stepsCompleted.push("Sent /start");

      let msg = await this.getLatestBotMessage(botEntity);

      // Step 2: Open vendor catalog (Click "See all vendors" or "I'm Hungry")
      const openedCatalog = await this.clickButtonByText(msg, "See all vendors") ||
                            await this.clickButtonByText(msg, "Hungry");

      if (openedCatalog) {
        stepsCompleted.push("Clicked 'See all vendors'");
        await new Promise((r) => setTimeout(r, 2500));
        msg = await this.getLatestBotMessage(botEntity);
      }

      // Step 3: Find and Click Vendor (e.g. "Delish Yamarita")
      let vendorFound = false;
      for (let page = 1; page <= 4; page++) {
        vendorFound = await this.clickButtonByText(msg, target.vendorName);
        if (vendorFound) {
          stepsCompleted.push(`Selected vendor '${target.vendorName}' (Page ${page})`);
          await new Promise((r) => setTimeout(r, 2500));
          msg = await this.getLatestBotMessage(botEntity);
          break;
        }

        // Try next page if vendor not on current page
        const clickedNext = await this.clickButtonByText(msg, "Next");
        if (clickedNext) {
          stepsCompleted.push(`Advanced to catalog page ${page + 1}`);
          await new Promise((r) => setTimeout(r, 2000));
          msg = await this.getLatestBotMessage(botEntity);
        } else {
          break;
        }
      }

      if (!vendorFound) {
        return {
          success: false,
          message: `Vendor '${target.vendorName}' was not found in Prime's active directory.`,
          stepsCompleted,
          rawResponse: msg?.text
        };
      }

      // Step 4: Click Meal Item (or "Order now")
      const clickedItem = await this.clickButtonByText(msg, target.itemName) ||
                          await this.clickButtonByText(msg, "Order now");

      if (clickedItem) {
        stepsCompleted.push(`Selected meal item '${target.itemName}'`);
        await new Promise((r) => setTimeout(r, 2500));
        msg = await this.getLatestBotMessage(botEntity);
      }

      // Step 5: Check for Paystack URL in message or buttons
      const paystackUrl = this.extractPaystackUrl(msg);

      if (paystackUrl) {
        stepsCompleted.push("Acquired Paystack Checkout URL");
        return {
          success: true,
          message: "Order placed successfully! Ready for payment.",
          paystackUrl,
          stepsCompleted,
          rawResponse: msg?.text
        };
      }

      return {
        success: true,
        message: "Order flow completed to current checkout step.",
        stepsCompleted,
        rawResponse: msg?.text
      };
    } catch (err: any) {
      console.error("Agent order automation error:", err);
      return {
        success: false,
        message: `Agent encountered an error: ${err?.message || err}`,
        stepsCompleted
      };
    }
  }

  private extractPaystackUrl(message: any): string | undefined {
    if (!message) return undefined;

    const text = message.text || "";
    const match = text.match(/https?:\/\/(?:checkout\.)?paystack\.(?:com|co)\/[^\s]+/i);
    if (match) {
      return match[0];
    }

    if (message.replyMarkup && message.replyMarkup.rows) {
      for (const row of message.replyMarkup.rows) {
        for (const btn of row.buttons || []) {
          if (btn.url && btn.url.includes("paystack")) {
            return btn.url;
          }
        }
      }
    }

    return undefined;
  }
}
