/**
 * @dine/ai: everything the bot server calls. See the backend handoff guide.
 *
 * auth-session.ts is deliberately NOT exported: it is a one-off CLI
 * (`pnpm agent:auth`) that starts an interactive Telegram login when loaded.
 */
export * from "./agent.js";
export * from "./find/index.js";
export * from "./plan/index.js";
export * from "./recommend/index.js";
export { loadReviewStore } from "./context/sources.js";
export type { OrderFailure, OrderStage } from "./order/prime-flow.js";
export type { FundingAccount, PaymentEvidence, PaymentStatus, PrimeWallet, TopUpCheck } from "./order/prime-wallet.js";
