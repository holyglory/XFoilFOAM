import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { authorizeProgressiveRemoteStart } from "../src/progressive-remote-start";
import { readProgressiveRemoteContinuation } from "../src/progressive-remote-continuation";

export async function verifyProgressiveRemoteStart(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  const input = {
    solverId: envelope.solverId,
    executionId: envelope.scope.executionId,
    contentSignature: envelope.contentSignature,
  };
  const [permission] = await db.execute(
    sql`SELECT can_push FROM sync_api_permissions WHERE data_type = 'polars'`,
  );
  const [campaign] = await db.execute(sql`
    SELECT campaign.id, campaign.status FROM sim_campaigns campaign
    JOIN progressive_generations generation ON generation.campaign_id = campaign.id
    WHERE generation.id = ${envelope.scope.generationId}::uuid
  `);
  const [state] = await db.execute(
    sql`SELECT enabled FROM sweeper_state WHERE id = 1`,
  );
  try {
    await db.execute(sql`INSERT INTO sync_api_permissions (data_type, can_push) VALUES ('polars', true)
      ON CONFLICT (data_type) DO UPDATE SET can_push = true`);
    expect(
      await authorizeProgressiveRemoteStart(db, {
        ...input,
        solverId: randomUUID(),
      }),
    ).toMatchObject({ kind: "stop" });
    await expect(
      authorizeProgressiveRemoteStart(db, {
        ...input,
        contentSignature: "0".repeat(64),
      }),
    ).rejects.toThrow("stored assignment");
    await db.execute(
      sql`UPDATE sweeper_state SET enabled = false WHERE id = 1`,
    );
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "wait",
    });
    await db.execute(sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`);
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'paused' WHERE id = ${campaign.id}::uuid`,
    );
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "wait",
    });
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${campaign.id}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_api_permissions SET can_push = false WHERE data_type = 'polars'`,
    );
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "wait",
      reason: expect.stringContaining("permission"),
    });
    await db.execute(
      sql`UPDATE sync_api_permissions SET can_push = true WHERE data_type = 'polars'`,
    );
    const decisions = await Promise.all([
      authorizeProgressiveRemoteStart(db, input),
      authorizeProgressiveRemoteStart(db, input),
    ]);
    expect(decisions[0]).toEqual(decisions[1]);
    const authorization = decisions[0];
    expect(authorization.kind).toBe("authorized");
    if (authorization.kind !== "authorized")
      throw new Error(authorization.reason);
    expect(Date.parse(authorization.expiresAt)).toBeGreaterThan(
      Date.parse(authorization.authorizedAt),
    );
    expect(
      Date.parse(authorization.expiresAt) -
        Date.parse(authorization.authorizedAt),
    ).toBeLessThanOrEqual(120000);
    const [unchanged] = await db.execute(sql`
      SELECT status, engine_job_id, request_payload FROM sim_jobs WHERE id = ${input.executionId}::uuid
    `);
    expect(unchanged.status).toBe("pending");
    expect(unchanged.engine_job_id).toBeNull();
    expect(
      (unchanged.request_payload as Record<string, unknown>).engineRequest,
    ).toEqual(envelope.request);
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "continue",
    });
    await db.execute(
      sql`UPDATE sweeper_state SET enabled = false WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'paused' WHERE id = ${campaign.id}::uuid`,
    );
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "continue",
    });
    await db.execute(sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`);
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${campaign.id}::uuid`,
    );
    const olderAuthorization = {
      ...authorization,
      authorizedAt: new Date(
        Date.parse(authorization.authorizedAt) - 180000,
      ).toISOString(),
      expiresAt: new Date(
        Date.parse(authorization.expiresAt) - 180000,
      ).toISOString(),
    };
    await db.execute(sql`UPDATE sim_jobs SET request_payload = jsonb_set(request_payload, '{remoteStartAuthorization}',
      ${JSON.stringify(olderAuthorization)}::jsonb) WHERE id = ${input.executionId}::uuid`);
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "continue",
    });
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "stop",
    });
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload = ${JSON.stringify(unchanged.request_payload)}::jsonb WHERE id = ${input.executionId}::uuid`,
    );
    await db.execute(sql`UPDATE sim_jobs SET request_payload = jsonb_set(request_payload, '{remoteStartAuthorization,expiresAt}',
      ${JSON.stringify(new Date(Date.now() + 3600000).toISOString())}::jsonb) WHERE id = ${input.executionId}::uuid`);
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "stop",
      reason: expect.stringContaining("original start authorization"),
    });
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "stop",
    });
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload = ${JSON.stringify(unchanged.request_payload)}::jsonb WHERE id = ${input.executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${campaign.id}::uuid`,
    );
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "stop",
      reason: expect.stringContaining("campaign"),
    });
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "stop",
    });
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${campaign.id}::uuid`,
    );
    await db.execute(sql`UPDATE sim_jobs SET request_payload = jsonb_set(request_payload, '{remoteStartAuthorization,expiresAt}',
      ${JSON.stringify(new Date(Date.now() - 1000).toISOString())}::jsonb) WHERE id = ${input.executionId}::uuid`);
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "stop",
      reason: expect.stringContaining("original start authorization"),
    });
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload = ${JSON.stringify(unchanged.request_payload)}::jsonb WHERE id = ${input.executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${envelope.promiseId}::uuid`,
    );
    expect(await authorizeProgressiveRemoteStart(db, input)).toMatchObject({
      kind: "stop",
    });
    expect(await readProgressiveRemoteContinuation(db, input)).toMatchObject({
      kind: "stop",
    });
  } finally {
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${campaign.id}::uuid`,
    );
    await db.execute(
      sql`UPDATE sweeper_state SET enabled = ${state.enabled} WHERE id = 1`,
    );
    if (permission)
      await db.execute(
        sql`UPDATE sync_api_permissions SET can_push = ${permission.can_push} WHERE data_type = 'polars'`,
      );
    else
      await db.execute(
        sql`DELETE FROM sync_api_permissions WHERE data_type = 'polars'`,
      );
  }
}
