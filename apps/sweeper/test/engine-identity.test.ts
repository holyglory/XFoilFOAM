import { FOUNDATION_14_SOLVER_IMPLEMENTATION_ID, type DB } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  ENGINE_IDENTITY_MISMATCH_CODE,
  EngineClient,
  FOUNDATION_OPENFOAM_14_ENGINE,
  LEGACY_OPENCFD_2406_ENGINE,
  OPENCFD_2606_ENGINE,
  engineIdentityKey,
  engineNumericalCompatibilityKey,
  isEngineRuntimeIdentity,
  liveWorkerConsumesExecutionPool,
  openFoamEngineIdentity,
  type EngineRuntimeIdentity,
  type PolarRequest,
} from "@aerodb/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { engineIdentityForSetup } from "../src/build-request";
import {
  requireExecutionPoolForSetup,
  SolverExecutionPoolUnavailableError,
} from "../src/engine-pool";

function runtime(
  identity = FOUNDATION_OPENFOAM_14_ENGINE,
): EngineRuntimeIdentity {
  return {
    ...identity,
    build_id: "build-14-a",
    source_revision: "8c9f7a1",
    application_source_sha256: "b".repeat(64),
    package_sha256: "a".repeat(64),
    architecture: "x86_64",
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function poolDb(
  pools: Array<{
    id: string;
    solverImplementationId: string;
    routingKey: string;
    capacityKind: string;
    capacityLimit: number | null;
  }>,
): DB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => pools,
        }),
      }),
    }),
  } as unknown as DB;
}

afterEach(() => vi.unstubAllGlobals());

