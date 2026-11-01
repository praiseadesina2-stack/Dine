# Dine: GitHub task breakdown

Every issue has one accountable owner. Roles map to GitHub usernames when you create the repo (label `ai-engineer` / `software-engineer`). Import `github_issues.csv` with a CSV-to-issues tool or `gh issue create` in a loop.

## M1 Foundations and discovery (3 Nov)

| # | Issue | Owner | Due | Labels | Done when |
|---|---|---|---|---|---|
| 1 | Create vendor and source log; list vendors to approach | ai-engineer | 2026-11-01 | data,P0 | 8+ vendors listed with source and contact |
| 2 | Student interview script and first 10 interviews | ai-engineer | 2026-11-04 | research,P1 | Findings memo lists decisions confirmed or changed |
| 3 | Tag taxonomy for meals, vendors and reviews | ai-engineer | 2026-11-03 | data,P1 | Taxonomy doc agreed with SW |
| 7 | Evaluation set v0 (20 queries) and runner | ai-engineer | 2026-11-03 | eval,P0 | Runner outputs scores to repo |
| 11 | Tool specifications and JSON schemas v1 | ai-engineer | 2026-11-04 | contract,P0 | SW has implemented each tool |
| 27 | Repo, CI skeleton, environments, secrets | software-engineer | 2026-11-01 | infra,P0 | Merge deploys staging; secret scan runs |
| 28 | Create dev/staging Telegram bots; webhook skeleton | software-engineer | 2026-10-31 | bot,P0 | Bot replies; updates deduplicated |
| 29 | Send Kora questions; request bank-transfer API activation | software-engineer | 2026-10-31 | partner,P0,blocked-partner | Message sent and logged |
| 30 | Prime meeting and written follow-up | software-engineer | 2026-11-02 | partner,P0,blocked-partner | Answers logged with names and dates |
| 31 | Book payments/legal adviser consultation | software-engineer | 2026-11-06 | compliance,P0 | Appointment scheduled |
| 32 | PostgreSQL schema v1 and migrations | software-engineer | 2026-11-01 | backend,P0 | Constraints in SRS Section 15 |
| 33 | Ledger tables, balance constraint, append-only permissions | software-engineer | 2026-11-02 | ledger,P0 | No update/delete for app role |
| 34 | Kora webhook endpoint with signature verification | software-engineer | 2026-11-02 | payments,P0 | Valid/invalid signature tests |
| 35 | Onboarding /start, /help and consent capture | software-engineer | 2026-11-03 | bot,P0 | Consent stored with version |
| 36 | Admin skeleton with login and roles | software-engineer | 2026-11-03 | admin,P1 | Operator and editor roles |

## M2 Core product (8 Nov)

| # | Issue | Owner | Due | Labels | Done when |
|---|---|---|---|---|---|
| 4 | Collect menus, prices, portions (target 120 items) | ai-engineer | 2026-11-08 | data,P0 | Every item has source and last-verified date |
| 5 | Collect and clean reviews with consent (target 150) | ai-engineer | 2026-11-08 | data,P1 | Consent basis stored; names removed |
| 6 | Review tagging pipeline and precision report | ai-engineer | 2026-11-08 | data,P1 | Precision measured on 20% sample |
| 8 | Model comparison and decision record | ai-engineer | 2026-11-05 | ai,P0 | 2+ candidates scored; decision stored |
| 9 | Full-text retrieval over catalogue and reviews | ai-engineer | 2026-11-05 | retrieval,P0 | Golden-set recall target met |
| 10 | Recommendation scoring with explanations | ai-engineer | 2026-11-06 | ai,P0 | Each reason traces to stored rows |
| 12 | Groundedness validator (reject unreferenced prices) | ai-engineer | 2026-11-06 | safety,P0 | 0 unsupported price claims on test set |
| 13 | AI chat with read tools for /find | ai-engineer | 2026-11-06 | ai,P0 | Natural queries return grounded results |
| 14 | Review summaries from stored reviews only | ai-engineer | 2026-11-07 | ai,P1 | Counts and dates shown; no invented claims |
| 15 | propose_plan weekly planner with schema | ai-engineer | 2026-11-07 | ai,P0 | Within budget after backend recompute |
| 16 | Eval run 1 and fixes | ai-engineer | 2026-11-08 | eval,P0 | Report committed |
| 37 | /menu browse with inline keyboards and callback tokens | software-engineer | 2026-11-04 | bot,P0 | Callbacks single-use and user-bound |
| 38 | Ledger posting service with reservations and locking | software-engineer | 2026-11-05 | ledger,P0 | 50 parallel orders never overspend |
| 39 | Kora funding intent and collection flow (sandbox) | software-engineer | 2026-11-06 | payments,P0 | One credit per verified collection |
| 40 | /wallet and /fund end to end | software-engineer | 2026-11-06 | bot,payments,P0 | Underpayment and overpayment handled |
| 41 | /plan UI, plan persistence, recomputed totals | software-engineer | 2026-11-07 | bot,P0 | Totals computed by backend only |
| 42 | /settings limits, /orders, /pause | software-engineer | 2026-11-08 | bot,P0 | Pause blocks new reservations |
| 43 | Admin catalogue editing with provenance | software-engineer | 2026-11-08 | admin,P1 | Editor changes tracked |

