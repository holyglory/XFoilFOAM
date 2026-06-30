import { createClient } from "@aerodb/db";

// One pool for the lifetime of the server process.
const client = createClient({ max: 10 });
export const db = client.db;
export const sql = client.sql;
