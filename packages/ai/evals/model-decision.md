# Model decision (issue #8), 14 Nov

**Decision: `gemini-3.5-flash-lite` first, `gemini-3.8-flash` as the fallback.** Set by `GEMINI_MODEL=gemini-3.5-flash-lite,gemini-3.8-flash` (also the default in code: `DEFAULT_MODEL` in `src/find/find-agent.ts`, and the note reader in `src/recommend/note.ts`). Thinking level `LOW` (`FIND_THINKING_LEVEL`).

## Evidence (reports in `evals/reports/`)

| | gemini-3.5-flash-lite | gemini-3.8-flash |
|---|---|---|
| find-v0 (26 cases), prompt v2, 14 Nov | 25/26, 0 unsupported claims, adversarial 4/4 (`find-v0_2026-11-14-14-01-05`) | not run end to end |
| find-adv-v1 (22 injection and adversarial cases) | 22/22 (`find-adv-v1_2026-11-14-14-03-36`) | not run |
| Time per model turn, p50 | ~1.3 s | over 20 s per call when reached as fallback on 11 and 14 Nov (timed out) |
| Latency per request, p50 / p90 | 2.0 s / 8.9 s (find-v0); 1.6 s / 3.3 s (adversarial) | |
| Tokens per request (in + out) | ~6.5k | |

## Why

- flash-lite answers fast enough for a Telegram chat and passes every safety case; quality is enforced by code (grounding check, exact catalogue reads), not by a bigger model.
- flash stays as the fallback for flash-lite outages (429 quota, 5xx). It is slow in practice, so every request is capped at 20 s in total; past that the bot answers in keyword mode with the pre-searched meals.
- Once a model answers, a conversation stays on it (Gemini thought signatures don't carry across models).

## Revisit when

- flash-lite's pass rate on find-v0 drops below the last report, or any adversarial case fails;
- the free-tier quota (429s) becomes the main cause of fallbacks in production: move to a paid tier before switching models.