## M3 Transactions and agent (14 Nov)

| # | Issue | Owner | Due | Labels | Done when |
|---|---|---|---|---|---|
| 17 | Policy interface contract with SW | ai-engineer | 2026-11-09 | contract,safety,P0 | Signed by both engineers |
| 18 | propose_order_action tool | ai-engineer | 2026-11-09 | ai,safety,P0 | Output is a proposal only |
| 19 | Complaint draft prompt and fact validator | ai-engineer | 2026-11-11 | ai,complaints,P0 | No fact outside the case record |
| 20 | Adversarial and injection test set | ai-engineer | 2026-11-12 | safety,P0 | 100% pass or feature disabled |
| 21 | pgvector decision note | ai-engineer | 2026-11-10 | retrieval,P2 | Yes or no with evidence |
| 22 | Stale and missing data alerts | ai-engineer | 2026-11-12 | data,P1 | Report visible in admin |
| 23 | Eval run 2 and regression fixes | ai-engineer | 2026-11-13 | eval,P0 | No regressions |
| 44 | Plan approval with consent record; policy service | software-engineer | 2026-11-09 | backend,safety,P0 | Blocks every listed bad case |
| 45 | BullMQ scheduler and scheduled order execution | software-engineer | 2026-11-10 | backend,P0 | Jobs survive restart |
| 46 | Price-change decision keyboard | software-engineer | 2026-11-10 | bot,P1 | Over-tolerance asks student |
| 47 | AI orchestration endpoints for all tools | software-engineer | 2026-11-11 | backend,ai,P0 | No tool can touch money |
| 48 | Kora payout adapter (resolve, balance, payout, idempotency) | software-engineer | 2026-11-11 | payments,P0 | Unique reference before call; no resend |
| 49 | Payout verification, uncertain-outcome handling, reconciliation v1 | software-engineer | 2026-11-12 | payments,P0 | SRS Section 17.3 table passes |
| 50 | Order and payment state machines; notifications | software-engineer | 2026-11-13 | backend,P0 | Illegal transitions rejected |
| 51 | Sandbox end-to-end run with simulated Prime step | software-engineer | 2026-11-13 | testing,P0 | Fund to payout confirmation recorded |

## M4 Prime and complaint workflows (16 Nov)

| # | Issue | Owner | Due | Labels | Done when |
|---|---|---|---|---|---|
| 24 | Case record builder spec for complaints | ai-engineer | 2026-11-15 | complaints,contract,P0 | SW implements from spec |
| 52 | Prime handoff packets and operator console | software-engineer | 2026-11-15 | prime,admin,P0 | Operator completes L0 flow without DB access |
| 53 | Prime confirmation recording (matched, accepted) | software-engineer | 2026-11-16 | prime,P0 | Separate states from payout |
| 54 | Complaint tickets, dispatch queue, escalation timers | software-engineer | 2026-11-16 | complaints,P0 | Ticket links order, checkout, Kora refs |
| 55 | Controlled real test with team funds (only with written consent) | software-engineer | 2026-11-16 | prime,payments,blocked-partner,P1 | Prime confirms match in writing, or documented as not done |

## M5 Testing and demo (21 Nov)

| # | Issue | Owner | Due | Labels | Done when |
|---|---|---|---|---|---|
| 25 | Red-team session and final evaluation | ai-engineer | 2026-11-17 | safety,P0 | Findings fixed or feature disabled |
| 26 | Demo script, seed data and slides (AI sections) | ai-engineer | 2026-11-19 | demo,P0 | Rehearsed twice |
| 56 | Security review and concurrency load test | software-engineer | 2026-11-17 | security,P0 | No open high findings |
| 57 | Backup restore rehearsal; feature flags default off | software-engineer | 2026-11-18 | infra,P0 | Restore tested |
| 58 | Demo environment, fallback video, architecture slides | software-engineer | 2026-11-19 | demo,P0 | Smoke test passes |
| 59 | Feature freeze 18 Nov 23:59 | software-engineer | 2026-11-18 | release,P0 | No merges except fixes after freeze |
| 60 | Shared: integration test script | software-engineer | 2026-11-17 | testing,P0 | Runs from staging bot to complaint |
| 61 | Public build posts (per calendar) | ai-engineer | 2026-11-21 | content,P2 | Each post has evidence and peer approval |

## Bulk creation snippet

```bash
# create labels and milestones first, then:
python3 - <<'PY'
import csv,subprocess
for r in csv.DictReader(open('github_issues.csv')):
    subprocess.run(['gh','issue','create','--title',r['title'],'--body','Owner: '+r['assignee_role']+'\nDue: '+r['due']+'\n\nDone when: '+r['acceptance'],'--label',r['labels']+','+r['assignee_role'],'--milestone',r['milestone']])
PY
```
