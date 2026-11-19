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

export interface AccountResolveResult {
  success: boolean;
  accountName?: string;
  accountNumber?: string;
  bankCode?: string;
  message?: string;
}

export class KoraPaymentService {
  private secretKey: string;
  private publicKey: string;
  private baseUrl: string = "https://api.korapay.com/merchant/api/v1";
  private bankCodeCache: Map<string, string> = new Map();

  constructor(secretKey?: string, publicKey?: string) {
    this.secretKey = secretKey || process.env.KORA_SECRET_KEY || "";
    this.publicKey = publicKey || process.env.KORA_PUBLIC_KEY || "";
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey && this.secretKey.trim().length > 0);
  }

  /** Sandbox keys: payouts go to Kora's test account, no real money moves. */
  public isTestMode(): boolean {
    return this.secretKey.startsWith("sk_test_");
  }

  /**
   * Bank code for `bankName` from Kora's own bank list, or null. Unlike getBankCode() it
   * never guesses or falls back: use it before sending real money. A null means stop.
   */
  public async findBankCode(bankName: string): Promise<string | null> {
    const want = bankName.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    if (!want) return null;
    try {
      const response = await fetch(`${this.baseUrl}/misc/banks?countryCode=NG`, {
        headers: { Authorization: `Bearer ${this.publicKey || this.secretKey}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as any;
      if (!body?.status || !Array.isArray(body?.data)) return null;
      const banks = body.data as { name?: string; slug?: string; code?: string }[];
      const exact = banks.filter((b) => (b.name ?? "").toLowerCase().trim() === want);
      if (exact.length === 1 && exact[0].code) return exact[0].code;
      // One unambiguous partial match ("Flutterwave MFB" → "Flutterwave MFB Limited"), else none.
      const partial = banks.filter((b) => {
        const name = (b.name ?? "").toLowerCase();
        return name && (name.includes(want) || want.includes(name));
      });
      return partial.length === 1 && partial[0].code ? partial[0].code : null;
    } catch {
      return null;
    }
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
    if (cleanQuery.includes("flutterwave")) return "110002";
    if (cleanQuery.includes("wema")) return "035";
    if (cleanQuery.includes("titan")) return "102";
    if (cleanQuery.includes("opay") || cleanQuery.includes("paycom")) return "999992";
    if (cleanQuery.includes("palmpay")) return "999991";
    if (cleanQuery.includes("kuda")) return "090267";
    if (cleanQuery.includes("sterling")) return "232";
    if (cleanQuery.includes("gtb") || cleanQuery.includes("guaranty")) return "058";
    if (cleanQuery.includes("access")) return "044";

    try {
      // /misc/banks requires the PUBLIC key, not secret key
      const authKey = this.publicKey || this.secretKey;
      const response = await fetch(`${this.baseUrl}/misc/banks?countryCode=NG`, {
        headers: {
          Authorization: `Bearer ${authKey}`,
        },
      });

      if (!response.ok) {
        return "110002";
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

    return "110002"; // Fallback to Flutterwave Technology Solutions Limited
  }

  /**
   * Verify bank account name before sending money (Name Inquiry)
   */
  public async resolveAccount(accountNumber: string, bankCode: string): Promise<AccountResolveResult> {
    if (!this.isConfigured()) {
      return { success: false, message: "Kora secret key not configured." };
    }

    try {
      // /misc/banks/resolve requires the PUBLIC key
      const authKey = this.publicKey || this.secretKey;
      const response = await fetch(`${this.baseUrl}/misc/banks/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authKey}`,
        },
        body: JSON.stringify({
          bank: bankCode,
          account: accountNumber,
        }),
      });

      const data = (await response.json()) as any;
      if (response.ok && data?.status && data?.data) {
        return {
          success: true,
          accountName: data.data.account_name,
          accountNumber: data.data.account_number,
          bankCode: data.data.bank_code || bankCode,
        };
      }

      return {
        success: false,
        message: data?.message || "Account verification failed",
      };
    } catch (e: any) {
      return {
        success: false,
        message: e?.message || "Error resolving account",
      };
    }
  }

  /**
   * Disburse/transfer money directly to destination bank account (e.g. Prime That)
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

    // In Kora Test Sandbox, real accounts (like 9479959026) are rejected as "Invalid account".
    // Kora's official Sandbox successful payout target is bank '033' (UBA) and account '0000000000'.
    const isTestMode = this.secretKey.startsWith("sk_test_");
    const targetBank = isTestMode ? "033" : payload.bankCode;
    const targetAccount = isTestMode ? "0000000000" : payload.accountNumber;

    const reqBody = {
      reference,
      destination: {
        type: "bank_account",
        amount: payload.amount,
        currency: payload.currency || "NGN",
        narration: payload.narration || "Dine Automated Meal Payment",
        bank_account: {
          bank: targetBank,
          account: targetAccount,
        },
        customer: {
          name: payload.customerName || "Prime That",
          email: payload.customerEmail || "vendor@prime.ng",
        },
      },
    };

    try {
      console.log(`[Kora] Initiating payout of ₦${payload.amount} to ${targetAccount} (Bank: ${targetBank}, TestMode: ${isTestMode}) ref: ${reference}`);

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

  /**
   * Verify payout status by reference
   */
  public async verifyPayout(reference: string): Promise<KoraDisbursementResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        status: "not_configured",
        reference,
        message: "KORA_SECRET_KEY not set",
      };
    }

    try {
      // Query Kora Transaction Status API
      const response = await fetch(`${this.baseUrl}/transactions/${encodeURIComponent(reference)}`, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      const data = (await response.json()) as any;
      if (response.ok && data?.status && data?.data) {
        return {
          success: data.data.status === "success",
          status: data.data.status,
          reference: data.data.reference || reference,
          message: data.data.message || `Payout is ${data.data.status}`,
          raw: data,
        };
      }

      return {
        success: false,
        status: data?.data?.status || "unknown",
        reference,
        message: data?.message || "Could not verify payout",
        raw: data,
      };
    } catch (e: any) {
      return {
        success: false,
        status: "error",
        reference,
        message: e?.message || "Network error checking payout status",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHARGE / PAY-IN — Fund wallet via Kora Checkout
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize a Kora checkout charge to collect payment.
   * Returns a checkout_url that the user opens to pay (card, bank transfer, etc).
   */
  public async initializeCharge(opts: {
    amount: number; // in Naira (not kobo)
    customerName: string;
    customerEmail: string;
    reference?: string;
    redirectUrl?: string;
    notificationUrl?: string;
    narration?: string;
  }): Promise<{ success: boolean; checkoutUrl?: string; reference: string; message: string; raw?: any }> {
    if (!this.isConfigured()) {
      return { success: false, reference: "", message: "KORA_SECRET_KEY not set" };
    }

    const reference = opts.reference || `dine_fund_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const body: Record<string, any> = {
      reference,
      amount: opts.amount,
      currency: "NGN",
      customer: {
        name: opts.customerName,
        email: opts.customerEmail,
      },
    };

    if (opts.notificationUrl) body.notification_url = opts.notificationUrl;
    if (opts.redirectUrl) body.redirect_url = opts.redirectUrl;

    try {
      console.log(`[Kora] Initializing charge of ₦${opts.amount} for ${opts.customerEmail}, ref: ${reference}`);

      const response = await fetch(`${this.baseUrl}/charges/initialize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as any;

      if (response.ok && data?.status && data?.data?.checkout_url) {
        return {
          success: true,
          checkoutUrl: data.data.checkout_url,
          reference,
          message: "Checkout initialized",
          raw: data,
        };
      }

      return {
        success: false,
        reference,
        message: data?.message || "Failed to initialize checkout",
        raw: data,
      };
    } catch (err: any) {
      console.error("[Kora] Charge init error:", err);
      return {
        success: false,
        reference,
        message: err?.message || "Network error",
      };
    }
  }

  /**
   * Verify a charge by reference (check if payment was completed).
   */
  public async verifyCharge(reference: string): Promise<{
    success: boolean;
    status: string;
    amount?: number;
    message: string;
    raw?: any;
  }> {
    if (!this.isConfigured()) {
      return { success: false, status: "not_configured", message: "KORA_SECRET_KEY not set" };
    }

    try {
      // First try unified /transactions/{reference}
      let response = await fetch(`${this.baseUrl}/transactions/${encodeURIComponent(reference)}`, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      let data = (await response.json()) as any;

      if (!response.ok || !data?.status) {
        // Fallback to /charges/{reference}
        response = await fetch(`${this.baseUrl}/charges/${encodeURIComponent(reference)}`, {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        });
        data = (await response.json()) as any;
      }

      if (response.ok && data?.status && data?.data) {
        const isSuccess = data.data.status === "success";
        const amt = typeof data.data.amount === "string" ? parseFloat(data.data.amount) : data.data.amount;
        return {
          success: isSuccess,
          status: data.data.status,
          amount: amt,
          message: data.message || `Charge is ${data.data.status}`,
          raw: data,
        };
      }

      return {
        success: false,
        status: data?.data?.status || "unknown",
        message: data?.message || "Could not verify charge",
        raw: data,
      };
    } catch (e: any) {
      return {
        success: false,
        status: "error",
        message: e?.message || "Network error verifying charge",
      };
    }
  }
}
