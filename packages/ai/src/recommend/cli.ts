/**
 * Try the recommender from the terminal:
 *   pnpm --filter @dine/ai recommend --budget 2500 --goals protein_rich --cravings spicy
 *   pnpm --filter @dine/ai recommend --mode timetable --days mon,tue,wed --meals 3 --budget 2000 --goals healthy
 *   pnpm --filter @dine/ai recommend --budget 2000 --note "allergic to groundnut, no sausage" [--no-model] [--json]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { recommend } from "./index.js";
import type { Craving, Day, Goal, MealSuggestion, RecommendRequest } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = <T extends string>(name: string) => (flag(name)?.split(",").map((s) => s.trim()).filter(Boolean) ?? []) as T[];

const req: RecommendRequest = {
  mode: flag("mode") === "timetable" ? "timetable" : "now",
  days: list<Day>("days"),
  mealsPerDay: Number(flag("meals") ?? 3) as 1 | 2 | 3,
  goals: list<Goal>("goals"),
  cravings: list<Craving>("cravings"),
  budgetPerMeal: Number(flag("budget") ?? 2000),
  note: flag("note"),
  seed: Number(flag("seed") ?? 0),
};

const fmt = (m: MealSuggestion, indent = "  ") =>
  [
    `${indent}${m.name}${m.orderable ? `  [${m.orderLabel} · ${m.vendorName}] ₦${m.totalPrice}` : ""}`,
    ...(m.orderable ? [`${indent}  ${m.items.map((i) => `${i.name} ₦${i.price}`).join(" + ")}`] : []),
    `${indent}  ${m.reasons.join("; ")}`,
    `${indent}  est. ${m.estimates.proteinG} g protein, ${m.estimates.fibreG} g fibre, ${m.estimates.kcal} kcal, heat ${m.estimates.heat} (${m.estimates.confidence})`,
    ...m.warnings.map((w) => `${indent}  ! ${w}`),
  ].join("\n");

async function main() {
    // --at 19:30 sets the time of day (Lagos) for "now" mode
  const at = flag("at");
  const now = at ? new Date(`2026-11-10T${at.padStart(5, "0")}:00+01:00`) : undefined;
  const result = await recommend(req, { useModel: !argv.includes("--no-model"), now });
  if (argv.includes("--json")) return console.log(JSON.stringify(result, null, 2));
  if (result.note.parsedBy !== "none") console.log("Note understood as:", JSON.stringify(result.note), "\n");
  if (result.mode === "now") result.options.forEach((o, i) => console.log(`${i + 1}.\n${fmt(o)}\n`));
  else
    for (const d of result.days) {
      console.log(`== ${d.day}`);
      for (const m of d.meals) console.log(`${m.slot}:\n${m.pick ? fmt(m.pick) : "  (nothing fits)"}\n  alternatives: ${m.alternatives.map((a) => `${a.name}${a.orderable ? " [Dine]" : ""}`).join(" | ") || "none"}`);
      console.log();
    }
  for (const n of result.notices) console.log(`* ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
