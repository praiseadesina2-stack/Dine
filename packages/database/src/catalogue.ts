import {
  pgTable, uuid, text, boolean, integer, smallint, real, bigserial,
  timestamp, index, check, customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";


const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const vendors = pgTable("vendors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  locationText: text("location_text"),
  servesDinner: boolean("serves_dinner").default(true).notNull(),
  active: boolean("active").default(true).notNull(),

  sourceType: text("source_type").notNull(), 
  sourceRef: text("source_ref"),
  collectedBy: text("collected_by").notNull(),
  collectedAt: ts("collected_at").defaultNow().notNull(),
  lastVerifiedAt: ts("last_verified_at").notNull(),
});

export const meals = pgTable(
  "meals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
    name: text("name").notNull(),
    category: text("category"),
    description: text("description"),
    portionNote: text("portion_note"),
    dietaryTags: text("dietary_tags").array().default(sql`'{}'::text[]`).notNull(), // preferences only, never health data
    priceKobo: integer("price_kobo").notNull(),
    isDinner: boolean("is_dinner").default(true).notNull(),
    available: boolean("available").default(true).notNull(),
    availabilityNote: text("availability_note"),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    collectedBy: text("collected_by").notNull(),
    collectedAt: ts("collected_at").defaultNow().notNull(),
    lastVerifiedAt: ts("last_verified_at").notNull(),
    search: tsvector("search"),
  },
  (t) => [
    index("meals_vendor_id_idx").on(t.vendorId),
    check("meals_price_positive", sql`${t.priceKobo} > 0`),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mealId: uuid("meal_id").references(() => meals.id),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    text: text("text").notNull(),
    rating: smallint("rating"),
    consentBasis: text("consent_basis"), // a review is only shown if this is set
    anonymised: boolean("anonymised").default(false).notNull(),
    sourceRef: text("source_ref"),
    collectedBy: text("collected_by").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("reviews_meal_id_idx").on(t.mealId),
    check("reviews_rating_range", sql`${t.rating} between 1 and 5`),
  ],
);

export const reviewTags = pgTable(
  "review_tags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reviewId: uuid("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(), // taste | portion | affordability | quality | service | hygiene | speed
    polarity: text("polarity").notNull(), // positive | negative | neutral
    confidence: real("confidence").notNull(),
    tagger: text("tagger").notNull(), // human | model
    modelVersion: text("model_version"),
    reviewed: boolean("reviewed").default(false).notNull(),
  },
  (t) => [
    index("review_tags_review_id_idx").on(t.reviewId),
    check("review_tags_confidence_range", sql`${t.confidence} between 0 and 1`),
  ],
);