# Dine: API integration checklist

Legend: [ ] not started, [x] done. "TO CONFIRM" items need written provider confirmation before coding.

## Kora (owner: Software Engineer)
### Access and account
- [ ] Sandbox and live keys obtained; stored as secrets; never in repo or prompts
- [ ] Bank-transfer collection API activation requested and granted (TO CONFIRM)
- [ ] Payout API enabled for the account (TO CONFIRM)
- [ ] Settlement set so collected funds reach the Kora balance, not auto-forwarded to a bank (TO CONFIRM)
- [ ] Fee schedule, limits, minimums, payout speed in writing (TO CONFIRM)
- [ ] Written answer on pooled customer funds and wallet model (TO CONFIRM)
- [ ] Sandbox base URL vs key-selected mode confirmed (docs conflict)
### Collections
- [ ] Create single-use bank-transfer collection with unique reference
- [ ] Webhook: signature verification per official page; test the exact header and signed bytes
- [ ] Events handled: charge.success, charge.failed
- [ ] Transaction query by reference before crediting
- [ ] Underpayment, overpayment, expiry, duplicate and out-of-order tests
- [ ] Ledger credit is idempotent and uses the amount actually paid
### Payouts
- [ ] Read official payout reference in full; record exact endpoint, fields, statuses (do not code from SDKs)
- [ ] Bank account resolve before payout; store resolved name
- [ ] Confirm Paystack-Titan and Wema bank codes are valid payout destinations (TO CONFIRM)
- [ ] Balance API pre-flight check (GET /merchant/api/v1/balances)
- [ ] Idempotency reference created before call; never resend after timeout
- [ ] Events handled: transfer.success, transfer.failed; status query agrees before posting ledger
- [ ] Timeout and uncertain-outcome tests
- [ ] Insufficient balance and invalid account tests
### Reconciliation
- [ ] Daily compare ledger A1 with Kora balance (available plus pending)
- [ ] Unmatched provider events and ledger entries list
- [ ] Settlement export obtained (TO CONFIRM)

## Prime and Paystack (owner: Software Engineer)
- [ ] Prime agrees to accept Dine-originated orders (TO CONFIRM)
- [ ] Checkout reference and temporary account provided per order (TO CONFIRM)
- [ ] Business-account transfer accepted (TO CONFIRM)
- [ ] Matching rule, exact amount, expiry documented (TO CONFIRM)
- [ ] Confirmation method and speed agreed: API, webhook, dashboard, message (TO CONFIRM)
- [ ] Refund, rejection, delay and complaint channel and times agreed (TO CONFIRM)
- [ ] Permission to name Prime publicly
- [ ] Integration level agreed: L0 assisted, L1 channel-assisted, L2 automated
- [ ] Controlled real test with team funds passed with written proof

## Telegram (owner: Software Engineer)
- [ ] Read Bot API reference: webhook secret token header, callback_data limit, rate limits
- [ ] Webhook set with secret; updates deduplicated by update ID
- [ ] All 11 commands and callback tokens (single-use, user-bound)
- [ ] Notification queue with per-chat rate limit

## AI model provider (owner: AI Engineer)
- [ ] Two or three candidates evaluated on the same sets; decision recorded
- [ ] Tool calling and structured output verified; schemas validated server-side
- [ ] Timeouts, retries, fallback to non-AI mode
- [ ] Cost per interaction measured; daily per-user cap set
- [ ] No secrets or other users' data in context

## Infrastructure
- [ ] Postgres backups enabled; restore tested
- [ ] Redis configured per BullMQ documentation
- [ ] Feature flags default off in production: PAYOUTS_ENABLED, LIVE_MONEY_ENABLED, PRIME_AUTOMATION_ENABLED, AI_ORDER_PROPOSALS_ENABLED
- [ ] Error monitoring and alerts for stuck payments and ledger mismatches
