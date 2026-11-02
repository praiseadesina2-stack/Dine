import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface OrderTarget {
  botUsername: string; // e.g. "PrimeOrdersBot"
  vendorName: string; // e.g. "Delish Yamarita"
  itemName: string;   // e.g. "Delish Pack + 2 Kebabs"
  hostel?: string;
  room?: string;
  phoneNumber?: string;
}

export interface AgentOrderResult {
  success: boolean;
  message: string;
  paystackUrl?: string;
  rawResponse?: string;
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
        "DineOrderingAgent is not fully configured. Please set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_STRING_SESSION in .env"
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
   * Helper to wait for the latest message from a bot
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
   * Automates ordering a meal by interacting with the target bot
   */
  public async placeOrder(target: OrderTarget): Promise<AgentOrderResult> {
    const client = await this.getClient();

    try {
      const botUsername = target.botUsername.replace(/^@/, "");
      console.log(`🤖 Agent initiating order with @${botUsername} for ${target.itemName}...`);

      const botEntity = await client.getEntity(botUsername);

      // Step 1: Send /start or /menu to initialize conversation
      await client.sendMessage(botEntity, { message: "/start" });
      await new Promise((r) => setTimeout(r, 1500));

      let lastMessage = await this.getLatestBotMessage(botEntity);

      // Step 2: Click the Vendor button (e.g. "Delish Yamarita" or "I'm Hungry 🍽️")
      if (lastMessage && lastMessage.replyMarkup) {
        const clickedHungry = await this.tryClickButton(lastMessage, ["Hungry", "Order", target.vendorName]);
        if (clickedHungry) {
          console.log(`✅ Agent clicked vendor/menu trigger.`);
          await new Promise((r) => setTimeout(r, 1500));
          lastMessage = await this.getLatestBotMessage(botEntity);
        }
      }

      // Step 3: Click the target vendor if not yet opened
      if (lastMessage && lastMessage.replyMarkup) {
        const clickedVendor = await this.tryClickButton(lastMessage, [target.vendorName]);
        if (clickedVendor) {
          console.log(`✅ Agent selected vendor: ${target.vendorName}`);
          await new Promise((r) => setTimeout(r, 1500));
          lastMessage = await this.getLatestBotMessage(botEntity);
        }
      }

      // Step 4: Click the specific meal item button
      if (lastMessage && lastMessage.replyMarkup) {
        const clickedItem = await this.tryClickButton(lastMessage, [target.itemName]);
        if (clickedItem) {
          console.log(`✅ Agent selected meal item: ${target.itemName}`);
          await new Promise((r) => setTimeout(r, 1500));
          lastMessage = await this.getLatestBotMessage(botEntity);
        }
      }

      // Step 5: Check messages and buttons for Paystack URL
      const paystackUrl = this.extractPaystackUrl(lastMessage);

      if (paystackUrl) {
        console.log(`🎯 Paystack checkout URL captured: ${paystackUrl}`);
        return {
          success: true,
          message: `Order initialized! Paystack checkout URL acquired.`,
          paystackUrl,
          rawResponse: lastMessage?.text
        };
      }

      return {
        success: true,
        message: `Order flow progressed. Ready for payment step.`,
        rawResponse: lastMessage?.text
      };
    } catch (err: any) {
      console.error("Agent order automation error:", err);
      return {
        success: false,
        message: `Agent failed to automate order: ${err?.message || err}`
      };
    }
  }

  /**
   * Helper to search for and click a button by matching label text
   */
  private async tryClickButton(message: any, searchTerms: string[]): Promise<boolean> {
    if (!message || !message.replyMarkup) return false;

    try {
      const rows = message.replyMarkup.rows || [];
      for (let r = 0; r < rows.length; r++) {
        const buttons = rows[r].buttons || [];
        for (let b = 0; b < buttons.length; b++) {
          const btn = buttons[b];
          const btnText = btn.text || "";

          for (const term of searchTerms) {
            if (btnText.toLowerCase().includes(term.toLowerCase())) {
              await message.click(b, r);
              return true;
            }
          }
        }
      }
    } catch (e) {
      console.warn("Could not click button:", e);
    }
    return false;
  }

  /**
   * Extracts a Paystack URL from message text or inline URL buttons
   */
  private extractPaystackUrl(message: any): string | undefined {
    if (!message) return undefined;

    // Check message text for paystack link
    const text = message.text || "";
    const match = text.match(/https?:\/\/(?:checkout\.)?paystack\.(?:com|co)\/[^\s]+/i);
    if (match) {
      return match[0];
    }

    // Check inline buttons for URL
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
