/**
 * The /find agent's catalogue.
 *
 * Primary source: the Prime crawl (real menus and prices, see
 * recommend/data/prime-menu.json). Only main dishes are offered as meals;
 * extras (a spoon of sauce, one egg) and packaging never are.
 *
 * Vendors that joined Prime after the crawl come from `extraVendors` (the
 * caller passes the bot's vendor list). A vendor already in the crawl is never
 * taken from there. The item classifier only has rules for crawled menus, so
 * for these vendors every item except packaging is kept until rules exist
 * (see `pnpm --filter @dine/ai menu:check`).
 *
 * Open/closed in the crawl is a snapshot from crawl time, so every vendor is
 * treated as open unless the caller passes live status.
 */
import { loadPrimeMenu, type PrimeMenu } from "../recommend/menu.js";
import { parseItem } from "../recommend/profile.js";
import { InMemoryCatalogue, type SourceVendor } from "./catalogue.js";

export interface PrimeCatalogueOptions {
  menu?: PrimeMenu;
  /** Vendors not in the crawl, e.g. apps/api/src/data/vendors.ts. */
  extraVendors?: SourceVendor[];
  isVendorOpen?: (vendorId: string) => boolean;
}

const sameVendor = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

export function primeSourceVendors(opts: PrimeCatalogueOptions = {}): SourceVendor[] {
  const menu = opts.menu ?? loadPrimeMenu();
  const status = (id: string): SourceVendor["status"] =>
    !opts.isVendorOpen || opts.isVendorOpen(id) ? "active" : "closed";

  const crawled: SourceVendor[] = menu.vendors.map((v) => ({
    id: v.id,
    name: v.name,
    status: status(v.id),
    sampleDescription: v.description,
    items: v.items.filter((i) => parseItem(v.name, i.name, i.price).role === "main"),
  }));

  const known = new Set(crawled.flatMap((v) => [v.id, sameVendor(v.name)]));
  const extra: SourceVendor[] = (opts.extraVendors ?? [])
    .filter((v) => !known.has(v.id) && !known.has(sameVendor(v.name)))
    .map((v) => ({
      id: v.id,
      name: v.name,
      status: status(v.id),
      sampleDescription: v.sampleDescription,
      items: v.items.filter((i) => parseItem(v.name, i.name, i.price).role !== "packaging"),
    }));

  return [...crawled, ...extra];
}

export function primeCatalogue(opts: PrimeCatalogueOptions = {}): InMemoryCatalogue {
  return new InMemoryCatalogue(primeSourceVendors(opts));
}
