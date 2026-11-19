/**
 * @dine/ai: everything the bot server calls. See the backend handoff guide.
 *
 * auth-session.ts is deliberately NOT exported: it is a one-off CLI
 * (`pnpm agent:auth`) that starts an interactive Telegram login when loaded.
 */
export * from "./agent.js";
export * from "./kora.js";
export * from "./wallet.js";
export * from "./find/index.js";
export * from "./plan/index.js";
export * from "./recommend/index.js";
// Both modules define planWeek. The bot's /plan uses the recommender's (timetable for a
// RecommendRequest); the weekly dinner planner's is exported as planDinnerWeek.
export { planWeek } from "./recommend/index.js";
export { planWeek as planDinnerWeek } from "./plan/index.js";
export { loadReviewStore } from "./context/sources.js";
export type { CartLine, OrderFailure, OrderStage, PayWith, VerifiedLine } from "./order/prime-flow.js";
export { trayToCartLines, type TrayConversion, type TrayItemInput } from "./order/tray.js";
export type { FundingAccount, PaymentEvidence, PaymentStatus, PrimeWallet, TopUpCheck } from "./order/prime-wallet.js";
export { parseBankTransfer, type BankTransfer } from "./order/prime-transfer.js";
export { payPrimeTransfer, type TransferPayment, type TransferStatus } from "./order/pay-transfer.js";
export { runOrderAndPay, PRIME_PAID } from "./order/order-and-pay.js";
export { suggestNames } from "./order/suggest.js";
