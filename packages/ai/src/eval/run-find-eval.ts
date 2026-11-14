/**
 * Run the /find evaluation set and write a scored report into packages/ai/evals/reports/.
 *
 *   pnpm --filter @dine/ai eval:find                       (model list from GEMINI_MODEL)
 *   pnpm --filter @dine/ai eval:find --model gemini-3.8-flash
 *   pnpm --filter @dine/ai eval:find --only pidgin         (cases whose id or tags contain "pidgin")
 *   pnpm --filter @dine/ai eval:find --no-reviews          (catalogue facts only)
 *
 * Cases run one at a time to stay inside rate limits. Uses the same catalogue and
 * review store as the /find CLI, so results reflect what the bot would answer.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VENDORS } from "../../../../apps/api/src/data/vendors.js";
import { loadReviewStore } from "../context/sources.js";
import type { MealRecord } from "../find/catalogue.js";
import { FindAgent, type FindResult } from "../find/find-agent.js";
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

interface Row {
  case: EvalCase;
  result: FindResult;
  grade: Grade;
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
  for (const c of cases) {
    const result = await agent.find(c.query);
    const grade = gradeCase(c, result, allMeals);
    rows.push({ case: c, result, grade });
    const picks = result.ok ? result.picks.map((p) => `${p.meal.name} (${p.meal.priceKobo / 100})`).join("; ") : `fallback: ${result.reason}`;
    console.log(`${grade.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(28)} ${result.trace.ms}ms  ${picks}`);
    for (const f of grade.failures) console.log(`        - ${f}`);
  }

  const report = summarise(set.name, rows);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
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
          input_tokens: r.result.trace.inputTokens,
          output_tokens: r.result.trace.outputTokens,
          rejections: r.result.trace.rejections.length,
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
  const unsupported = rows.reduce((s, r) => s + r.grade.unsupportedClaims.length, 0);
  const adversarial = rows.filter((r) => r.case.tags.includes("adversarial"));
  const advPassed = adversarial.filter((r) => r.grade.pass).length;
  const ms = rows.map((r) => r.result.trace.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0;
  const tokensIn = rows.reduce((s, r) => s + r.result.trace.inputTokens, 0);
  const tokensOut = rows.reduce((s, r) => s + r.result.trace.outputTokens, 0);
  const models = [...new Set(rows.map((r) => r.result.trace.model).filter(Boolean))];
  const repairs = rows.reduce((s, r) => s + r.result.trace.rejections.length, 0);

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
    reviews: useReviews,
    cases: n,
    passed,
    pass_rate: n ? passed / n : 0,
    unsupported_claims: unsupported,
    adversarial_passed: `${advPassed}/${adversarial.length}`,
    fallbacks: fallbacks.length,
    fallback_reasons: Object.fromEntries(
      [...new Set(fallbacks.map((r) => (r.result as any).reason))].map((k) => [k, fallbacks.filter((r) => (r.result as any).reason === k).length]),
    ),
    grounding_repairs: repairs,
    latency_ms: { p50: pct(0.5), p90: pct(0.9), max: ms.at(-1) ?? 0 },
    tokens: { input: tokensIn, output: tokensOut, per_case_avg: n ? Math.round((tokensIn + tokensOut) / n) : 0 },
  };

  const headline = `${setName}: ${passed}/${n} passed, ${unsupported} unsupported claims, adversarial ${advPassed}/${adversarial.length}, ${fallbacks.length} fallbacks, p50 ${summary.latency_ms.p50}ms`;
  const md = [
    `# Eval report: ${setName}`,
    "",
    `Run ${summary.run_at} · model ${models.join(", ") || "none"} · reviews ${useReviews ? "on" : "off"}`,
    "",
    "| Metric | Value | Target |",
    "|---|---|---|",
    `| Passed | ${passed}/${n} (${Math.round(summary.pass_rate * 100)}%) | |`,
    `| Unsupported price/meal/review claims shipped | ${unsupported} | 0 |`,
    `| Adversarial cases passed | ${advPassed}/${adversarial.length} | 100% |`,
    `| Fallbacks | ${fallbacks.length} ${fallbacks.length ? JSON.stringify(summary.fallback_reasons) : ""} | |`,
    `| Grounding repairs (rejected then fixed or failed) | ${repairs} | |`,
    `| Latency p50 / p90 / max | ${summary.latency_ms.p50} / ${summary.latency_ms.p90} / ${summary.latency_ms.max} ms | |`,
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
