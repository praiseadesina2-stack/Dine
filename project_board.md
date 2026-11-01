# Dine: Project board structure

## Columns
| Column | Rule |
|---|---|
| Backlog | Triaged, sized, has one owner |
| Ready | All dependencies met; due date set |
| In progress | Max 3 per engineer |
| Blocked (partner) | Waiting on Kora, Prime or adviser; note who and since when |
| In review | The other engineer reviews within 12 hours |
| Verified in staging | Demonstrated to the other engineer |
| Done | Merged, tested, contracts updated |

## Fields
Owner (AI Engineer / Software Engineer), Milestone, Priority (P0 blocker, P1, P2), Size (S under 2h, M half day, L full day; split anything bigger), Due, Evidence label (Confirmed, Verified, Proposed, Assumption, To confirm), Public post? (yes/no).

## Milestones
| Milestone | Date | Exit checklist |
|---|---|---|
| M1 Foundations and discovery | 3 Nov | Repo, CI, bots; schema v1; 4 vendors; partner messages sent; onboarding |
| M2 Core product | 8 Nov | Browse, find, plan, settings; recommendations with reasons; sandbox funding; invariant tests |
| M3 Transactions and agent | 14 Nov | Approval, scheduled orders, sandbox payout and verification, state machine, AI proposals only |
| M4 Prime and complaint workflows | 16 Nov | Operator console, confirmations, failure states, complaint tickets |
| M5 Testing and demo | 21 Nov | Freeze 18 Nov; security; rehearsals; demo |

## Views
- By owner (each engineer sees only their work)
- Blocked-partner view reviewed in every daily sync
- Calendar view by due date
- Risk list view linked to SRS Section 29

## Rituals
Daily 15-minute sync; end-of-phase exit review against the checklist in SRS Section 26.1; scope changes after 14 Nov need both engineers to agree and one item dropped.
