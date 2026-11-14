# Prompts

Every prompt the product sends to a model lives here, versioned. Code loads them with `loadPrompt()` from `packages/ai/src/prompts.ts`; nothing is hardcoded.

```
prompts/<agent>/<version>/<part>.md
```

| Agent | Versions | Parts |
|---|---|---|
| `find` | `v1`, `v2` (default) | `system.md` (has a `{{CLAIMS_RULE}}` slot), `claims-reviews.md`, `claims-no-reviews.md` |

## Rules

- **Never edit a released version.** Copy it to the next version and change the copy. Eval reports record the prompt version, so an edited version makes old reports wrong.
- Pick the version with an env var (`FIND_PROMPT_VERSION=v2`); the default in code is the last version that passed an eval run.
- A new version is promoted to default only after it scores at least as well on the eval set (`pnpm --filter @dine/ai eval:find`), with 0 unsupported claims and every adversarial case passing.
- Prompts contain no secrets, user data or prices.

## History

| Version | Date | Change | Eval |
|---|---|---|---|
| find/v1 | 10 Nov | First /find prompt (moved here unchanged from `find-agent.ts` on 11 Nov) | find-v0 run 1 |
| find/v2 | 14 Nov | Default. Uses the automatic first lookups (pre-search meals and reviews) and answers straight away when they fit; asks for several lookups in one turn; keeps taste words out of `message`; picks from returned meals instead of answering with none | find-v0 14 Nov 13:27: 24/26 (24/24 tested, 2 not tested on API timeouts), 0 unsupported, adversarial 4/4, 1.54 turns/case (v1: ~6.75) |
