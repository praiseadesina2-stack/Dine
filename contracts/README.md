# Dine contracts

These files are the agreement between the AI side (`packages/ai`) and the backend (`apps/api`, `packages/database`).
If code and a contract disagree, the code is wrong. To change a contract, open a PR that touches the contract
and the code together, and get the other engineer's review.

| File | What it fixes | Owner → reader | Status |
|---|---|---|---|
| [catalogue.md](catalogue.md) | Catalogue tables, provenance, freshness, what may be shown | AI → Backend | v1, 11 Nov |
| [tools.md](tools.md) | Tool names, arguments, results, error codes | AI → Backend | v1, 11 Nov |
| [schemas/](schemas/) | JSON Schemas for model outputs, tool arguments, errors and policy decisions | AI → Backend | v1, 11 Nov |
| [ordering.md](ordering.md) | When Dine orders for a student, the order sequence, and the ordering agent's interface | Both | **Draft**, 14 Nov: needs backend sign-off |
| [policy.md](policy.md) | Order attempt in, `allow` / `block` / `ask_user` out | Both | **Draft**: needs backend sign-off |
| states.md | Order and payment states, plus the exact message text for each | Backend → AI | **Not written**: backend owes it |

## Rules that apply everywhere

- **Money is integer kobo.** Every stored value, API field and schema field ends in `_kobo`. Naira appears only in text shown to people and in the arguments the model sees (the AI layer converts at that boundary).
- **Times are ISO 8601 in UTC.** Days and the dinner lead time are interpreted in `Africa/Lagos`.
- **Day codes** are `mon tue wed thu fri sat sun` (same as `DAYS` in `packages/ai/src/recommend/types.ts`).
- **IDs are opaque strings.** The AI never builds or parses an ID; it only passes back IDs a tool returned.
- **Dine only orders what is on Prime's bot catalogue.** Campus meals are suggestions only and are never orderable.
- **Dine orders for the student, but only on the student's say-so.** The ordering agent (`DineOrderingAgent`, `packages/ai/src/agent.ts`) places the order on Prime and Dine pays from the wallet the student funded. It runs only when the student taps **Order on Dine**, or when the scheduler runs a day of a plan the student approved and consented to Dine ordering on their behalf. See [ordering.md](ordering.md).
- **The model never triggers an order or a payment.** No model tool, schema or output can place an order, pay, or change a balance. The model proposes; the student approves; the backend's policy check decides; the ordering agent executes.
- **The user comes from the session**, never from model arguments.

## Schema files

| Schema | Used for |
|---|---|
| `schemas/preference-profile.schema.json` | What the preference conversation produces; stored by the backend |
| `schemas/plan-proposal.schema.json` | `propose_plan` arguments; the backend validates it, recomputes the totals and stores a draft |
| `schemas/chat-reply.schema.json` | The model's final reply in chat (`final_answer`) |
| `schemas/tool-args.schema.json` | Arguments for every tool, one `$defs` entry per tool |
| `schemas/tool-error.schema.json` | The error shape every tool returns on failure |
| `schemas/policy-decision.schema.json` | Policy service output |

`packages/ai/src/contracts.test.ts` checks that the schemas parse and that their enums match the code's value lists.
