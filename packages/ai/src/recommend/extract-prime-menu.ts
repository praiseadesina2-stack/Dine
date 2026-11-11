/**
 * Builds data/prime-menu.json from the Prime bot crawl map page.
 *   pnpm --filter @dine/ai menu:extract ["../../Prime Bot Crawl Map.html"]
 *
 * The crawl page embeds its graph as <script type="application/json" id="data">.
 * Vendor menu pages list every item as "Name — ₦Price", including closed vendors,
 * so they are the source of truth; item detail pages only fill gaps.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PrimeMenu, PrimeVendor } from "./menu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve(process.argv[2] ?? path.join(__dirname, "../../../../Prime Bot Crawl Map.html"));
const output = path.join(__dirname, "data/prime-menu.json");

interface CrawlNode {
  k: string;
  label: string;
  vendor: string;
  grp: string;
  closed: boolean;
  text: string;
  price: string;
}

const html = fs.readFileSync(input, "utf8");
const json = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)?.[1];
if (!json) throw new Error(`No crawl data block found in ${input}`);
const crawl = JSON.parse(json) as { meta: { bot: string; at: string; run: string }; nodes: CrawlNode[] };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const naira = (s: string) => Number(s.replace(/[^\d]/g, ""));

// Vendor list pages carry the one-line "Sells ..." description.
const descriptions = new Map<string, string>();
for (const n of crawl.nodes.filter((n) => n.k === "vendorlist")) {
  for (const m of n.text.matchAll(/^(.+?) · (?:🟢|🔴) \w+\n(Sells .+)$/gm)) descriptions.set(m[1].trim(), m[2].trim());
}

const vendors = new Map<string, PrimeVendor>();
for (const n of crawl.nodes.filter((n) => n.k === "vendor")) {
  const v = vendors.get(n.vendor) ?? {
    id: slug(n.vendor),
    name: n.vendor,
    location: n.grp === "in" ? "inside_cafeteria" : "outside_cafeteria",
    open: !n.closed,
    description: descriptions.get(n.vendor) ?? "",
    items: [],
  };
  for (const m of n.text.matchAll(/^(.+?) — ₦([\d,]+)\s*$/gm)) {
    const name = m[1].trim();
    if (!v.items.some((i) => i.name === name)) v.items.push({ name, price: naira(m[2]) });
  }
  vendors.set(n.vendor, v);
}
for (const n of crawl.nodes.filter((n) => n.k === "item")) {
  const v = vendors.get(n.vendor);
  if (v && !v.items.some((i) => i.name === n.label) && naira(n.price) > 0) v.items.push({ name: n.label, price: naira(n.price) });
}

const menu: PrimeMenu = {
  source: { bot: crawl.meta.bot, crawledAt: crawl.meta.at, run: crawl.meta.run },
  vendors: [...vendors.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(menu, null, 2) + "\n");
const items = menu.vendors.reduce((s, v) => s + v.items.length, 0);
console.log(`Wrote ${menu.vendors.length} vendors, ${items} items (crawled ${menu.source.crawledAt}) to ${output}`);
