import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

const connectionString = process.env.DATABASE_URL;

export const client = connectionString ? postgres(connectionString) : null;
export const db = client ? drizzle(client, { schema }) : null;
