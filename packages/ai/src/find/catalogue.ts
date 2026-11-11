/**
 * Read-only catalogue access for the /find agent.
 *
 * The agent only talks to the `Catalogue` interface. Today it is backed by the
 * Prime crawl (see prime-catalogue.ts); a Postgres implementation over
 * @dine/database (vendors, meals, reviews) can replace it without touching the
 * agent, tools or grounding check.
 */

export interface MealRecord {
  mealId: string;
  vendorId: string;
  vendorName: string;
  name: string;
  priceKobo: number;
  available: boolean;
}

export interface VendorRecord {
  vendorId: string;
  name: string;
  active: boolean;
  description?: string;
  meals: MealRecord[];
}

export interface VendorSummary {
  vendorId: string;
  name: string;
  active: boolean;
  description?: string;
  mealCount: number;
  cheapestKobo: number | null;
}

export interface SearchMealsInput {
  query?: string;
  minPriceKobo?: number;
  maxPriceKobo?: number;
  vendorId?: string;
  limit?: number;
}

export interface Catalogue {
  searchMeals(input: SearchMealsInput): Promise<MealRecord[]>;
  getMeal(mealId: string): Promise<MealRecord | null>;
  getVendor(vendorId: string): Promise<VendorRecord | null>;
  listVendors(): Promise<VendorSummary[]>;
}

/** A vendor and its menu, prices in whole naira. */
export interface SourceVendor {
  id: string;
  name: string;
  status: "active" | "closed";
  sampleDescription?: string;
  items: { name: string; price: number }[];
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export class InMemoryCatalogue implements Catalogue {
  private vendors = new Map<string, VendorRecord>();
  private meals = new Map<string, MealRecord>();

  constructor(source: SourceVendor[]) {
    for (const v of source) {
      const active = v.status === "active";
      const meals: MealRecord[] = v.items.map((item) => ({
        mealId: `${v.id}:${slug(item.name)}`,
        vendorId: v.id,
        vendorName: v.name,
        name: item.name,
        priceKobo: Math.round(item.price * 100),
        available: active,
      }));
      this.vendors.set(v.id, {
        vendorId: v.id,
        name: v.name,
        active,
        description: v.sampleDescription,
        meals,
      });
      for (const m of meals) this.meals.set(m.mealId, m);
    }
  }

  async searchMeals(input: SearchMealsInput): Promise<MealRecord[]> {
    const tokens = tokenize(input.query ?? "");
    const limit = input.limit ?? 10;
    const scored: { meal: MealRecord; score: number }[] = [];

    for (const meal of this.meals.values()) {
      if (!meal.available) continue;
      if (input.vendorId && meal.vendorId !== input.vendorId) continue;
      if (input.minPriceKobo != null && meal.priceKobo < input.minPriceKobo) continue;
      if (input.maxPriceKobo != null && meal.priceKobo > input.maxPriceKobo) continue;

      let score = 0;
      if (tokens.length) {
        const vendor = this.vendors.get(meal.vendorId);
        const nameTokens = new Set(tokenize(meal.name));
        const vendorTokens = new Set(tokenize(`${meal.vendorName} ${vendor?.description ?? ""}`));
        for (const t of tokens) {
          // prefix match so "kebab" hits "kebabs" and "chick" hits "chicken"
          if ([...nameTokens].some((n) => n.startsWith(t) || t.startsWith(n))) score += 2;
          else if ([...vendorTokens].some((n) => n.startsWith(t))) score += 1;
        }
        if (score === 0) continue;
      }
      scored.push({ meal, score });
    }

    scored.sort((a, b) => b.score - a.score || a.meal.priceKobo - b.meal.priceKobo);
    return scored.slice(0, limit).map((s) => s.meal);
  }

  async getMeal(mealId: string): Promise<MealRecord | null> {
    return this.meals.get(mealId) ?? null;
  }

  async getVendor(vendorId: string): Promise<VendorRecord | null> {
    return this.vendors.get(vendorId) ?? null;
  }

  async listVendors(): Promise<VendorSummary[]> {
    return [...this.vendors.values()].map((v) => ({
      vendorId: v.vendorId,
      name: v.name,
      active: v.active,
      description: v.description,
      mealCount: v.meals.length,
      cheapestKobo: v.meals.length ? Math.min(...v.meals.map((m) => m.priceKobo)) : null,
    }));
  }
}
