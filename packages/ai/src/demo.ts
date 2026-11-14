/**
 * Rehearsal check: print what the bot would say to each demo persona
 * (packages/ai/demo/personas.json): their weekly dinner plan and their /find replies.
 *
 *   pnpm --filter @dine/ai demo                 (all personas, model on)
 *   pnpm --filter @dine/ai demo ada-budget      (one persona)
 *   pnpm --filter @dine/ai demo --no-model      (keyword mode, as during an outage)
 *
 * Nothing here orders, pays or writes anywhere.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VENDORS } from "../../../apps/api/src/data/vendors.js";
import { loadReviewStore } from "./context/sources.js";
import { FindAgent, formatFindResult } from "./find/find-agent.js";
import { primeCatalogue } from "./find/prime-catalogue.js";
import { nextMonday, planWeek, validateProfile, type PreferenceProfile } from "./plan/planner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

interface Persona { id: string; name: string; story: string; profile: PreferenceProfile; messages: string[] }

const args = process.argv.slice(2);
const noModel = args.includes("--no-model");
const only = args.find((a) => !a.startsWith("--"));
const { personas } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../demo/personas.json"), "utf8")) as { personas: Persona[] };

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

async function main() {
  const catalogue = primeCatalogue({ extraVendors: VENDORS });
  if (noModel) {
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER_API_KEY;
  }
  const agent = new FindAgent({ catalogue, reviews: loadReviewStore() });
  const week = nextMonday();
  let problems = 0;

  for (const p of personas.filter((x) => !only || x.id === only)) {
    console.log(`\n=== ${p.name} (${p.id}): ${p.story}`);
    const bad = validateProfile(p.profile);
    if (bad.length) {
      problems++;
      console.log(`  PROFILE INVALID: ${bad.join("; ")}`);
      continue;
    }

    const plan = await planWeek(p.profile, week, { catalogue });
    console.log(`\n-- Dinner plan, week of ${week} (budget ${naira(p.profile.budget_per_dinner_kobo)} per dinner)`);
    let total = 0;
    for (const it of plan.proposal?.items ?? []) {
      const meal = (await catalogue.getMeal(it.meal_id))!;
      total += meal.priceKobo;
      console.log(`  ${it.day.toUpperCase()}  ${meal.name} (${meal.vendorName}) - ${naira(meal.priceKobo)}  · ${it.reason}`);
      for (const c of plan.cautions[it.day] ?? []) console.log(`        ⚠ ${c}`);
    }
    if (plan.proposal) console.log(`  Total: ${naira(total)}`);
    for (const n of plan.notices) console.log(`  Note: ${n}`);
    if (!plan.proposal || plan.unfilled.length) problems++;

    for (const m of p.messages) {
      const r = await agent.find(m);
      const tag = r.ok ? `${r.trace.model}, ${r.trace.ms}ms` : `keyword mode: ${r.reason}`;
      console.log(`\n-- ${p.name}: ${m}\n   [${tag}]`);
      console.log(formatFindResult(r).split("\n").map((l) => `   ${l}`).join("\n"));
      if (!r.ok && !noModel) problems++;
    }
  }
  console.log(problems ? `\n${problems} problem(s): check the output above before rehearsing.` : "\nAll personas look ready.");
  process.exitCode = problems ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
