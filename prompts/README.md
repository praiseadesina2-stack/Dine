# Prompts

Every prompt the product sends to a model lives here, versioned. Code loads them with `loadPrompt()` from `packages/ai/src/prompts.ts`; nothing is hardcoded.

```
prompts/<agent>/<version>/<part>.md
```

| Agent | Versions | Parts |
|---|---|---|
| `find` | `v1` | `system.md` (has a `{{CLAIMS_RULE}}` slot), `claims-reviews.md`, `claims-no-reviews.md` |

## Rules

- **Never edit a released version.** Copy it to the next version and change the copy. Eval reports record the prompt version, so an edited version makes old reports wrong.
- Pick the version with an env var (`FIND_PROMPT_VERSION=v2`); the default in code is the last version that passed an eval run.
- A new version is promoted to default only after it scores at least as well on the eval set (`pnpm --filter @dine/ai eval:find`), with 0 unsupported claims and every adversarial case passing.
- Prompts contain no secrets, user data or prices.

## History

| Version | Date | Change | Eval |
|---|---|---|---|
| find/v1 | 10 Nov | First /find prompt (moved here unchanged from `find-agent.ts` on 11 Nov) | find-v0 run 1 |
