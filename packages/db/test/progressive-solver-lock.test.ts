import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveSolverOwnerLock } from "../src/progressive-solver-lock";

const owner = createClient({ max: 1 });
const observer = createClient({ max: 1 });
afterAll(async () => {
  await Promise.all([owner.sql.end(), observer.sql.end()]);
});

it("permits archive foreign keys while preserving admission, revocation and capacity serialization", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const parent = sql.identifier(`solver_lock_${suffix}`);
  const child = sql.identifier(`archive_lock_${suffix}`);
  const identity = randomUUID();
  await owner.db.execute(
    sql`CREATE TABLE ${parent}(id uuid PRIMARY KEY,budget integer NOT NULL,revoked_at timestamptz)`,
  );
  await owner.db.execute(
    sql`CREATE TABLE ${child}(solver_id uuid REFERENCES ${parent}(id))`,
  );
  await owner.db.execute(
    sql`INSERT INTO ${parent}(id,budget) VALUES(${identity}::uuid,96)`,
  );
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holding = owner.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT id FROM ${parent} WHERE id=${identity}::uuid ${progressiveSolverOwnerLock}`,
    );
    ready();
    await held;
  });
  try {
    await Promise.race([
      locked,
      holding.then(() => {
        throw new Error("Owner exited before lock acquisition");
      }),
    ]);
    await observer.db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout='1 second'`);
      await transaction.execute(
        sql`INSERT INTO ${child}(solver_id) VALUES(${identity}::uuid)`,
      );
    });
    for (const operation of [
      sql`SELECT id FROM ${parent} WHERE id=${identity}::uuid ${progressiveSolverOwnerLock}`,
      sql`UPDATE ${parent} SET budget=1 WHERE id=${identity}::uuid`,
      sql`UPDATE ${parent} SET revoked_at=clock_timestamp() WHERE id=${identity}::uuid`,
      sql`DELETE FROM ${parent} WHERE id=${identity}::uuid`,
    ]) {
      await expect(
        observer.db.transaction(async (transaction) => {
          await transaction.execute(
            sql`SET LOCAL lock_timeout='100 milliseconds'`,
          );
          await transaction.execute(operation);
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    }
    expect(
      await observer.db.execute(sql`SELECT budget,revoked_at FROM ${parent}`),
    ).toEqual([{ budget: 96, revoked_at: null }]);
    release();
    await holding;
    await observer.db.execute(
      sql`UPDATE ${parent} SET budget=40,revoked_at=clock_timestamp() WHERE id=${identity}::uuid`,
    );
    const [changed] = await observer.db.execute(
      sql`SELECT budget,revoked_at FROM ${parent}`,
    );
    expect(changed.budget).toBe(40);
    expect(changed.revoked_at).not.toBeNull();
  } finally {
    release();
    await holding;
    await owner.db.execute(sql`DROP TABLE ${child}`);
    await owner.db.execute(sql`DROP TABLE ${parent}`);
  }
}, 30_000);