describe("engine identity contract", () => {
  it("keeps handshake identity stricter than numerical compatibility", () => {
    const adapter2 = {
      ...FOUNDATION_OPENFOAM_14_ENGINE,
      adapter_contract_version: 2,
    };
    expect(engineIdentityKey(adapter2)).not.toBe(
      engineIdentityKey(FOUNDATION_OPENFOAM_14_ENGINE),
    );
    expect(engineNumericalCompatibilityKey(adapter2)).toBe(
      engineNumericalCompatibilityKey(FOUNDATION_OPENFOAM_14_ENGINE),
    );
  });

  it("uses OpenCFD 2606 for new OpenFOAM identities and client submissions", async () => {
    expect(openFoamEngineIdentity("opencfd")).toEqual(OPENCFD_2606_ENGINE);

    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({
          job_id: "opencfd-2606-job",
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
          requested_engine: OPENCFD_2606_ENGINE,
          requested_execution_pool: "openfoam-opencfd-2606",
          execution_pool: null,
          engine: null,
        });
      }),
    );

    const client = new EngineClient("http://engine.test");
    expect(client.expectedEngine).toEqual(OPENCFD_2606_ENGINE);
    await client.submitPolar({ airfoil: {}, aoa: {} } as PolarRequest);
    expect(sent[0]?.expected_engine).toEqual(OPENCFD_2606_ENGINE);
  });

  it("resolves an immutable setup engine and defaults only missing legacy snapshots to OpenCFD 2406", () => {
    expect(engineIdentityForSetup({} as SimulationSetupSnapshot)).toEqual(
      LEGACY_OPENCFD_2406_ENGINE,
    );
    expect(
      engineIdentityForSetup({
        engine: {
          implementationId: "2f8bc764-09ae-4ff3-8fd2-001400000001",
          key: "openfoam:foundation:14:adapter-v1:numerics-v1",
          family: "openfoam",
          distribution: "foundation",
          releaseVersion: "14",
          methodFamily: "rans-urans-cfd",
          adapterContractVersion: 1,
          numericsRevision: "1",
        },
      } as SimulationSetupSnapshot),
    ).toEqual(FOUNDATION_OPENFOAM_14_ENGINE);
  });

  it("routes per request and accepts a pending logical acknowledgement before a worker runtime exists", async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({
          job_id: "foundation-job",
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
          requested_engine: FOUNDATION_OPENFOAM_14_ENGINE,
          requested_execution_pool: "openfoam-foundation-14",
          execution_pool: null,
          engine: null,
        });
      }),
    );
    // The client defaults to current OpenCFD, but an immutable Foundation
    // setup owns this request. A global pin must never reject or overwrite it.
    const client = new EngineClient("http://engine.test");
    await client.submitPolar({
      airfoil: {},
      aoa: {},
      expected_engine: FOUNDATION_OPENFOAM_14_ENGINE,
      expected_execution_pool: "openfoam-foundation-14",
    } as PolarRequest);
    expect(sent[0]?.expected_engine).toEqual(FOUNDATION_OPENFOAM_14_ENGINE);
    expect(sent[0]?.expected_execution_pool).toBe("openfoam-foundation-14");
  });

  it("requires the actual running worker runtime and execution-pool acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          job_id: "foundation-job",
          state: "running",
          total_cases: 1,
          completed_cases: 0,
          requested_engine: FOUNDATION_OPENFOAM_14_ENGINE,
          requested_execution_pool: "openfoam-foundation-14",
          execution_pool: "openfoam-foundation-14",
          engine: runtime(),
        }),
      ),
    );
    const client = new EngineClient("http://gateway.test");
    await expect(
      client.getJob("foundation-job", {
        expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE,
        expectedExecutionPool: "openfoam-foundation-14",
      }),
    ).resolves.toMatchObject({ state: "running", engine: runtime() });
  });

  it("rejects label-only or partially malformed runtime provenance", () => {
    const valid = runtime();
    expect(isEngineRuntimeIdentity(valid)).toBe(true);
    expect(
      isEngineRuntimeIdentity({
        ...FOUNDATION_OPENFOAM_14_ENGINE,
        build_id: "label-only",
      }),
    ).toBe(false);
    expect(
      isEngineRuntimeIdentity({
        ...valid,
        image_digest: "sha256:not-a-digest",
      }),
    ).toBe(false);
  });

  it("never lets a gateway logical inventory stand in for a running worker runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          job_id: "foundation-job",
          state: "running",
          total_cases: 1,
          completed_cases: 0,
          supported_engines: [FOUNDATION_OPENFOAM_14_ENGINE],
          requested_engine: FOUNDATION_OPENFOAM_14_ENGINE,
          requested_execution_pool: "openfoam-foundation-14",
          execution_pool: "openfoam-foundation-14",
          engine: null,
        }),
      ),
    );
    const client = new EngineClient("http://gateway.test");
    await expect(
      client.getJob("foundation-job", {
        expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE,
        expectedExecutionPool: "openfoam-foundation-14",
      }),
    ).rejects.toMatchObject({ code: ENGINE_IDENTITY_MISMATCH_CODE });
  });

  it("fails closed when Foundation 14 is answered by OpenCFD or by a legacy response with no identity", async () => {
    const client = new EngineClient("http://engine.test", {
      expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({
            job_id: "wrong-job",
            state: "pending",
            total_cases: 1,
            completed_cases: 0,
            requested_engine: FOUNDATION_OPENFOAM_14_ENGINE,
            requested_execution_pool: "openfoam-foundation-14",
            engine: runtime(LEGACY_OPENCFD_2406_ENGINE),
          }),
        )
        .mockResolvedValueOnce(
          response({
            job_id: "unknown-job",
            state: "pending",
            total_cases: 1,
            completed_cases: 0,
          }),
        ),
    );
    for (let i = 0; i < 2; i += 1) {
      await expect(
        client.submitPolar({
          airfoil: {},
          aoa: {},
          expected_engine: FOUNDATION_OPENFOAM_14_ENGINE,
          expected_execution_pool: "openfoam-foundation-14",
        } as PolarRequest),
      ).rejects.toMatchObject({
        code: ENGINE_IDENTITY_MISMATCH_CODE,
      });
    }
  });

  it("accepts a logical gateway inventory without misrepresenting it as runtime provenance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          status: "ok",
          version: "gateway",
          supported_engines: [
            OPENCFD_2606_ENGINE,
            FOUNDATION_OPENFOAM_14_ENGINE,
          ],
        }),
      ),
    );
    const client = new EngineClient("http://gateway.test", {
      expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE,
    });
    await expect(
      client.healthDetails({ expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE }),
    ).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("accepts the exact logical adapter descriptor returned by gateway capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          default_engine: OPENCFD_2606_ENGINE,
          supported_engines: [FOUNDATION_OPENFOAM_14_ENGINE],
          engines: [
            {
              engine: FOUNDATION_OPENFOAM_14_ENGINE,
              routing_key: "openfoam-foundation-14",
              analysis_methods: ["openfoam.rans", "openfoam.urans"],
              steady: true,
              transient: true,
              volume_fields: true,
              mesh_evidence: true,
              stored_media: true,
              custom_field_rendering: true,
              multi_element_geometry: false,
              supported_turbulence_models: ["kOmegaSST"],
              supported_image_fields: ["pressure"],
            },
          ],
        }),
      ),
    );
    const client = new EngineClient("http://gateway.test");
    await expect(
      client.capabilities({ expectedEngine: FOUNDATION_OPENFOAM_14_ENGINE }),
    ).resolves.toMatchObject({
      engines: [
        {
          routing_key: "openfoam-foundation-14",
        },
      ],
    });
  });

  it("requires fresh exact live-worker queue binding evidence for pool availability", () => {
    const queue = {
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
      worker_queues: [
        {
          worker: "foundation@worker-14",
          queues: ["openfoam-foundation-14"],
          execution_pool: "openfoam-foundation-14",
          engine: runtime(),
        },
      ],
      worker_queues_error: null,
    };
    expect(
      liveWorkerConsumesExecutionPool(
        queue,
        "openfoam-foundation-14",
        FOUNDATION_OPENFOAM_14_ENGINE,
      ),
    ).toBe(true);
    expect(
      liveWorkerConsumesExecutionPool(
        queue,
        "celery",
        LEGACY_OPENCFD_2406_ENGINE,
      ),
    ).toBe(false);
    expect(
      liveWorkerConsumesExecutionPool(
        {
          ...queue,
          worker_queues: [
            {
              worker: "wrong-engine@foundation-route",
              queues: ["openfoam-foundation-14"],
              execution_pool: "openfoam-foundation-14",
              engine: runtime(LEGACY_OPENCFD_2406_ENGINE),
            },
          ],
        },
        "openfoam-foundation-14",
        FOUNDATION_OPENFOAM_14_ENGINE,
      ),
    ).toBe(false);
    expect(
      liveWorkerConsumesExecutionPool(
        { ...queue, worker_queues_error: "inspector unavailable" },
        "openfoam-foundation-14",
        FOUNDATION_OPENFOAM_14_ENGINE,
      ),
    ).toBe(false);
    expect(
      liveWorkerConsumesExecutionPool(
        { ...queue, worker_runtime_error: "runtime inspect unavailable" },
        "openfoam-foundation-14",
        FOUNDATION_OPENFOAM_14_ENGINE,
      ),
    ).toBe(false);
  });

  it("rejects target workers that also consume another execution route", () => {
    const binding = {
      worker: "opencfd@worker-2606",
      execution_pool: "openfoam-opencfd-2606",
      engine: runtime(OPENCFD_2606_ENGINE),
    };
    const queue = {
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
      worker_queues_error: null,
      worker_runtime_error: null,
    };

    expect(
      liveWorkerConsumesExecutionPool(
        {
          ...queue,
          worker_queues: [
            {
              ...binding,
              queues: ["openfoam-opencfd-2606", "celery"],
            },
          ],
        },
        "openfoam-opencfd-2606",
        OPENCFD_2606_ENGINE,
      ),
    ).toBe(false);
    expect(
      liveWorkerConsumesExecutionPool(
        {
          ...queue,
          worker_queues: [
            {
              ...binding,
              queues: [
                "openfoam-opencfd-2606",
                "openfoam-foundation-14",
              ],
            },
          ],
        },
        "openfoam-opencfd-2606",
        OPENCFD_2606_ENGINE,
      ),
    ).toBe(false);
  });

  it("admits a setup only through its one enabled implementation-owned pool", async () => {
    const setup = {
      engine: {
        implementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
      },
    } as SimulationSetupSnapshot;
    const pool = {
      id: "3f8bc764-09ae-4ff3-8fd2-001400000001",
      solverImplementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
      routingKey: "openfoam-foundation-14",
      capacityKind: "cpu_slots",
      capacityLimit: null,
    };
    await expect(
      requireExecutionPoolForSetup(poolDb([pool]), setup),
    ).resolves.toEqual(pool);
    await expect(
      requireExecutionPoolForSetup(poolDb([]), setup),
    ).rejects.toBeInstanceOf(SolverExecutionPoolUnavailableError);
    await expect(
      requireExecutionPoolForSetup(
        poolDb([pool, { ...pool, id: crypto.randomUUID() }]),
        setup,
      ),
    ).rejects.toMatchObject({ code: "engine_pool_unavailable" });
  });
});
