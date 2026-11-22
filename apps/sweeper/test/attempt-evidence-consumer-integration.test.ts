import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { buildPolarFit, classifyPolarEvidence } from "@aerodb/core";
import { createClient, type DB } from "@aerodb/db/client";
import { registerAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import {
  readPolarAttemptEvidenceForConsumerProof,
  refreshPolarCacheForRevision,
} from "@aerodb/db/polar-cache";
import { attemptEvidenceColdCohortSql } from "@aerodb/db/attempt-evidence-consumers";
import { readAttemptEvidenceText } from "@aerodb/db/attempt-evidence-reader";
import {
  getAttemptEvidenceStorage,
  getAttemptEvidenceStoragePolicy,
  restoreAttemptEvidence,
  setAttemptEvidenceStoragePolicy,
} from "@aerodb/db/attempt-evidence-projection";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import {
  airfoils,
  boundaryConditions,
  categories,
  flowConditions,
  fieldColorScales,
  mediums,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  resultFieldExtents,
  resultMedia,
  resultMediaRepairs,
  results,
  simJobs,
  simulationPresets,
  solverEvidenceArtifacts,
  sweepDefinitions,
} from "@aerodb/db/schema";
import { readApiAttemptEvidenceForApp } from "../../api/src/attempt-evidence-reader";
import { env as apiEnv } from "../../api/src/env";
import {
  writeAttemptEvidenceCopy,
  readAttemptEvidenceCopy,
} from "../src/attempt-evidence-archive";
import { AttemptEvidenceStore } from "../src/attempt-evidence-store";
import {
  createAttemptEvidenceSettlementDependencies,
  settleAttemptEvidenceHistory,
} from "../src/attempt-evidence-settlement";
import { sweeperAttemptEvidenceDependencyVerifier } from "../src/attempt-evidence-consumer-reader";
import { publishRepairedResultAttempt } from "../src/ingest";

// This suite enables the database's global shortening policy.
describe.skipIf(process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB !== "1")(
  "settled attempt consumers under 0208",
  () => {
    const client = createClient({ max: 3 });
    const db = client.db;
    const prefix = `attempt-consumers-${randomUUID().slice(0, 12)}`;
    const own: Record<string, string> = {};
    const histories = new Map<number, { id: string; resultId: string }>();
    const selected = new Map<number, { id: string; resultId: string }>();
    const paths = new Map<string, string>();
    let directory = "";
    let policy: Awaited<ReturnType<typeof getAttemptEvidenceStoragePolicy>>;
    const priorBucket = apiEnv.evidenceBucket;
    const priorRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    const priorEvidenceBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
    let readSpy: MockInstance<AttemptEvidenceStore["read"]>;
    let activeProofTransactions = 0;
    let archiveReads = 0;

    function steadyHistory(alpha: number) {
      const sample = (i: number, seed: number) =>
        (Math.imul(i + seed, 2654435761) >>> 0) / 0x100000000;
      return {
        iterations: Array.from({ length: 1800 }, (_, i) => i + 1),
        cl: Array.from({ length: 1800 }, (_, i) =>
          Number((alpha / 10 + sample(i, 3) / 100).toFixed(9)),
        ),
        cd: Array.from({ length: 1800 }, (_, i) =>
          Number((0.02 + sample(i, 29) / 1000).toFixed(9)),
        ),
        cm: Array.from({ length: 1800 }, (_, i) =>
          Number((-0.03 + sample(i, 97) / 1000).toFixed(9)),
        ),
        mean_stable: alpha !== -4,
        window: { start_iter: 1200, end_iter: 1800 },
        note: "synthetic settled history fixture",
      };
    }

    beforeAll(async () => {
      directory = await mkdtemp(
        join(tmpdir(), "attempt-consumer-integration-"),
      );
      policy = await getAttemptEvidenceStoragePolicy(db);
      await setAttemptEvidenceStoragePolicy(db, {
        enabled: true,
        consumerContractVersion: 1,
      });
      apiEnv.evidenceBucket = "consumer-fixture";
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "consumer-fixture";
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
      readSpy = vi
        .spyOn(AttemptEvidenceStore.prototype, "read")
        .mockImplementation(async (identity, signal) => {
          expect(
            activeProofTransactions,
            "archive read must precede the verifier's SQL transaction",
          ).toBe(0);
          archiveReads++;
          const path = paths.get(identity.attemptId);
          if (!path) throw new Error("missing immutable fixture object");
          return readAttemptEvidenceCopy(createReadStream(path), identity, {
            signal,
          });
        });
      const [medium] = await db
        .select({ id: mediums.id })
        .from(mediums)
        .where(eq(mediums.slug, "air"));
      if (!medium) throw new Error("Seeded air medium is required");
      const [category] = await db
        .insert(categories)
        .values({ slug: prefix, name: prefix, path: prefix, depth: 0 })
        .returning({ id: categories.id });
      own.category = category.id;
      const [foil] = await db
        .insert(airfoils)
        .values({
          slug: prefix,
          name: prefix,
          categoryId: category.id,
          source: "test",
          points: [
            { x: 1, y: 0 },
            { x: 0.5, y: 0.07 },
            { x: 0, y: 0 },
            { x: 0.5, y: -0.07 },
            { x: 1, y: 0 },
          ],
        })
        .returning({ id: airfoils.id });
      own.foil = foil.id;
      const [bc] = await db
        .insert(boundaryConditions)
        .values({
          slug: prefix,
          name: prefix,
          mediumId: medium.id,
          reynolds: 179853,
        })
        .returning({ id: boundaryConditions.id });
      own.bc = bc.id;
      const [flow] = await db
        .insert(flowConditions)
        .values({
          slug: prefix,
          name: prefix,
          mediumId: medium.id,
          speedMps: 23.197853,
        })
        .returning({ id: flowConditions.id });
      own.flow = flow.id;
      const [reference] = await db
        .insert(referenceGeometryProfiles)
        .values({ slug: prefix, name: prefix, referenceLengthM: 0.11397853 })
        .returning({ id: referenceGeometryProfiles.id });
      own.reference = reference.id;
      const [sweep] = await db
        .insert(sweepDefinitions)
        .values({ slug: prefix, name: prefix, aoaList: [-4, -2, 0, 2, 4] })
        .returning({ id: sweepDefinitions.id });
      own.sweep = sweep.id;
      const [profiles] = await db.execute(sql`SELECT
    (SELECT id FROM boundary_profiles WHERE slug='standard-airfoil-boundary') AS boundary,
    (SELECT id FROM mesh_profiles WHERE slug='standard-airfoil-cgrid') AS mesh,
    (SELECT id FROM solver_profiles WHERE slug='standard-airfoil-komega-sst') AS solver,
    (SELECT id FROM scheduling_profiles WHERE slug='campaign-auto') AS scheduling,
    (SELECT id FROM output_profiles WHERE slug='standard-airfoil-fields') AS output`);
      if (Object.values(profiles).some((value) => typeof value !== "string"))
        throw new Error("Seeded runtime profiles are required");
      const [preset] = await db
        .insert(simulationPresets)
        .values({
          slug: prefix,
          name: prefix,
          flowConditionId: flow.id,
          referenceGeometryProfileId: reference.id,
          sweepDefinitionId: sweep.id,
          legacyBoundaryConditionId: bc.id,
          boundaryProfileId: String(profiles.boundary),
          meshProfileId: String(profiles.mesh),
          solverProfileId: String(profiles.solver),
          schedulingProfileId: String(profiles.scheduling),
          outputProfileId: String(profiles.output),
          enabled: false,
        })
        .returning({ id: simulationPresets.id });
      own.preset = preset.id;
      const setup = await ensureSimulationPresetRevision(db, preset.id);
      if (!setup) throw new Error("Exact setup revision is required");
      own.revision = setup.revision.id;
      for (const label of ["selected", "historical"]) {
        const [job] = await db
          .insert(simJobs)
          .values({
            airfoilId: foil.id,
            simulationPresetRevisionId: own.revision,
            bcIds: [bc.id],
            referenceChordM: 0.11397853,
            status: "done",
            engineState: "completed",
            requestPayload: { testFixture: prefix },
            ingestedAt: new Date(),
            finishedAt: new Date(),
          })
          .returning({ id: simJobs.id });
        own[label] = job.id;
      }
      for (const alpha of [-4, -2, 0, 2, 4]) {
        const cl = alpha / 10 + 0.1,
          cd = 0.02 + (alpha * alpha) / 10000,
          cm = -0.03;
        const [cell] = await db
          .insert(results)
          .values({
            airfoilId: foil.id,
            bcId: bc.id,
            simulationPresetRevisionId: own.revision,
            aoaDeg: alpha,
            status: "done",
            source: "solved",
            regime: "rans",
            fidelity: "rans",
            cl,
            cd,
            cm,
            clCd: cl / cd,
            converged: true,
            solvedAt: new Date(),
          })
          .returning({ id: results.id });
        for (const label of ["selected", "historical"]) {
          const [attempt] = await db
            .insert(resultAttempts)
            .values({
              resultId: cell.id,
              airfoilId: foil.id,
              bcId: bc.id,
              simulationPresetRevisionId: own.revision,
              aoaDeg: alpha,
              status: "done",
              source: "solved",
              regime: "rans",
              unsteady: false,
              cl,
              cd,
              cm,
              clCd: cl / cd,
              converged: label === "selected",
              stalled: label === "historical",
              validForPolar: label === "selected" || alpha !== -4,
              simJobId: own[label],
              engineJobId: `${prefix}-${label}`,
              engineCaseSlug: `alpha-${alpha}`,
              evidencePayload: {
                fidelity: "rans",
                mesh_recovery_version: 1,
                ...(label === "historical"
                  ? { steady_history: steadyHistory(alpha) }
                  : {}),
              },
              solvedAt: new Date(),
            })
            .returning({ id: resultAttempts.id });
          (label === "selected" ? selected : histories).set(alpha, {
            id: attempt.id,
            resultId: cell.id,
          });
          const base = `${prefix}/${attempt.id}`;
          const manifest = Buffer.from(
            JSON.stringify({
              fixture: prefix,
              resultId: cell.id,
              resultAttemptId: attempt.id,
            }),
          );
          await mkdir(join(directory, base), { recursive: true });
          await writeFile(join(directory, base, "manifest.json"), manifest);
          await db.insert(solverEvidenceArtifacts).values({
            resultId: cell.id,
            resultAttemptId: attempt.id,
            airfoilId: foil.id,
            simJobId: own[label],
            engineJobId: `${prefix}-${label}`,
            engineCaseSlug: `alpha-${alpha}`,
            aoaDeg: alpha,
            kind: "manifest",
            storageKey: `${base}/manifest.json`,
            mimeType: "application/json",
            sha256: createHash("sha256").update(manifest).digest("hex"),
            byteSize: manifest.length,
            metadata: { evidenceBase: base },
          });
          if (label === "selected")
            await db
              .update(results)
              .set({ currentResultAttemptId: attempt.id })
              .where(eq(results.id, cell.id));
        }
      }
      const fitted = await refreshPolarCacheForRevision(
        db,
        foil.id,
        own.revision,
      );
      expect(fitted.fitSetId).toBeTruthy();
    }, 60_000);

    async function copy(alpha: number) {
      const attempt = histories.get(alpha)!;
      const source = await loadSettledAttemptEvidenceCopy(db, attempt.id);
      const path = join(directory, `${attempt.id}.json.gz`);
      const proof = await writeAttemptEvidenceCopy(path, source);
      paths.set(attempt.id, path);
      const identity = {
        ...proof,
        sourceInstance: "server-consumer-fixture",
        bucket: "consumer-fixture",
        objectKey: `attempt-evidence/v1/server-consumer-fixture/${attempt.id}/${proof.sourceSha256}/${proof.storedSha256}.json.gz`,
        generation: "18446744073709551615",
        verifiedAt: new Date(),
      };
      const { archive } = await registerAttemptEvidenceArchive(
        db,
        identity,
        prepareAttemptEvidenceCopy(source),
      );
      return { source, archive };
    }

    async function snapshot() {
      const rows =
        await db.execute(sql`SELECT id,current_result_attempt_id,cl,cd,cm,status,source,regime,"updatedAt"
    FROM results WHERE airfoil_id=${own.foil}::uuid ORDER BY aoa_deg`);
      const fits =
        await db.execute(sql`SELECT id,status,evidence_signature,accepted_point_count,provisional_point_count,rejected_point_count,
    ldmax,alpha_ldmax,cdmin,clmax,cm0 FROM polar_fit_sets WHERE airfoil_id=${own.foil}::uuid AND is_current ORDER BY id`);
      const points =
        await db.execute(sql`SELECT p.fit_set_id,p.aoa_deg,p.cl,p.cd,p.cm,p.cl_cd FROM polar_fit_points p
    JOIN polar_fit_sets f ON f.id=p.fit_set_id WHERE f.airfoil_id=${own.foil}::uuid AND f.is_current ORDER BY f.id,p.aoa_deg`);
      const compatibility =
        await db.execute(sql`SELECT id,evidence_signature,status,ldmax,clmax FROM polar_compatibility_fit_sets
    WHERE airfoil_id=${own.foil}::uuid AND is_current ORDER BY id`);
      return {
        rows: [...rows],
        fits: [...fits],
        points: [...points],
        compatibility: [...compatibility],
      };
    }

    it.each([
      [0, "accepted"],
      [-4, "rejected"],
    ] as const)(
      "preserves the %s-degree %s attempt, fitted curves and selected points through shortening and restore",
      async (alpha, state) => {
        const readsBefore = archiveReads;
        const attempt = histories.get(alpha)!;
        const { source, archive } = await copy(alpha);
        const before = await snapshot();
        expect(before.points.length).toBeGreaterThan(3);
        expect(
          before.rows.find((row) => row.id === attempt.resultId)
            ?.current_result_attempt_id,
        ).toBe(selected.get(alpha)!.id);
        const sourcePoints = await readPolarAttemptEvidenceForConsumerProof(
          db,
          own.foil,
          own.revision,
          own.historical,
        );
        const beforeClassification = classifyPolarEvidence(sourcePoints);
        const beforeFit = buildPolarFit(beforeClassification.classifications);
        expect(
          beforeClassification.classifications.find(
            (point) => point.evidence.a === alpha,
          )?.state,
        ).toBe(state);
        expect(beforeFit.acceptedPointCount).toBe(4);
        expect(beforeFit.rejectedPointCount).toBe(1);
        expect(
          beforeClassification.classifications.find(
            (point) => point.evidence.a === -4,
          )?.reasons,
        ).toContain("not-converged");
        expect(beforeFit.points.length).toBeGreaterThan(3);
        const [eligibility] =
          await db.execute(sql`SELECT ${attemptEvidenceColdCohortSql(sql`a`)} AS eligible,
    attempt_evidence_shortening_limiter(a.id,${archive.id}::uuid) AS limiter FROM result_attempts a WHERE id=${attempt.id}::uuid`);
        expect(eligibility).toMatchObject({ eligible: true, limiter: null });
        const proofDb = new Proxy(db, {
          get(target, key) {
            if (key !== "transaction") return Reflect.get(target, key, target);
            return (...args: Parameters<DB["transaction"]>) =>
              target.transaction(async (tx) => {
                activeProofTransactions++;
                try {
                  return await args[0](tx);
                } finally {
                  activeProofTransactions--;
                }
              }, args[1]);
          },
        });
        const deps = createAttemptEvidenceSettlementDependencies(
          db,
          (request) => readApiAttemptEvidenceForApp(db, request),
        );
        deps.verifyDependencies =
          sweeperAttemptEvidenceDependencyVerifier(proofDb);
        const measurement = await settleAttemptEvidenceHistory(db, deps, {
          attemptId: attempt.id,
          archiveId: archive.id,
        });
        expect(measurement).toMatchObject({
          attemptId: attempt.id,
          archiveId: archive.id,
        });
        expect(measurement.payloadBytesReclaimed).toBeGreaterThan(0);
        expect(measurement.netValueBytesReclaimed).toBeGreaterThanOrEqual(
          policy!.minNetValueBytes,
        );
        const [cold] = await db
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.id, attempt.id));
        expect(cold.evidenceArchiveId).toBe(archive.id);
        expect(cold.validForPolar).toBe(state === "accepted");
        expect(cold.evidencePayload).toMatchObject({
          steady_history: { mean_stable: alpha !== -4 },
        });
        expect(
          (cold.evidencePayload as { steady_history: unknown }).steady_history,
        ).not.toHaveProperty("iterations");
        expect(archiveReads - readsBefore).toBeGreaterThanOrEqual(4);
        expect(
          await readAttemptEvidenceText(
            db,
            new AttemptEvidenceStore(),
            attempt.id,
          ),
        ).toBe(source.payloadText);
        const afterPoints = await readPolarAttemptEvidenceForConsumerProof(
          db,
          own.foil,
          own.revision,
          own.historical,
        );
        const afterClassification = classifyPolarEvidence(afterPoints);
        expect(
          afterClassification.classifications.map(
            ({ state, region, confidence, reasons }) => ({
              state,
              region,
              confidence,
              reasons,
            }),
          ),
        ).toEqual(
          beforeClassification.classifications.map(
            ({ state, region, confidence, reasons }) => ({
              state,
              region,
              confidence,
              reasons,
            }),
          ),
        );
        expect(buildPolarFit(afterClassification.classifications)).toEqual(
          beforeFit,
        );
        await refreshPolarCacheForRevision(db, own.foil, own.revision);
        expect(await snapshot()).toEqual(before);
        const [event] =
          await db.execute(sql`SELECT completed,net_value_bytes_saved FROM attempt_evidence_storage_events
    WHERE result_attempt_id=${attempt.id}::uuid AND action='shorten'`);
        expect(event.completed).toBe(true);
        console.info(
          "ATTEMPT_STORAGE_EQUIVALENCE",
          JSON.stringify({
            state,
            points: before.rows.length,
            accepted: beforeFit.acceptedPointCount,
            rejected: beforeFit.rejectedPointCount,
            payloadBytesReclaimed: measurement.payloadBytesReclaimed,
            netBytesReclaimed: measurement.netValueBytesReclaimed,
          }),
        );
        const restored = await restoreAttemptEvidence(
          db,
          attempt.id,
          archive.id,
          source.payloadText,
          "restore exact source after consumer equivalence fixture",
        );
        expect(restored).toBeTruthy();
        expect((await getAttemptEvidenceStorage(db, attempt.id))?.state).toBe(
          "inline",
        );
        await refreshPolarCacheForRevision(db, own.foil, own.revision);
        expect(await snapshot()).toEqual(before);
      },
      60_000,
    );

    it("refuses a source selected after dependency verification, retaining its full arrays", async () => {
      const attempt = histories.get(2)!,
        current = selected.get(2)!;
      const { archive } = await copy(2);
      const deps = createAttemptEvidenceSettlementDependencies(db, (request) =>
        readApiAttemptEvidenceForApp(db, request),
      );
      const verify = deps.verifyDependencies;
      deps.verifyDependencies = async (input) => {
        const proof = await verify(input);
        await db
          .update(results)
          .set({ currentResultAttemptId: attempt.id })
          .where(eq(results.id, current.resultId));
        return proof;
      };
      try {
        await expect(
          settleAttemptEvidenceHistory(db, deps, {
            attemptId: attempt.id,
            archiveId: archive.id,
          }),
        ).rejects.toThrow(/referenced|limited/);
        expect((await getAttemptEvidenceStorage(db, attempt.id))?.state).toBe(
          "inline",
        );
      } finally {
        await db
          .update(results)
          .set({ currentResultAttemptId: current.id })
          .where(eq(results.id, current.resultId));
      }
    }, 60_000);

    it("publishes the full stored history when a later media repair selects a cold attempt", async () => {
      const alpha = -2;
      const attempt = histories.get(alpha)!;
      const { source, archive } = await copy(alpha);
      const deps = createAttemptEvidenceSettlementDependencies(db, (request) =>
        readApiAttemptEvidenceForApp(db, request),
      );
      const measurement = await settleAttemptEvidenceHistory(db, deps, {
        attemptId: attempt.id,
        archiveId: archive.id,
      });
      expect(measurement.netValueBytesReclaimed).toBeGreaterThan(0);
      const [manifest] = await db
        .select({ sha: solverEvidenceArtifacts.sha256 })
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.resultAttemptId, attempt.id));
      const field = "pressure";
      const [scale] = await db
        .insert(fieldColorScales)
        .values({
          airfoilId: own.foil,
          simulationPresetRevisionId: own.revision,
          field,
          scalePolicy: "test",
          vmin: -1,
          vmax: 1,
          version: 1,
          evidenceSignature: manifest.sha,
        })
        .returning({ id: fieldColorScales.id });
      await db
        .insert(resultFieldExtents)
        .values({
          resultId: attempt.resultId,
          resultAttemptId: attempt.id,
          airfoilId: own.foil,
          simulationPresetRevisionId: own.revision,
          field,
          vmin: -1,
          vmax: 1,
          finiteCount: 2,
          evidenceSha256: manifest.sha,
        });
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWNkAAAAASUVORK5CYII=",
        "base64",
      );
      const storageKey = `${prefix}/${attempt.id}/pressure.png`;
      await writeFile(join(directory, storageKey), image);
      await db
        .insert(resultMedia)
        .values({
          resultId: attempt.resultId,
          resultAttemptId: attempt.id,
          field,
          role: "instantaneous",
          kind: "image",
          mimeType: "image/png",
          colorScaleId: scale.id,
          evidenceSha256: manifest.sha,
          storageKey,
          byteSize: image.length,
          sha256: createHash("sha256").update(image).digest("hex"),
        });
      const signature = `${prefix}-historical:alpha-${alpha}:${manifest.sha}`;
      const [repair] = await db
        .insert(resultMediaRepairs)
        .values({
          resultId: attempt.resultId,
          resultAttemptId: attempt.id,
          state: "done",
          evidenceSignature: signature,
          completedAt: new Date(),
        })
        .returning({ id: resultMediaRepairs.id });
      const publish = () =>
        publishRepairedResultAttempt({
          db,
          resultId: attempt.resultId,
          resultAttemptId: attempt.id,
          repairId: repair.id,
          evidenceSignature: signature,
        });
      expect(await publish()).toBe("waiting");
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(eq(results.id, attempt.resultId));
      expect(await publish()).toBe("published");
      const [current] = await db
        .select({
          id: results.currentResultAttemptId,
          history: results.steadyHistory,
        })
        .from(results)
        .where(eq(results.id, attempt.resultId));
      expect(current).toEqual({
        id: attempt.id,
        history: JSON.parse(source.payloadText).steady_history,
      });
    }, 60_000);

    afterAll(async () => {
      try {
        readSpy?.mockRestore();
        apiEnv.evidenceBucket = priorBucket;
        if (priorRole === undefined)
          delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
        else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = priorRole;
        if (priorEvidenceBucket === undefined)
          delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
        else process.env.AIRFOILFOAM_EVIDENCE_BUCKET = priorEvidenceBucket;
        if (own.foil) {
          await db
            .update(results)
            .set({ currentResultAttemptId: null })
            .where(eq(results.airfoilId, own.foil));
          await db
            .delete(polarFitSets)
            .where(eq(polarFitSets.airfoilId, own.foil));
          await db.execute(
            sql`DELETE FROM polar_compatibility_fit_sets WHERE airfoil_id=${own.foil}::uuid`,
          );
          await db
            .delete(resultClassifications)
            .where(eq(resultClassifications.airfoilId, own.foil));
          await db.delete(results).where(eq(results.airfoilId, own.foil));
          await db
            .delete(simJobs)
            .where(
              inArray(
                simJobs.id,
                [own.selected, own.historical].filter(Boolean),
              ),
            );
          await db.delete(airfoils).where(eq(airfoils.id, own.foil));
        }
        if (own.preset)
          await db
            .delete(simulationPresets)
            .where(eq(simulationPresets.id, own.preset));
        if (own.flow)
          await db.execute(sql`DELETE FROM flow_conditions WHERE id=${own.flow}::uuid
      AND NOT EXISTS(SELECT 1 FROM simulation_presets WHERE flow_condition_id=${own.flow}::uuid)
      AND NOT EXISTS(SELECT 1 FROM sim_campaign_conditions WHERE flow_condition_id=${own.flow}::uuid)`);
        if (own.reference)
          await db.execute(sql`DELETE FROM reference_geometry_profiles WHERE id=${own.reference}::uuid
      AND NOT EXISTS(SELECT 1 FROM simulation_presets WHERE reference_geometry_profile_id=${own.reference}::uuid)
      AND NOT EXISTS(SELECT 1 FROM sim_campaign_conditions WHERE reference_geometry_profile_id=${own.reference}::uuid)`);
        if (own.sweep)
          await db
            .delete(sweepDefinitions)
            .where(eq(sweepDefinitions.id, own.sweep));
        if (own.bc)
          await db
            .delete(boundaryConditions)
            .where(eq(boundaryConditions.id, own.bc));
        if (own.category)
          await db.delete(categories).where(eq(categories.id, own.category));
        if (policy)
          await setAttemptEvidenceStoragePolicy(db, {
            enabled: policy.shorteningEnabled,
            ...(policy.consumerContractVersion === 1
              ? { consumerContractVersion: 1 as const }
              : {}),
          });
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        await client.sql.end();
      }
    });
  },
);
