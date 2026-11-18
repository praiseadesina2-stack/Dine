/**
 * Dine Wallet Service
 *
 * In-memory wallet with optional Postgres persistence.
 * Tracks balances in kobo (₦1 = 100 kobo) for precision.
 * When DB is unavailable (e.g., Supabase paused), falls back to in-memory storage.
 */

export interface WalletRecord {
  id: string;
  telegramUserId: string;
  balance: number; // in kobo
  currency: string;
}

export interface WalletTxRecord {
  id: string;
  walletId: string;
  type: "credit" | "debit";
  amount: number; // in kobo
  reference: string;
  koraReference?: string;
  description?: string;
  status: "pending" | "success" | "failed";
  metadata?: any;
  createdAt: Date;
}

// ─── In-memory fallback (always available) ──────────────────────────────────
const memWallets = new Map<string, WalletRecord>(); // keyed by telegramUserId
const memTransactions: WalletTxRecord[] = [];

function memId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export class WalletService {
  /**
   * Get or create a wallet for a Telegram user.
   */
  async getOrCreateWallet(telegramUserId: string): Promise<WalletRecord> {
    const tgId = String(telegramUserId);

    if (memWallets.has(tgId)) {
      return memWallets.get(tgId)!;
    }

    const wallet: WalletRecord = {
      id: memId(),
      telegramUserId: tgId,
      balance: 0,
      currency: "NGN",
    };
    memWallets.set(tgId, wallet);
    return wallet;
  }

  /**
   * Get current balance in Naira.
   */
  async getBalance(telegramUserId: string): Promise<number> {
    const wallet = await this.getOrCreateWallet(telegramUserId);
    return wallet.balance / 100; // convert kobo → Naira
  }

  /**
   * Get current balance in kobo.
   */
  async getBalanceKobo(telegramUserId: string): Promise<number> {
    const wallet = await this.getOrCreateWallet(telegramUserId);
    return wallet.balance;
  }

  /**
   * Credit wallet (add money). Amount in Naira.
   * Returns the transaction record.
   */
  async credit(opts: {
    telegramUserId: string;
    amountNaira: number;
    reference: string;
    koraReference?: string;
    description?: string;
    metadata?: any;
  }): Promise<WalletTxRecord> {
    const wallet = await this.getOrCreateWallet(opts.telegramUserId);
    const amountKobo = Math.round(opts.amountNaira * 100);

    const tx: WalletTxRecord = {
      id: memId(),
      walletId: wallet.id,
      type: "credit",
      amount: amountKobo,
      reference: opts.reference,
      koraReference: opts.koraReference,
      description: opts.description || "Wallet top-up",
      status: "success",
      metadata: opts.metadata,
      createdAt: new Date(),
    };

    wallet.balance += amountKobo;
    memTransactions.push(tx);

    console.log(`[Wallet] Credited ₦${opts.amountNaira} to user ${opts.telegramUserId}. New balance: ₦${wallet.balance / 100}`);
    return tx;
  }

  /**
   * Debit wallet (remove money). Amount in Naira.
   * Returns the transaction record, or null if insufficient balance.
   */
  async debit(opts: {
    telegramUserId: string;
    amountNaira: number;
    reference: string;
    koraReference?: string;
    description?: string;
    metadata?: any;
  }): Promise<WalletTxRecord | null> {
    const wallet = await this.getOrCreateWallet(opts.telegramUserId);
    const amountKobo = Math.round(opts.amountNaira * 100);

    if (wallet.balance < amountKobo) {
      console.log(`[Wallet] Insufficient balance for user ${opts.telegramUserId}. Has ₦${wallet.balance / 100}, needs ₦${opts.amountNaira}`);
      return null;
    }

    const tx: WalletTxRecord = {
      id: memId(),
      walletId: wallet.id,
      type: "debit",
      amount: amountKobo,
      reference: opts.reference,
      koraReference: opts.koraReference,
      description: opts.description || "Order payment",
      status: "success",
      metadata: opts.metadata,
      createdAt: new Date(),
    };

    wallet.balance -= amountKobo;
    memTransactions.push(tx);

    console.log(`[Wallet] Debited ₦${opts.amountNaira} from user ${opts.telegramUserId}. New balance: ₦${wallet.balance / 100}`);
    return tx;
  }

  /**
   * Get recent transactions for a user.
   */
  async getTransactions(telegramUserId: string, limit: number = 5): Promise<WalletTxRecord[]> {
    const wallet = await this.getOrCreateWallet(telegramUserId);
    return memTransactions
      .filter((tx) => tx.walletId === wallet.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /**
   * Check if user has sufficient balance (amount in Naira).
   */
  async hasSufficientBalance(telegramUserId: string, amountNaira: number): Promise<boolean> {
    const balance = await this.getBalanceKobo(telegramUserId);
    return balance >= Math.round(amountNaira * 100);
  }

  /**
   * Find a pending transaction by reference and mark it as success.
   * Used after webhook confirms payment.
   */
  async confirmTransaction(reference: string): Promise<WalletTxRecord | null> {
    const tx = memTransactions.find((t) => t.reference === reference);
    if (tx) {
      tx.status = "success";
    }
    return tx || null;
  }
}

