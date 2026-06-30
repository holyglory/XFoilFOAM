import { createClient } from "./client";

// Drop and recreate runtime schemas. Drizzle keeps its migration ledger in a
// separate `drizzle` schema, so reset must remove it too or migrations will be
// incorrectly skipped after the public schema is dropped.
const { sql } = createClient({ max: 1 });
await sql`DROP SCHEMA IF EXISTS public CASCADE`;
await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
await sql`CREATE SCHEMA public`;
await sql.end();
console.log("✓ public schema reset");
