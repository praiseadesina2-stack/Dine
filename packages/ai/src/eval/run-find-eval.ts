/**
 * Run the /find evaluation set and write a scored report into packages/ai/evals/reports/.
 *
 *   pnpm --filter @dine/ai eval:find                       (model list from GEMINI_MODEL)
 *   pnpm --filter @dine/ai eval:find --model gemini-3.8-flash
 *   pnpm --filter @dine/ai eval:find --only pidgin         (cases whose id or tags contain "pidgin")
 *   pnpm --filter @dine/ai eval:find --no-reviews          (catalogue facts only)
 *   pnpm --filter @dine/ai eval:find --delay 5000 --retries 3
 *
 * Cases run one at a time, --delay ms apart (default 3000), to stay inside rate limits.
 * A case that gets no model answer (quota 429, 5xx, timeout) is re-run after a wait, up to
 * --retries times (default 2). Retries are counted in the report; a case that still gets no
 * answer is reported as "not tested", never as a pass. Uses the same catalogue and
 * review store as the /find CLI, so results reflect what the bot would answer.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VENDORS } from "../../../../apps/api/src/data/vendors.js";
import { loadReviewStore } from "../context/sources.js";
import type { MealRecord } from "../find/catalogue.js";
import { DEFAULT_PROMPT_VERSION, FindAgent, type FindResult } from "../find/find-agent.js";
import { primeCatalogue } from "../find/prime-catalogue.js";
import { gradeCase, type EvalCase, type Grade } from "./grade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const EVAL_DIR = path.resolve(__dirname, "../../evals");
const REPORT_DIR = path.join(EVAL_DIR, "reports");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const setName = flag("set") ?? "find-v0";
const only = flag("only");
const model = flag("model");
const useReviews = !argv.includes("--no-reviews");
const delayMs = Number(flag("delay") ?? 3000);
const maxRetries = Number(flag("retries") ?? 2);
const promptVersion = process.env.FIND_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No model answer at all: the case was not tested, so it is worth re-running. */
const isInfraFailure = (r: FindResult) => !r.ok && (r.reason === "model_error" || r.reason === "timeout");

/** Wait suggested by a Gemini 429 ("retryDelay": "37s"), else exponential back-off; capped at 90s. */
function retryWait(r: FindResult, attempt: number): number {
  const detail = r.ok ? "" : r.detail ?? "";
  const m = detail.match(/retryDelay\W+(\d+(?:\.\d+)?)s/i) ?? detail.match(/retry in (\d+(?:\.\d+)?)s/i);
  const suggested = m ? Number(m[1]) * 1000 + 1000 : 15_000 * 2 ** attempt;
  return Math.min(90_000, suggested);
}

interface Row {
  case: EvalCase;
  result: FindResult;
  grade: Grade;
  /** Times the case was re-run because the model gave no answer. */
  infraRetries: number;
}

