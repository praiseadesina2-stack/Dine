/**
 * Lists how every Prime menu item is understood. Exits 1 if any item is unknown.
 *   pnpm --filter @dine/ai menu:check [--all]
 */
import { loadPrimeMenu } from "./menu.js";
import { parseItem, profileOf } from "./profile.js";

const all = process.argv.includes("--all");
let unknown = 0;
for (const v of loadPrimeMenu().vendors) {
  if (all) console.log(`\n${v.name}${v.open ? "" : " (closed)"}`);
  for (const item of v.items) {
    const parsed = parseItem(v.name, item.name, item.price);
    if (parsed.role === "unknown") unknown++;
    if (!all && parsed.role !== "unknown") continue;
    const p = profileOf(parsed.parts, parsed.minHeat);
    const parts = parsed.parts.map((x) => `${x.component}×${+x.qty.toFixed(2)}`).join(" + ");
    console.log(
      `  ${parsed.role.padEnd(9)} ₦${String(item.price).padEnd(5)} ${item.name.padEnd(48)} ${parts.padEnd(55)} ` +
        `P${p.proteinG.toFixed(0)} F${p.fibreG.toFixed(0)} ${p.kcal.toFixed(0)}kcal heat${p.heat} sweet${p.sweet.toFixed(1)}`,
    );
  }
}
console.log(unknown ? `\n${unknown} item(s) not understood; add a rule in profile.ts` : "\nAll items understood.");
process.exit(unknown ? 1 : 0);
