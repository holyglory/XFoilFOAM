import { createClient } from "@aerodb/db";
import { EngineClient } from "@aerodb/engine-client";

export function makeContext() {
  const { db, sql } = createClient({ max: 4 });
  const engine = new EngineClient(process.env.ENGINE_URL ?? "http://localhost:8000");
  return { db, sql, engine };
}
