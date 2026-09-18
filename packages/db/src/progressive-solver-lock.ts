import { sql } from "drizzle-orm";

export const progressiveSolverOwnerLock = sql`FOR NO KEY UPDATE`;
