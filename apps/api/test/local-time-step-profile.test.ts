import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { sql as client } from "../src/db";

const originalAuth = process.env.ADMIN_AUTH_DISABLED;
const owned: string[] = [];
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  process.env.ADMIN_AUTH_DISABLED = "true";
  app = await buildServer();
});

afterAll(async () => {
  try {
    for (const id of owned.reverse()) {
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/admin/solver-profiles/${id}`,
      });
      expect(removed.statusCode).toBe(200);
    }
  } finally {
    await app.close();
    await client.end();
    if (originalAuth === undefined) delete process.env.ADMIN_AUTH_DISABLED;
    else process.env.ADMIN_AUTH_DISABLED = originalAuth;
  }
});

it("preserves an explicit numerical setting through create, copy, update and reload", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/admin/solver-profiles",
    payload: {
      name: `local-step-${randomUUID()}`,
      localTimeStepSmoothing: 0.2,
    },
  });
  expect(created.statusCode).toBe(201);
  const source = created.json();
  owned.push(source.id);
  expect(source.localTimeStepSmoothing).toBe(0.2);
  const cloned = await app.inject({
    method: "POST",
    url: "/api/admin/solver-profiles",
    payload: {
      ...source,
      slug: undefined,
      name: `local-step-copy-${randomUUID()}`,
    },
  });
  expect(cloned.statusCode).toBe(201);
  const copy = cloned.json();
  owned.push(copy.id);
  expect(copy.id).not.toBe(source.id);
  expect(copy.localTimeStepSmoothing).toBe(0.2);
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/admin/solver-profiles/${source.id}`,
    payload: { localTimeStepSmoothing: null },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().localTimeStepSmoothing).toBeNull();
  const reloaded = await app.inject({
    method: "GET",
    url: "/api/admin/simulation-setup",
  });
  expect(reloaded.statusCode).toBe(200);
  const rows = reloaded.json().solverProfiles;
  expect(
    rows.find((row: { id: string }) => row.id === source.id)
      .localTimeStepSmoothing,
  ).toBeNull();
  expect(
    rows.find((row: { id: string }) => row.id === copy.id)
      .localTimeStepSmoothing,
  ).toBe(0.2);
});

it.each([true, "0.2", -0.01, 1.01])(
  "rejects invalid local smoothing %s",
  async (value) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/solver-profiles",
      payload: {
        name: `local-step-invalid-${randomUUID()}`,
        localTimeStepSmoothing: value,
      },
    });
    if (response.statusCode === 201) owned.push(response.json().id);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  },
);
