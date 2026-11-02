import { VENDORS, Vendor, MenuItem } from "../data/vendors.js";

export type BudgetBracket = "under_1000" | "1000_2000" | "2000_3500" | "any";

export type CravingType =
  | "filling"
  | "protein"
  | "snack"
  | "sweet"
  | "spicy"
  | "surprise";

export interface Recommendation {
  badge: string; // e.g. "🥇 Top Pick", "🥈 Smart Value", "🥉 Alternative Vibe"
  title: string;
  vendorName: string;
  vendorId: string;
  price: number;
  reason: string;
  itemName: string;
}

const CRAVING_KEYWORDS: Record<CravingType, string[]> = {
  filling: [
    "rice",
    "pack",
    "yamarita",
    "burrito",
    "boli",
    "chips",
    "pizza",
    "burger",
    "spaghetti"
  ],
  protein: [
    "chicken",
    "kebab",
    "beef",
    "fish",
    "suya",
    "egg",
    "ponmo",
    "meat",
    "turkey"
  ],
  snack: [
    "chips",
    "bread",
    "warmer",
    "sausage",
    "burger",
    "waffles",
    "shawarma"
  ],
  sweet: [
    "parfait",
    "milkshake",
    "waffles",
    "fruit",
    "apple",
    "orange",
    "pawpaw",
    "syrup"
  ],
  spicy: [
    "pepper",
    "suya",
    "spicy",
    "boli",
    "stew"
  ],
  surprise: []
};

export function getBudgetLimits(bracket: BudgetBracket): { min: number; max: number; label: string } {
  switch (bracket) {
    case "under_1000":
      return { min: 0, max: 1000, label: "Under ₦1,000" };
    case "1000_2000":
      return { min: 1000, max: 2000, label: "₦1,000 – ₦2,000" };
    case "2000_3500":
      return { min: 2000, max: 3500, label: "₦2,000 – ₦3,500" };
    case "any":
    default:
      return { min: 0, max: 10000, label: "Any Budget" };
  }
}

export function recommendMeals(
  budgetInput: BudgetBracket | number,
  craving: CravingType,
  seedOffset: number = 0
): Recommendation[] {
  let min = 0;
  let max = 10000;

  if (typeof budgetInput === "number") {
    max = budgetInput;
    min = Math.max(0, budgetInput - 1200);
  } else {
    const limits = getBudgetLimits(bracketToBudget(budgetInput));
    min = limits.min;
    max = limits.max;
  }

  const keywords = CRAVING_KEYWORDS[craving] || [];

  interface Candidate {
    vendor: Vendor;
    item: MenuItem;
    score: number;
    matchTag: string;
  }

  const candidates: Candidate[] = [];

  for (const vendor of VENDORS) {
    if (vendor.status !== "active") continue; // only active vendors

    for (const item of vendor.items) {
      if (item.price > max) continue;
      let score = 5;

      if (item.price >= min && item.price <= max) {
        score += 10;
      }

      const lowerName = item.name.toLowerCase();
      let matchedTag = "";

      if (craving === "surprise") {
        score += Math.floor(Math.random() * 10);
        matchedTag = "Campus Favorite";
      } else {
        for (const kw of keywords) {
          if (lowerName.includes(kw)) {
            score += 15;
            matchedTag = kw.charAt(0).toUpperCase() + kw.slice(1);
            break;
          }
        }
      }

      if (score >= 10) {
        candidates.push({
          vendor,
          item,
          score,
          matchTag: matchedTag || "Campus Choice"
        });
      }
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score || b.item.price - a.item.price);

  if (candidates.length === 0) {
    // Fallback: search all active items under max
    for (const vendor of VENDORS) {
      if (vendor.status !== "active") continue;
      for (const item of vendor.items) {
        if (item.price <= max + 500) {
          candidates.push({
            vendor,
            item,
            score: 5,
            matchTag: "Quick Available"
          });
        }
      }
    }
  }

  // Rotate offset if user clicks Reroll
  const startIdx = (seedOffset * 3) % Math.max(candidates.length, 1);
  const sliced = candidates.slice(startIdx, startIdx + 8);
  const selected: Candidate[] = [];

  // Pick unique vendors if possible
  const seenVendors = new Set<string>();
  for (const c of sliced) {
    if (!seenVendors.has(c.vendor.id) && selected.length < 3) {
      seenVendors.add(c.vendor.id);
      selected.push(c);
    }
  }

  // If we couldn't get 3 from unique vendors, fill up
  for (const c of sliced) {
    if (selected.length < 3 && !selected.includes(c)) {
      selected.push(c);
    }
  }

  const roleBadges = [
    { badge: "🥇 Top Pick", role: "Best match for your craving & budget" },
    { badge: "🥈 Smart Value", role: "Great portion and value for your money" },
    { badge: "🥉 Alternative Vibe", role: "Delicious alternative option" }
  ];

  return selected.map((cand, idx) => {
    const badgeInfo = roleBadges[idx] || { badge: "⭐ Extra Pick", role: "Recommended choice" };
    return {
      badge: badgeInfo.badge,
      title: `${cand.item.name} (${cand.vendor.name})`,
      vendorName: cand.vendor.name,
      vendorId: cand.vendor.id,
      itemName: cand.item.name,
      price: cand.item.price,
      reason: `${badgeInfo.role}. Vendor is active right now.`
    };
  });
}

function bracketToBudget(bracket: string): BudgetBracket {
  if (bracket === "under_1000" || bracket === "1000_2000" || bracket === "2000_3500" || bracket === "any") {
    return bracket;
  }
  return "1000_2000";
}