async function main() {
  const set = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, `${setName}.json`), "utf8")) as { name: string; cases: EvalCase[] };
  const cases = set.cases.filter((c) => !only || c.id.includes(only) || c.tags.includes(only));

  const catalogue = primeCatalogue({ extraVendors: VENDORS });
  const allMeals = new Map<string, MealRecord>();
  for (const v of await catalogue.listVendors()) {
    for (const m of (await catalogue.getVendor(v.vendorId))!.meals) allMeals.set(m.mealId, m);
  }
  const reviews = useReviews ? loadReviewStore() : null;
  const agent = new FindAgent({ catalogue, reviews, model });
  if (!agent.isConfigured()) throw new Error("GEMINI_API_KEY is not set in .env");

  const rows: Row[] = [];
  for (const [i, c] of cases.entries()) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    let result = await agent.find(c.query);
    let infraRetries = 0;
    while (isInfraFailure(result) && infraRetries < maxRetries) {
      const wait = retryWait(result, infraRetries);
      console.log(`  ..  ${c.id}: ${(result as { reason: string }).reason}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      infraRetries++;
      result = await agent.find(c.query);
    }
    const grade = gradeCase(c, result, allMeals);
    rows.push({ case: c, result, grade, infraRetries });
    const picks = result.ok ? result.picks.map((p) => `${p.meal.name} (${p.meal.priceKobo / 100})`).join("; ") : `fallback: ${result.reason}`;
    const t = result.trace;
    console.log(`${grade.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(28)} ${t.ms}ms (${t.turns.length} turns, model ${t.modelMs}ms, tools ${t.toolMs}ms)  ${picks}`);
    for (const f of grade.failures) console.log(`        - ${f}`);
  }

  const report = summarise(set.name, rows);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const servedBy = [...new Set(rows.map((r) => r.result.trace.model).filter(Boolean))].join("+") || "none";
  const base = path.join(REPORT_DIR, `${set.name}_${stamp}_${servedBy.replace(/[^a-z0-9.+-]/gi, "_")}${useReviews ? "" : "_noreviews"}`);
  fs.writeFileSync(`${base}.md`, report.markdown);
  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        ...report.summary,
        cases: rows.map((r) => ({
          id: r.case.id,
          query: r.case.query,
          tags: r.case.tags,
          pass: r.grade.pass,
          failures: r.grade.failures,
          ok: r.result.ok,
          fallback: r.result.ok ? null : r.result.reason,
          message: r.result.ok ? r.result.message : null,
          picks: r.result.ok ? r.result.picks.map((p) => ({ meal_id: p.meal.mealId, name: p.meal.name, price_naira: p.meal.priceKobo / 100, reason: p.reason, review_ids: p.reviews.map((x) => x.reviewId) })) : [],
          model: r.result.trace.model,
          ms: r.result.trace.ms,
          model_ms: r.result.trace.modelMs,
          tool_ms: r.result.trace.toolMs,
          turns: r.result.trace.turns,
          input_tokens: r.result.trace.inputTokens,
          output_tokens: r.result.trace.outputTokens,
          rejections: r.result.trace.rejections,
          infra_retries: r.infraRetries,
          failed_model_calls: r.result.trace.attempts,
          tool_calls: r.result.trace.steps.map((s) => s.tool),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n${report.headline}\nReport: ${base}.md`);
}

