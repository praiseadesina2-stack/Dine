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

export interface BankPaymentDetails {
  accountNumber: string;
  bankName: string;
  accountName: string;
  amount: number;
}

export interface AgentOrderResult {
  success: boolean;
  message: string;
  paystackUrl?: string;
  bankPaymentDetails?: BankPaymentDetails;
  rawResponse?: string;
  stepsCompleted: string[];
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[DineAgent] ${msg}`);
}

function normalizeForMatch(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[₦n]\s*[\d,]+(?:\.\d{2})?/g, "") // remove prices like ₦2,500
    .replace(/[\(\)\[\]\{\}\+\-\*\/\\,.:;!?_~"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((w) => w.length > 1 && !["the", "and", "with", "for", "pack", "menu", "select", "order"].includes(w));
}

function calculateSimilarity(candidate: string, target: string): number {
  const cNorm = normalizeForMatch(candidate);
  const tNorm = normalizeForMatch(target);

  if (!cNorm || !tNorm) return 0;
  if (cNorm === tNorm) return 1.0;
  if (cNorm.includes(tNorm) || tNorm.includes(cNorm)) return 0.9;

  const cTokens = getTokens(candidate);
  const tTokens = getTokens(target);
  if (cTokens.length === 0 || tTokens.length === 0) return 0;

  // Strict number checking: if both target and button mention numbers, they MUST match
  const cNums: string[] = candidate.match(/\b\d+\b/g) || [];
  const tNums: string[] = target.match(/\b\d+\b/g) || [];
  if (cNums.length > 0 && tNums.length > 0) {
    const common = cNums.filter((n) => tNums.indexOf(n) !== -1);
    if (common.length === 0) return 0; // Numbers mismatch! e.g. 1 sausage vs 2 sausages
  }

  // Token overlap ratio
  let match = 0;
  for (const t of tTokens) {
    if (cTokens.some((c) => c === t || c.includes(t) || t.includes(c))) {
      match++;
    }
  }

  return match / tTokens.length;
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

        // Exact match or clean substring (require at least 4 chars to prevent single letter/digit false matches)
        const isMatch =
          btnText === search ||
          btnText.includes(search) ||
          (btnText.length >= 4 && search.includes(btnText));

        if (isMatch) {
          log(`  → Clicking [r${r}c${b}] "${btn.text}"`);
          try {
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
   * Find the button on a message that has the highest similarity score with targetText.
   * Prevents matching generic buttons like 'back', 'next', 'cancel'.
   */
  private findBestButton(
    message: any,
    targetText: string,
    minScore: number = 0.45
  ): { row: number; col: number; text: string; score: number } | null {
    if (!message || !message.replyMarkup?.rows) return null;

    let best: { row: number; col: number; text: string; score: number } | null = null;
    const rows = message.replyMarkup.rows;

    for (let r = 0; r < rows.length; r++) {
      const buttons = rows[r].buttons || [];
      for (let b = 0; b < buttons.length; b++) {
        const btn = buttons[b];
        const btnText = (btn.text || "").trim();
        if (!btnText) continue;

        const lower = btnText.toLowerCase();
        if (["back", "home", "main menu", "cancel", "help", "next", "prev", "previous"].includes(lower)) {
          continue;
        }

        const score = calculateSimilarity(btnText, targetText);
        if (score >= minScore && (!best || score > best.score)) {
          best = { row: r, col: b, text: btnText, score };
        }
      }
    }

    return best;
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
        log(`Catalog page ${page}: ${dumpButtons(msg)}`);

        // Use smart similarity to find the best matching vendor button
        const bestVendor = this.findBestButton(msg, target.vendorName, 0.45);
        if (bestVendor) {
          log(`  → Selected vendor "${bestVendor.text}" (score: ${bestVendor.score.toFixed(2)})`);
          await msg.click({ i: bestVendor.row, j: bestVendor.col });
          vendorFound = true;
          stepsCompleted.push(`Selected vendor "${bestVendor.text}" on page ${page}`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 8000);
          log(`After vendor click: ${dumpButtons(msg)}`);
          break;
        }

        // Try to go to next catalog page
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

      // ── STEP 4: Find and click EXACT meal item (with pagination!) ───────────
      let itemClicked: string | null = null;
      for (let itemPage = 1; itemPage <= 4; itemPage++) {
        log(`Vendor menu page ${itemPage}: ${dumpButtons(msg)}`);

        // Check if message has an exact/high similarity match for the requested item
        const bestItem = this.findBestButton(msg, target.itemName, 0.45);
        if (bestItem) {
          log(`  → Selected item "${bestItem.text}" (score: ${bestItem.score.toFixed(2)})`);
          await msg.click({ i: bestItem.row, j: bestItem.col });
          itemClicked = bestItem.text;
          stepsCompleted.push(`Selected item "${bestItem.text}"`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 8000);
          log(`After item click: ${dumpButtons(msg)}`);
          break;
        }

        // Check if there is a next page for this vendor's menu
        const nextItemPage = await this.clickFirstMatch(msg, ["next", "next page", "▶", "»", "→"]);
        if (nextItemPage) {
          stepsCompleted.push(`Navigated to vendor menu page ${itemPage + 1}`);
          const prevId = msg.id;
          msg = await waitForNewMessage(client, botEntity, prevId, 6000);
        } else {
          break;
        }
      }

      // CRITICAL SAFEGUARD: Never order the wrong item if the requested meal is unavailable!
      if (!itemClicked) {
        log(`  ❌ Item "${target.itemName}" not found on menu.`);
        return {
          success: false,
          message: `Item "${target.itemName}" is currently not available on "${target.vendorName}"'s menu.`,
          stepsCompleted,
          rawResponse: msg?.text,
        };
      }

      // ── STEP 5: Handle intermediate steps (quantity, delivery, checkout) ────
      for (let step = 0; step < 8; step++) {
        // Immediate check: Paystack / Korapay checkout URL
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

        // Immediate check: Bank Transfer details in message text
        const bankDetails = this.extractBankDetails(msg);
        if (bankDetails) {
          stepsCompleted.push(`✅ Acquired Bank Payment Details: ${bankDetails.accountNumber} (${bankDetails.bankName})`);
          return {
            success: true,
            message: "Order placed! Bank payment details received.",
            bankPaymentDetails: bankDetails,
            stepsCompleted,
            rawResponse: msg?.text,
          };
        }

        const msgText = (msg?.text || "").toLowerCase();
        log(`Intermediate step ${step + 1}: "${msgText.slice(0, 100)}"`);

        // Handle quantity selection (pick 1)
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
            const bestHall = this.findBestButton(msg, hall, 0.4);
            if (bestHall) {
              await msg.click({ i: bestHall.row, j: bestHall.col });
              stepsCompleted.push(`Selected hall: "${bestHall.text}"`);
              const prevId = msg.id;
              msg = await waitForNewMessage(client, botEntity, prevId, 6000);
              continue;
            }
          }
          log(`  ⚠ Hall/location prompt found but could not match hall "${target.hall}". Buttons: ${dumpButtons(msg)}`);
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
          log(`  ⚠ Room prompt found but no room configured.`);
          break;
        }

        // Handle confirm/proceed button (only after item is selected!)
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

        // Wait and check if message was updated
        log(`  ⚠ No matching action for step ${step + 1}, waiting...`);
        await sleep(2000);
        const refreshed = await client.getMessages(botEntity, { limit: 1 });
        if (refreshed[0]?.id !== msg?.id) {
          msg = refreshed[0];
          continue;
        }
        break;
      }

      // Final payment check
      const finalBank = this.extractBankDetails(msg);
      if (finalBank) {
        stepsCompleted.push(`✅ Acquired Bank Payment Details: ${finalBank.accountNumber} (${finalBank.bankName})`);
        return {
          success: true,
          message: "Order placed! Bank payment details received.",
          bankPaymentDetails: finalBank,
          stepsCompleted,
          rawResponse: msg?.text,
        };
      }

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
        message: "Order reached an unrecognised state before payment. Please check with vendor.",
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

  /**
   * Extract bank account number, bank name, account name, and amount from Prime bot's message
   */
  public extractBankDetails(message: any): BankPaymentDetails | undefined {
    if (!message) return undefined;
    const text = message.text || "";

    // Check if message asks to send money to a bank account
    // Example:
    // Send ₦2,250 to:
    // Account number: 9479959026
    // Bank: Flutterwave MFB
    // Name: Prime That
    const accMatch = text.match(/(?:Account\s*number|Account|Acc\s*no\.?):\s*([0-9]{10})/i);
    const bankMatch = text.match(/(?:Bank(?:\s*name)?):\s*([^\n\r]+)/i);
    const nameMatch = text.match(/(?:Name|Account\s*name):\s*([^\n\r]+)/i);
    const amountMatch = text.match(/(?:Send|Pay)?\s*₦\s*([0-9,]+(?:\.[0-9]{2})?)/i);

    if (accMatch && bankMatch) {
      const accountNumber = accMatch[1].trim();
      const bankName = bankMatch[1].trim();
      const accountName = nameMatch ? nameMatch[1].trim() : "Prime That";
      let amount = 0;

      if (amountMatch) {
        amount = parseFloat(amountMatch[1].replace(/,/g, ""));
      }

      return {
        accountNumber,
        bankName,
        accountName,
        amount,
      };
    }

    return undefined;
  }
}

