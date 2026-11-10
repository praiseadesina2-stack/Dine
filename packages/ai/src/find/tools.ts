/**
 * Tool contract for the /find agent (issue #11). Every tool is read-only.
 * Arguments from the model are validated here, never trusted as-is.
 * Prices cross the model boundary in whole naira; storage stays in kobo.
 */
import type { FunctionDeclaration } from "@google/genai";
import type { Catalogue, MealRecord } from "./catalogue.js";

export const FINAL_ANSWER = "final_answer";

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "search_meals",
    description:
      "Search available meals across campus vendors. Use short food words (e.g. 'rice', 'chicken', 'shawarma'), not full sentences. Returns up to `limit` meals with their current price in naira. Call again with different words if results are thin.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Food keywords. Omit to browse by price only." },
        min_price_naira: { type: "integer", minimum: 0 },
        max_price_naira: { type: "integer", minimum: 0, description: "The user's budget ceiling for one meal." },
        vendor_id: { type: "string", description: "Restrict to one vendor (from list_vendors or a previous result)." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_vendor",
    description: "Get one vendor's full menu with prices in naira.",
    parametersJsonSchema: {
      type: "object",
      properties: { vendor_id: { type: "string" } },
      required: ["vendor_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_vendors",
    description: "List all vendors with a short description and their cheapest item.",
    parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: FINAL_ANSWER,
    description:
      "Reply to the user. Call exactly once when done. Picks must be meal_ids returned by search_meals or get_vendor in this conversation. Do NOT write prices in `message`; the app shows each pick's price itself.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "1-3 short, friendly sentences. No prices, no invented facts about taste, portion or reviews.",
        },
        picks: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              meal_id: { type: "string" },
              reason: { type: "string", description: "One short line tied to what the user asked for." },
            },
            required: ["meal_id", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["message", "picks"],
      additionalProperties: false,
    },
  },
];

export class ToolArgError extends Error {}

const optInt = (args: Record<string, unknown>, key: string, min: number, max: number): number | undefined => {
  const v = args[key];
  if (v == null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolArgError(`${key} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
};

const optStr = (args: Record<string, unknown>, key: string, maxLen = 120): string | undefined => {
  const v = args[key];
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolArgError(`${key} must be a string`);
  return v.slice(0, maxLen);
};

const reqStr = (args: Record<string, unknown>, key: string): string => {
  const v = optStr(args, key);
  if (!v) throw new ToolArgError(`${key} is required`);
  return v;
};

const naira = (kobo: number) => Math.round(kobo / 100);

const mealView = (m: MealRecord) => ({
  meal_id: m.mealId,
  name: m.name,
  vendor_id: m.vendorId,
  vendor_name: m.vendorName,
  price_naira: naira(m.priceKobo),
});

/**
 * Executes a read tool. Every meal shown to the model is passed to `onSeen`
 * so the grounding check knows which meals and prices are legitimate.
 */
export async function runReadTool(
  catalogue: Catalogue,
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  onSeen: (meals: MealRecord[]) => void,
): Promise<Record<string, unknown>> {
  const args = rawArgs ?? {};
  switch (name) {
    case "search_meals": {
      const min = optInt(args, "min_price_naira", 0, 1_000_000);
      const max = optInt(args, "max_price_naira", 0, 1_000_000);
      const meals = await catalogue.searchMeals({
        query: optStr(args, "query"),
        minPriceKobo: min != null ? min * 100 : undefined,
        maxPriceKobo: max != null ? max * 100 : undefined,
        vendorId: optStr(args, "vendor_id"),
        limit: optInt(args, "limit", 1, 20) ?? 10,
      });
      onSeen(meals);
      return { count: meals.length, meals: meals.map(mealView) };
    }
    case "get_vendor": {
      const vendor = await catalogue.getVendor(reqStr(args, "vendor_id"));
      if (!vendor) return { error: "vendor not found; use list_vendors for valid ids" };
      const meals = vendor.meals.filter((m) => m.available);
      onSeen(meals);
      return {
        vendor_id: vendor.vendorId,
        name: vendor.name,
        open: vendor.active,
        description: vendor.description,
        meals: meals.map(mealView),
      };
    }
    case "list_vendors": {
      const vendors = await catalogue.listVendors();
      return {
        vendors: vendors.map((v) => ({
          vendor_id: v.vendorId,
          name: v.name,
          open: v.active,
          description: v.description,
          meal_count: v.mealCount,
          cheapest_naira: v.cheapestKobo != null ? naira(v.cheapestKobo) : null,
        })),
      };
    }
    default:
      throw new ToolArgError(`unknown tool ${name}`);
  }
}
