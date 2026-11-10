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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[DineAgent] ${msg}`);
}

/** Dump all buttons on a message for debugging */
function dumpButtons(msg: any): string {
  if (!msg) return "(no message)";
  if (!msg.replyMarkup) return `"${(msg.text || "").slice(0, 80)}" — (no buttons)`;

  const rows = (msg.replyMarkup as any).rows || [];
  const btnList: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const buttons = rows[r].buttons || [];
    for (let b = 0; b < buttons.length; b++) {
      const btn = buttons[b];
      btnList.push(`[r${r}c${b}] "${btn.text || ""}" url="${btn.url || ""}"`);
    }
  }
  return `"${(msg.text || "").slice(0, 60)}" — Buttons: ${btnList.join(" | ")}`;
}

/** Wait for a NEW bot message (id > lastSeenId) with timeout */
async function waitForNewMessage(
  client: TelegramClient,
  botEntity: any,
  lastSeenId: number,
  timeoutMs = 8000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(botEntity, { limit: 3 });
    for (const m of messages) {
      if (!m.out && m.id > lastSeenId) {
        log(`  ← New message id=${m.id}: "${(m.text || "").slice(0, 80)}"`);
        return m;
      }
    }
    await sleep(400);
  }
  // Return whatever is newest even if it's old
  const fallback = await client.getMessages(botEntity, { limit: 1 });
  return fallback[0] || null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Agent ────────────────────────────────────────────────────────────────────

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
   * Click a button whose text includes `targetText` (case-insensitive).
   * Returns the button text that was clicked, or null if not found.
   */
  private async clickButtonByText(
    message: any,
    targetText: string
  ): Promise<string | null> {
    if (!message || !message.replyMarkup) return null;

    const rows = (message.replyMarkup as any).rows || [];
    const search = targetText.trim().toLowerCase();

    for (let r = 0; r < rows.length; r++) {
      const buttons = rows[r].buttons || [];
      for (let b = 0; b < buttons.length; b++) {
        const btn = buttons[b];
        const btnText = (btn.text || "").trim().toLowerCase();

        if (btnText.includes(search) || search.includes(btnText)) {
          log(`  → Clicking [r${r}c${b}] "${btn.text}"`);
          try {
            // gramjs click signature: message.click(row, column) — note order
            await message.click({ i: r, j: b });
            return btn.text;
          } catch (e: any) {
            log(`  ✗ Click failed on "${btn.text}": ${e?.message}`);
          }
        }
      }
    }
    return null;
  }

  /**
   * Click the first button that matches ANY of the given texts.
   * Returns the matched button text or null.
   */
  private async clickFirstMatch(
    message: any,
    candidates: string[]
  ): Promise<string | null> {
    for (const candidate of candidates) {
      const result = await this.clickButtonByText(message, candidate);
      if (result !== null) return result;
    }
    return null;
  }

  /**
   * Autonomous Order Placement on Prime's Bot.
   * Navigates the full flow: start → catalog → vendor → item → delivery details → checkout.
   */
  public async placeOrder(target: OrderTarget): Promise<AgentOrderResult> {
    const stepsCompleted: string[] = [];
    const client = await this.getClient();

    try {
      const botUsername = (
        target.botUsername ||
        process.env.PRIME_BOT_USERNAME ||
        "orderfromprimebot"
      ).replace(/^@/, "");

      log(`Starting order on @${botUsername}: "${target.vendorName}" → "${target.itemName}"`);

      const botEntity = await client.getEntity(botUsername);
      stepsCompleted.push(`Connected to @${botUsername}`);

      // ── STEP 1: Send /start, grab baseline message id ──────────────────────
      // Get the current latest message id before we do anything
      const preStartMsgs = await client.getMessages(botEntity, { limit: 1 });
      const baselineId = preStartMsgs[0]?.id ?? 0;
      log(`Baseline message id: ${baselineId}`);

      await client.sendMessage(botEntity, { message: "/start" });
      stepsCompleted.push("Sent /start");

      let msg = await waitForNewMessage(client, botEntity, baselineId, 10000);
      log(`After /start: ${dumpButtons(msg)}`);

      // ── STEP 2: Open vendor catalog ─────────────────────────────────────────
      const catalogClicked = await this.clickFirstMatch(msg, [
        "see all vendors",
        "i'm hungry",
        "hungry",
        "order food",
        "order",
        "vendors",
        "menu",
      ]);

      if (catalogClicked) {
        stepsCompleted.push(`Opened catalog via "${catalogClicked}"`);
        const prevId = msg.id;
        msg = await waitForNewMessage(client, botEntity, prevId, 8000);
        log(`After catalog open: ${dumpButtons(msg)}`);
      } else {
        log("  ⚠ No catalog button found — trying vendor search directly on start message");
      }

      // ── STEP 3: Find and click vendor (paginate up to 6 pages) ─────────────
      let vendorFound = false;
      for (let page = 1; page <= 6; page++) {
        log(`Page ${page}: ${dumpButtons(msg)}`);

        const clicked = await this.clickButtonByText(msg, target.vendorName);
        if (clicked) {
          vendorFound = true;
          stepsCompleted.push(`Selected vendor "${target.vendorName}" on page ${page}`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 8000);
          log(`After vendor click: ${dumpButtons(msg)}`);
          break;
        }

        // Try to go to next page
        const nextClicked = await this.clickFirstMatch(msg, ["next", "next page", "▶", "»", "→"]);
        if (nextClicked) {
          stepsCompleted.push(`Navigated to catalog page ${page + 1}`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 6000);
        } else {
          log(`  ⚠ Vendor not found and no "Next" button on page ${page}`);
          break;
        }
      }

      if (!vendorFound) {
        return {
          success: false,
          message: `Vendor "${target.vendorName}" was not found in Prime's active directory.`,
          stepsCompleted,
          rawResponse: msg?.text,
        };
      }

      // ── STEP 4: Click meal item ─────────────────────────────────────────────
      const itemClicked = await this.clickFirstMatch(msg, [
        target.itemName,
        "order now",
        "add to cart",
        "select",
      ]);

      if (itemClicked) {
        stepsCompleted.push(`Selected item "${itemClicked}"`);
        const prevId = msg.id;
        msg = await waitForNewMessage(client, botEntity, prevId, 8000);
        log(`After item click: ${dumpButtons(msg)}`);
      } else {
        log(`  ⚠ Item "${target.itemName}" not found — dumping vendor page: ${dumpButtons(msg)}`);
        stepsCompleted.push(`⚠ Item not found, proceeding with current state`);
      }

      // ── STEP 5: Handle intermediate steps (quantity, delivery, confirm) ─────
      // Prime's bot likely asks for hall/room or quantity before showing payment.
      // We loop up to 5 times checking for each known prompt type.
      for (let step = 0; step < 8; step++) {
        const paystackUrl = this.extractPaystackUrl(msg);
        if (paystackUrl) {
          stepsCompleted.push("✅ Acquired Paystack checkout URL");
          return {
            success: true,
            message: "Order placed successfully! Ready for payment.",
            paystackUrl,
            stepsCompleted,
            rawResponse: msg?.text,
          };
        }

        const msgText = (msg?.text || "").toLowerCase();
        log(`Intermediate step ${step + 1}: "${msgText.slice(0, 100)}"`);

        // Handle quantity selection
        if (msgText.includes("quantity") || msgText.includes("how many")) {
          const qty = await this.clickFirstMatch(msg, ["1", "one"]);
          if (qty) {
            stepsCompleted.push(`Selected quantity: "${qty}"`);
            const prevId = msg.id;
            msg = await waitForNewMessage(client, botEntity, prevId, 6000);
            continue;
          }
        }

        // Handle hall/location selection
        if (
          msgText.includes("hall") ||
          msgText.includes("hostel") ||
          msgText.includes("location") ||
          msgText.includes("where") ||
          msgText.includes("deliver")
        ) {
          const hall = target.hall || process.env.DEFAULT_HALL || "";
          if (hall) {
            const hallClicked = await this.clickButtonByText(msg, hall);
            if (hallClicked) {
              stepsCompleted.push(`Selected hall: "${hallClicked}"`);
              const prevId = msg.id;
              msg = await waitForNewMessage(client, botEntity, prevId, 6000);
              continue;
            }
          }
          // If no hall configured, log and break
          log(`  ⚠ Hall/location prompt found but no hall configured. Buttons: ${dumpButtons(msg)}`);
          stepsCompleted.push(`⚠ Hall/location prompt needs input — set DEFAULT_HALL in .env`);
          break;
        }

        // Handle room number prompt (text input expected)
        if (msgText.includes("room") || msgText.includes("block")) {
          const room = target.room || process.env.DEFAULT_ROOM || "";
          if (room) {
            await client.sendMessage(botEntity, { message: room });
            stepsCompleted.push(`Sent room: "${room}"`);
            const prevId = msg.id;
            msg = await waitForNewMessage(client, botEntity, prevId, 6000);
            continue;
          }
          log(`  ⚠ Room prompt found but no room configured. Set DEFAULT_ROOM in .env`);
          break;
        }

        // Handle any "confirm", "proceed", "pay" button
        const confirmClicked = await this.clickFirstMatch(msg, [
          "confirm",
          "proceed",
          "pay now",
          "pay",
          "checkout",
          "place order",
          "yes",
          "continue",
        ]);
        if (confirmClicked) {
          stepsCompleted.push(`Clicked "${confirmClicked}"`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 8000);
          continue;
        }

        // Nothing matched — wait a moment and re-check for Paystack URL in same message
        log(`  ⚠ No matching action for step ${step + 1}, waiting...`);
        await sleep(2000);
        const refreshed = await client.getMessages(botEntity, { limit: 1 });
        if (refreshed[0]?.id !== msg?.id) {
          msg = refreshed[0];
          continue;
        }
        break;
      }

      // Final check
      const finalUrl = this.extractPaystackUrl(msg);
      if (finalUrl) {
        stepsCompleted.push("✅ Acquired Paystack checkout URL");
        return {
          success: true,
          message: "Order placed! Ready for payment.",
          paystackUrl: finalUrl,
          stepsCompleted,
          rawResponse: msg?.text,
        };
      }

      return {
        success: false,
        message: "Order flow reached an unrecognised state before checkout. Check server logs for button dumps.",
        stepsCompleted,
        rawResponse: msg?.text,
      };
    } catch (err: any) {
      console.error("[DineAgent] Error:", err);
      return {
        success: false,
        message: `Agent error: ${err?.message || err}`,
        stepsCompleted,
      };
    }
  }

  private extractPaystackUrl(message: any): string | undefined {
    if (!message) return undefined;

    // Check message text
    const text = message.text || "";
    const match = text.match(/https?:\/\/(?:checkout\.)?paystack\.(?:com|co)\/[^\s]+/i);
    if (match) return match[0];

    // Check inline button URLs
    if (message.replyMarkup?.rows) {
      for (const row of message.replyMarkup.rows) {
        for (const btn of row.buttons || []) {
          if (btn.url && (btn.url.includes("paystack") || btn.url.includes("pay.korapay"))) {
            return btn.url;
          }
        }
      }
    }

    // Also scan message entities for URLs
    if (message.entities) {
      for (const entity of message.entities) {
        if (entity.url && (entity.url.includes("paystack") || entity.url.includes("pay.korapay"))) {
          return entity.url;
        }
      }
    }

    return undefined;
  }
}
