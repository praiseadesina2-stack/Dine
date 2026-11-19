import { pgTable, uuid, text, boolean, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: text("telegram_user_id").notNull(),
    username: text("username"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("users_telegram_user_id_idx").on(table.telegramUserId)
  ]
);

export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    consentType: text("consent_type").notNull(),
    policyVersion: text("policy_version").notNull(),
    granted: boolean("granted").notNull(),
    source: text("source").default("telegram").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("consent_records_user_id_idx").on(table.userId)
  ]
);

// ─── WALLET ─────────────────────────────────────────────────────────────────
export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    telegramUserId: text("telegram_user_id").notNull(),
    balance: integer("balance").default(0).notNull(), // stored in kobo (₦1 = 100 kobo)
    currency: text("currency").default("NGN").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("wallets_user_id_idx").on(table.userId),
    uniqueIndex("wallets_telegram_user_id_idx").on(table.telegramUserId),
  ]
);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id),
    type: text("type").notNull(), // "credit" | "debit"
    amount: integer("amount").notNull(), // in kobo
    reference: text("reference").notNull(), // our internal unique ref
    koraReference: text("kora_reference"), // Kora's transaction reference
    description: text("description"),
    status: text("status").default("pending").notNull(), // "pending" | "success" | "failed"
    metadata: jsonb("metadata"), // extra data (card last4, payout details, etc.)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("wallet_tx_wallet_id_idx").on(table.walletId),
    uniqueIndex("wallet_tx_reference_idx").on(table.reference),
  ]
);