function summarise(setName: string, rows: Row[]) {
  const n = rows.length;
  const passed = rows.filter((r) => r.grade.pass).length;
  const fallbacks = rows.filter((r) => !r.result.ok);
  const notTested = rows.filter((r) => isInfraFailure(r.result)).length;
  const tested = n - notTested;
  const infraRetries = rows.reduce((s, r) => s + r.infraRetries, 0);
  const unsupported = rows.reduce((s, r) => s + r.grade.unsupportedClaims.length, 0);
  const adversarial = rows.filter((r) => r.case.tags.includes("adversarial"));
  const advPassed = adversarial.filter((r) => r.grade.pass).length;
  const ms = rows.map((r) => r.result.trace.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0;
  const tokensIn = rows.reduce((s, r) => s + r.result.trace.inputTokens, 0);
  const tokensOut = rows.reduce((s, r) => s + r.result.trace.outputTokens, 0);
  const models = [...new Set(rows.map((r) => r.result.trace.model).filter(Boolean))];
  const repairs = rows.reduce((s, r) => s + r.result.trace.rejections.length, 0);
  const turnCounts = rows.map((r) => r.result.trace.turns.length).sort((a, b) => a - b);
  const turnPct = (p: number) => turnCounts[Math.min(turnCounts.length - 1, Math.floor(p * turnCounts.length))] ?? 0;
  const turnMs = rows.flatMap((r) => r.result.trace.turns.map((t) => t.ms)).sort((a, b) => a - b);
  const modelMsTotal = rows.reduce((s, r) => s + r.result.trace.modelMs, 0);
  const toolMsTotal = rows.reduce((s, r) => s + r.result.trace.toolMs, 0);
  const totalMs = rows.reduce((s, r) => s + r.result.trace.ms, 0);
  const share = (x: number) => (totalMs ? Math.round((x / totalMs) * 100) : 0);

  const byTag = new Map<string, { n: number; pass: number }>();
  for (const r of rows) for (const t of r.case.tags) {
    const b = byTag.get(t) ?? { n: 0, pass: 0 };
    b.n++;
    if (r.grade.pass) b.pass++;
    byTag.set(t, b);
  }

  const summary = {
    set: setName,
    run_at: new Date().toISOString(),
    models,
    prompt_version: `find/${promptVersion}`,
    reviews: useReviews,
    cases: n,
    passed,
    pass_rate: n ? passed / n : 0,
    not_tested: notTested,
    pass_rate_tested: tested ? passed / tested : 0,
    infra_retries: infraRetries,
    unsupported_claims: unsupported,
    adversarial_passed: `${advPassed}/${adversarial.length}`,
    fallbacks: fallbacks.length,
    fallback_reasons: Object.fromEntries(
      [...new Set(fallbacks.map((r) => (r.result as any).reason))].map((k) => [k, fallbacks.filter((r) => (r.result as any).reason === k).length]),
    ),
    grounding_repairs: repairs,
    latency_ms: { p50: pct(0.5), p90: pct(0.9), max: ms.at(-1) ?? 0 },
    latency_breakdown: {
      model_ms_share: share(modelMsTotal) / 100,
      tool_ms_share: share(toolMsTotal) / 100,
      model_turns_per_case: { avg: n ? +(turnCounts.reduce((s, x) => s + x, 0) / n).toFixed(2) : 0, p50: turnPct(0.5), max: turnCounts.at(-1) ?? 0 },
      ms_per_model_turn_p50: turnMs[Math.floor(turnMs.length / 2)] ?? 0,
    },
    tokens: { input: tokensIn, output: tokensOut, per_case_avg: n ? Math.round((tokensIn + tokensOut) / n) : 0 },
  };

  const headline = `${setName}: ${passed}/${n} passed (${notTested} not tested),${unsupported} unsupported claims, adversarial ${advPassed}/${adversarial.length}, ${fallbacks.length} fallbacks, p50 ${summary.latency_ms.p50}ms`;
  const md = [
    `# Eval report: ${setName}`,
    "",
    `Run ${summary.run_at} · model ${models.join(", ") || "none"} · prompt ${summary.prompt_version} · reviews ${useReviews ? "on" : "off"}`,
    "",
    "| Metric | Value | Target |",
    "|---|---|---|",
    `| Passed | ${passed}/${n} (${Math.round(summary.pass_rate * 100)}%) | |`,
    `| Not tested (no model answer after ${maxRetries} retries) | ${notTested} | 0 |`,
    `| Passed, of cases tested | ${passed}/${tested} (${Math.round(summary.pass_rate_tested * 100)}%) | |`,
    `| Infra retries (429 / 5xx / timeout re-runs) | ${infraRetries} | |`,
    `| Unsupported price/meal/review claims shipped | ${unsupported} | 0 |`,
    `| Adversarial cases passed | ${advPassed}/${adversarial.length} | 100% |`,
    `| Fallbacks | ${fallbacks.length} ${fallbacks.length ? JSON.stringify(summary.fallback_reasons) : ""} | |`,
    `| Grounding repairs (rejected then fixed or failed) | ${repairs} | |`,
    `| Latency p50 / p90 / max | ${summary.latency_ms.p50} / ${summary.latency_ms.p90} / ${summary.latency_ms.max} ms | |`,
    `| Time in model / tools / other | ${share(modelMsTotal)}% / ${share(toolMsTotal)}% / ${100 - share(modelMsTotal) - share(toolMsTotal)}% | |`,
    `| Model turns per case avg / p50 / max | ${summary.latency_breakdown.model_turns_per_case.avg} / ${summary.latency_breakdown.model_turns_per_case.p50} / ${summary.latency_breakdown.model_turns_per_case.max} | |`,
    `| Time per model turn p50 | ${summary.latency_breakdown.ms_per_model_turn_p50} ms | |`,
    `| Tokens in / out (avg per case) | ${tokensIn} / ${tokensOut} (${summary.tokens.per_case_avg}) | |`,
    "",
    "## By tag",
    "",
    "| Tag | Passed |",
    "|---|---|",
    ...[...byTag.entries()].sort().map(([t, b]) => `| ${t} | ${b.pass}/${b.n} |`),
    "",
    "## Cases",
    "",
    "| Case | Result | Picks | Failures |",
    "|---|---|---|---|",
    ...rows.map((r) => {
      const picks = r.result.ok ? r.result.picks.map((p) => `${p.meal.name} (₦${p.meal.priceKobo / 100})`).join("; ") || "none" : `fallback: ${r.result.reason}`;
      return `| \`${r.case.id}\` | ${r.grade.pass ? "pass" : "**fail**"} | ${esc(picks)} | ${esc(r.grade.failures.join("; "))} |`;
    }),
    "",
  ].join("\n");

  return { summary, headline, markdown: md };
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
