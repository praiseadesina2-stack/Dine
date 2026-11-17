import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface BankTransferDetails {
  accountNumber: string;
  bankName: string;
  accountName: string;
  amount: number;
}

export interface KoraDisbursementPayload {
  bankCode: string;
  accountNumber: string;
  amount: number;
  currency?: string;
  narration?: string;
  customerName?: string;
  customerEmail?: string;
  reference?: string;
}

export interface KoraDisbursementResult {
  success: boolean;
  status: string;
  reference: string;
  message: string;
  raw?: any;
}

export class KoraPaymentService {
  private secretKey: string;
  private baseUrl: string = "https://api.korapay.com/merchant/api/v1";
  private bankCodeCache: Map<string, string> = new Map();

  constructor(secretKey?: string) {
    this.secretKey = secretKey || process.env.KORA_SECRET_KEY || "";
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  /**
   * Fetch bank code for a given bank name (e.g. "Flutterwave MFB", "Wema Bank", "Access Bank")
   */
  public async getBankCode(bankName: string): Promise<string | null> {
    const cleanQuery = bankName.toLowerCase().trim();
    if (this.bankCodeCache.has(cleanQuery)) {
      return this.bankCodeCache.get(cleanQuery)!;
    }

    // Default known mappings for popular virtual bank providers
    if (cleanQuery.includes("flutterwave")) return "090567";
    if (cleanQuery.includes("wema")) return "035";
    if (cleanQuery.includes("titan")) return "102";
    if (cleanQuery.includes("opay") || cleanQuery.includes("paycom")) return "999992";
    if (cleanQuery.includes("palmpay")) return "999991";
    if (cleanQuery.includes("kuda")) return "090267";
    if (cleanQuery.includes("sterling")) return "232";
    if (cleanQuery.includes("gtb") || cleanQuery.includes("guaranty")) return "058";
    if (cleanQuery.includes("access")) return "044";

    try {
      const response = await fetch(`${this.baseUrl}/misc/banks?countryCode=NG`, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as any;
      if (body?.status && Array.isArray(body?.data)) {
        for (const b of body.data) {
          const name = (b.name || "").toLowerCase();
          const slug = (b.slug || "").toLowerCase();
          const code = b.code;

          this.bankCodeCache.set(name, code);
          this.bankCodeCache.set(slug, code);

          if (name.includes(cleanQuery) || cleanQuery.includes(name)) {
            return code;
          }
        }
      }
    } catch (e) {
      console.error("[Kora] Error fetching banks:", e);
    }

    return null;
  }

  /**
   * Disburse/transfer money directly to destination bank account
   */
  public async disburse(payload: KoraDisbursementPayload): Promise<KoraDisbursementResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        status: "not_configured",
        reference: "",
        message: "KORA_SECRET_KEY is not set in environment.",
      };
    }

    const reference = payload.reference || `dine_payout_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const reqBody = {
      reference,
      destination: {
        type: "bank_account",
        amount: payload.amount,
        currency: payload.currency || "NGN",
        narration: payload.narration || "Dine Automated Meal Payment",
        bank_account: {
          bank: payload.bankCode,
          account_number: payload.accountNumber,
        },
        customer: {
          name: payload.customerName || "Dine Student",
          email: payload.customerEmail || "customer@dine.app",
        },
      },
    };

    try {
      console.log(`[Kora] Initiating payout of ₦${payload.amount} to ${payload.accountNumber} (Bank: ${payload.bankCode}) ref: ${reference}`);

      const response = await fetch(`${this.baseUrl}/transactions/disburse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify(reqBody),
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.status) {
        return {
          success: false,
          status: data?.data?.status || "failed",
          reference,
          message: data?.message || "Kora payout failed",
          raw: data,
        };
      }

      return {
        success: true,
        status: data?.data?.status || "processing",
        reference,
        message: data?.message || "Transfer initiated successfully",
        raw: data,
      };
    } catch (err: any) {
      console.error("[Kora] Payout request exception:", err);
      return {
        success: false,
        status: "network_error",
        reference,
        message: err?.message || "Network error contacting Kora API",
      };
    }
  }
}

