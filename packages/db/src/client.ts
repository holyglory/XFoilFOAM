import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseUrl } from "./env";
import * as schema from "./schema";

export interface ClientOptions {
  url?: string;
  max?: number;
}

/** Create a postgres-js pool + Drizzle client. Caller owns `sql.end()`. */
export function createClient(opts: ClientOptions = {}) {
  const sql = postgres(opts.url ?? databaseUrl(), { max: opts.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type DB = ReturnType<typeof createClient>["db"];
export type Sql = ReturnType<typeof createClient>["sql"];
