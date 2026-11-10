import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as users from "./schema.js";
import * as catalogue from "./catalogue.js";

export * from "./schema.js";
export * from "./catalogue.js";

const schema = { ...users, ...catalogue };

const connectionString = process.env.DATABASE_URL;

export const client = connectionString ? postgres(connectionString) : null;
export const db = client ? drizzle(client, { schema }) : null;
