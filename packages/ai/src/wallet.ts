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
  /** "hold": money reserved for an order; it leaves the balance only when captured. */
  type: "credit" | "debit" | "hold";
  amount: number; // in kobo
  reference: string;
  koraReference?: string;
  description?: string;
  /** Holds: "pending" (reserved) → "captured" (paid) or "released" (returned). */
  status: "pending" | "success" | "failed" | "captured" | "released";
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

    if ((await this.getAvailableKobo(opts.telegramUserId)) < amountKobo) {
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
   * Check if user has sufficient balance (amount in Naira). Money on hold for other orders does not count.
   */
  async hasSufficientBalance(telegramUserId: string, amountNaira: number): Promise<boolean> {
    const available = await this.getAvailableKobo(telegramUserId);
    return available >= Math.round(amountNaira * 100);
  }

  // ─── Reserve → capture / release (contracts/ordering.md) ──────────────────
  // An order reserves the amount BEFORE Prime is touched. Capture it only when Prime is
  // paid ("verified", or Kora "sent" confirmed by verifyPayout); release it when nothing
  // was paid ("not_paid", "failed", "blocked", or any order failure). On "uncertain",
  // leave it reserved until reconciled.

  /** Balance minus money reserved for orders not yet paid or released, in kobo. */
  async getAvailableKobo(telegramUserId: string): Promise<number> {
    const wallet = await this.getOrCreateWallet(telegramUserId);
    const held = memTransactions
      .filter((tx) => tx.walletId === wallet.id && tx.type === "hold" && tx.status === "pending")
      .reduce((sum, tx) => sum + tx.amount, 0);
    return wallet.balance - held;
  }

  /** Available balance in Naira (what the student can spend now). */
  async getAvailableBalance(telegramUserId: string): Promise<number> {
    return (await this.getAvailableKobo(telegramUserId)) / 100;
  }

  /**
   * Reserve `amountKobo` for an order under `reference` (unique per order; reuse it for the
   * Kora payout). Returns the hold, or null if the available balance is too low. Calling
   * again with the same reference returns the same hold: an order is never reserved twice.
   */
  async reserve(opts: { telegramUserId: string; amountKobo: number; reference: string; description?: string; metadata?: any }): Promise<WalletTxRecord | null> {
    const wallet = await this.getOrCreateWallet(opts.telegramUserId);
    const existing = memTransactions.find((tx) => tx.reference === opts.reference);
    if (existing) return existing.type === "hold" && existing.walletId === wallet.id ? existing : null;
    if (!Number.isInteger(opts.amountKobo) || opts.amountKobo <= 0) return null;
    if ((await this.getAvailableKobo(opts.telegramUserId)) < opts.amountKobo) return null;
    const hold: WalletTxRecord = {
      id: memId(),
      walletId: wallet.id,
      type: "hold",
      amount: opts.amountKobo,
      reference: opts.reference,
      description: opts.description || "Order reservation",
      status: "pending",
      metadata: opts.metadata,
      createdAt: new Date(),
    };
    memTransactions.push(hold);
    console.log(`[Wallet] Reserved ₦${opts.amountKobo / 100} for user ${opts.telegramUserId} (ref ${opts.reference})`);
    return hold;
  }

  /**
   * Prime was paid: the reserved money leaves the balance. Captures at most the reserved
   * amount (`amountKobo` lower than it captures less and releases the rest). Idempotent.
   * Returns null if there is no hold, or it was already released.
   */
  async capture(reference: string, opts: { amountKobo?: number; koraReference?: string } = {}): Promise<WalletTxRecord | null> {
    const hold = memTransactions.find((tx) => tx.reference === reference && tx.type === "hold");
    if (!hold || hold.status === "released") return null;
    if (hold.status === "captured") return hold;
    const amount = Math.min(opts.amountKobo ?? hold.amount, hold.amount);
    const wallet = [...memWallets.values()].find((w) => w.id === hold.walletId);
    if (!wallet) return null;
    wallet.balance -= amount;
    hold.amount = amount;
    hold.status = "captured";
    if (opts.koraReference) hold.koraReference = opts.koraReference;
    console.log(`[Wallet] Captured ₦${amount / 100} (ref ${reference}). New balance: ₦${wallet.balance / 100}`);
    return hold;
  }

  /** Nothing was paid: the reservation returns to the available balance. Idempotent; never undoes a capture. */
  async release(reference: string, reason?: string): Promise<WalletTxRecord | null> {
    const hold = memTransactions.find((tx) => tx.reference === reference && tx.type === "hold");
    if (!hold || hold.status === "captured") return null;
    if (hold.status !== "released") {
      hold.status = "released";
      hold.metadata = { ...(hold.metadata ?? {}), releaseReason: reason };
      console.log(`[Wallet] Released ₦${hold.amount / 100} (ref ${reference})${reason ? `: ${reason}` : ""}`);
    }
    return hold;
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

