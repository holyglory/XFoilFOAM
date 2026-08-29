import {
  RESULT_MEDIA_LOCAL_BYTES_UNAVAILABLE_MARKER,
  type DB,
  resultMedia,
  resultMediaBlobs,
  resultMediaStorageBindings,
  resultMediaStorageUploads,
} from "@aerodb/db";
import { Storage } from "@google-cloud/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^[1-9][0-9]{0,19}$/;
const CRC32C_PATTERN = /^[A-Za-z0-9+/]{6}==$/;
const TEN_MIB = 10 * 1024 * 1024;
const MISSING_LOCAL_RETRY_MS = 6 * 60 * 60_000;
const SOURCE_AUDIT_REPEAT_MS = 60 * 60_000;
const SOURCE_AUDIT_LIMIT = 2_048;
const SOURCE_AUDIT_MAX_PAGES_PER_MAINTENANCE = 32;

export class ResultMediaLocalBytesUnavailableError extends Error {
  constructor(storageKey: string) {
    super(`${RESULT_MEDIA_LOCAL_BYTES_UNAVAILABLE_MARKER}: ${storageKey}`);
    this.name = "ResultMediaLocalBytesUnavailableError";
  }
}

export interface StoredResultMediaObject {
  backend: "gcs";
  bucket: string;
  objectKey: string;
  generation: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  crc32c: string;
  verifiedAt: Date;
}

export interface ResultMediaObjectInput {
  resultMediaId: string;
  localStorageKey: string;
  localPath: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing`);
  }
  return value.trim();
}

function errorCode(error: unknown): number | null {
  if (error == null || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : null;
}

function canonicalPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (
    !prefix ||
    prefix.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("result media object prefix is invalid");
  }
  return prefix;
}

async function sha256Stream(stream: NodeJS.ReadableStream): Promise<{
  sha256: string;
  byteSize: number;
}> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), byteSize };
}

export class ResultMediaObjectStore {
  private readonly prefix: string;

  constructor(
    readonly bucketName: string,
    objectPrefix = "solver-media/v1",
    private readonly storage: Storage = new Storage(),
  ) {
    this.bucketName = exactText(bucketName, "result media bucket");
    this.prefix = canonicalPrefix(objectPrefix);
  }

  objectKey(sha256: string): string {
    const digest = sha256.trim().toLowerCase();
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error("result media SHA-256 is invalid");
    }
    return `${this.prefix}/sha256/${digest.slice(0, 2)}/${digest}`;
  }

  async putFile(input: {
    localPath: string;
    mimeType: string;
    sha256: string;
    byteSize: number;
  }): Promise<StoredResultMediaObject> {
    const sha256 = input.sha256.trim().toLowerCase();
    const mimeType = exactText(input.mimeType, "result media MIME type");
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("result media SHA-256 is invalid");
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
      throw new Error("result media byte size is invalid");
    }
    const local = await stat(input.localPath);
    if (!local.isFile() || local.size !== input.byteSize) {
      throw new Error("result media local byte size changed before upload");
    }

    const bucket = this.storage.bucket(this.bucketName);
    const objectKey = this.objectKey(sha256);
    let created = true;
    try {
      await bucket.upload(input.localPath, {
        destination: objectKey,
        resumable: input.byteSize >= TEN_MIB,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          cacheControl: "public, max-age=31536000, immutable",
          contentType: mimeType,
          metadata: {
            sha256,
            byteSize: String(input.byteSize),
          },
        },
      });
    } catch (error) {
      if (errorCode(error) !== 412) throw error;
      created = false;
    }

    const file = bucket.file(objectKey);
    const [metadata] = await file.getMetadata();
    const generation = exactText(
      metadata.generation,
      "result media generation",
    );
    const crc32c = exactText(metadata.crc32c, "result media CRC32C");
    const storedSize = Number(metadata.size);
    const custom = (metadata.metadata ?? {}) as Record<string, unknown>;
    if (
      !GENERATION_PATTERN.test(generation) ||
      !CRC32C_PATTERN.test(crc32c) ||
      storedSize !== input.byteSize ||
      metadata.contentType !== mimeType ||
      custom.sha256 !== sha256 ||
      custom.byteSize !== String(input.byteSize)
    ) {
      throw new Error(
        `result media object metadata does not match ${created ? "the uploaded" : "the existing"} bytes`,
      );
    }

    // GCS exposes CRC32C but not SHA-256. Stream the pinned generation to EOF
    // once so both new uploads and create-only retry hits prove the exact
    // application-level digest before the database can acknowledge them.
    const pinned = bucket.file(objectKey, { generation });
    const remote = await sha256Stream(
      pinned.createReadStream({ validation: true }),
    );
    if (remote.byteSize !== input.byteSize || remote.sha256 !== sha256) {
      throw new Error(
        "result media object bytes failed exact readback verification",
      );
    }

    return {
      backend: "gcs",
      bucket: this.bucketName,
      objectKey,
      generation,
      mimeType,
      sha256,
      byteSize: input.byteSize,
      crc32c,
      verifiedAt: new Date(),
    };
  }
}

export function resultMediaObjectStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  storage?: Storage,
): ResultMediaObjectStore | null {
  const bucket = env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (!bucket) return null;
  return new ResultMediaObjectStore(
    bucket,
    env.AIRFOILFOAM_MEDIA_OBJECT_PREFIX ?? "solver-media/v1",
    storage,
  );
}

let cachedStoreKey: string | null | undefined;
let cachedStore: ResultMediaObjectStore | null = null;

export function configuredResultMediaObjectStore(
  env: NodeJS.ProcessEnv = process.env,
): ResultMediaObjectStore | null {
  const bucket = env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim() ?? "";
  const prefix = env.AIRFOILFOAM_MEDIA_OBJECT_PREFIX ?? "solver-media/v1";
  const key = bucket ? `${bucket}\n${prefix}` : null;
  if (cachedStoreKey === key) return cachedStore;
  cachedStoreKey = key;
  cachedStore = resultMediaObjectStoreFromEnv(env);
  return cachedStore;
}

export function resetConfiguredResultMediaObjectStore(): void {
  cachedStoreKey = undefined;
  cachedStore = null;
}

export async function loadResultMediaObjectBinding(
  db: DB,
  resultMediaId: string,
): Promise<{
  localStorageKey: string;
  state: "pending" | "running" | "retry_wait" | "reclaimed";
  blob: StoredResultMediaObject;
} | null> {
  const [row] = await db
    .select({
      localStorageKey: resultMediaStorageBindings.localStorageKey,
      state: resultMediaStorageBindings.state,
      backend: resultMediaBlobs.backend,
      bucket: resultMediaBlobs.bucket,
      objectKey: resultMediaBlobs.objectKey,
      generation: resultMediaBlobs.generation,
      mimeType: resultMediaBlobs.mimeType,
      sha256: resultMediaBlobs.sha256,
      byteSize: resultMediaBlobs.byteSize,
      crc32c: resultMediaBlobs.crc32c,
      verifiedAt: resultMediaBlobs.verifiedAt,
    })
    .from(resultMediaStorageBindings)
    .innerJoin(
      resultMediaBlobs,
      eq(resultMediaBlobs.id, resultMediaStorageBindings.blobId),
    )
    .where(eq(resultMediaStorageBindings.resultMediaId, resultMediaId))
    .limit(1);
  if (!row) return null;
  if (row.backend !== "gcs") {
    throw new Error("result media binding uses an unsupported storage backend");
  }
  return {
    localStorageKey: row.localStorageKey,
    state: row.state,
    blob: {
      backend: "gcs",
      bucket: row.bucket,
      objectKey: row.objectKey,
      generation: row.generation,
      mimeType: row.mimeType,
      sha256: row.sha256,
      byteSize: row.byteSize,
      crc32c: row.crc32c,
      verifiedAt: row.verifiedAt,
    },
  };
}

export async function bindResultMediaObject(
  db: DB,
  input: ResultMediaObjectInput,
  object: StoredResultMediaObject,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [media] = await tx
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.id, input.resultMediaId))
      .for("update")
      .limit(1);
    if (!media) throw new Error("result media row disappeared before binding");
    if (
      media.storageKey !== input.localStorageKey ||
      media.mimeType !== input.mimeType ||
      media.sha256?.toLowerCase() !== input.sha256.toLowerCase() ||
      media.byteSize !== input.byteSize
    ) {
      throw new Error(
        "result media row changed before immutable object binding",
      );
    }
    if (
      object.backend !== "gcs" ||
      object.mimeType !== input.mimeType ||
      object.sha256 !== input.sha256.toLowerCase() ||
      object.byteSize !== input.byteSize
    ) {
      throw new Error(
        "result media object identity differs from the local row",
      );
    }

    await tx.insert(resultMediaBlobs).values(object).onConflictDoNothing();
    const [blob] = await tx
      .select()
      .from(resultMediaBlobs)
      .where(
        and(
          eq(resultMediaBlobs.sha256, object.sha256),
          eq(resultMediaBlobs.byteSize, object.byteSize),
        ),
      )
      .limit(1);
    if (
      !blob ||
      blob.backend !== object.backend ||
      blob.bucket !== object.bucket ||
      blob.objectKey !== object.objectKey ||
      blob.generation !== object.generation ||
      blob.mimeType !== object.mimeType ||
      blob.crc32c !== object.crc32c
    ) {
      throw new Error(
        "result media content identity conflicts with stored object",
      );
    }

    const [priorBinding] = await tx
      .select()
      .from(resultMediaStorageBindings)
      .where(eq(resultMediaStorageBindings.resultMediaId, input.resultMediaId))
      .for("update")
      .limit(1);
    if (!priorBinding) {
      await tx.insert(resultMediaStorageBindings).values({
        resultMediaId: input.resultMediaId,
        blobId: blob.id,
        localStorageKey: input.localStorageKey,
        state: "pending",
      });
    } else if (
      priorBinding.blobId !== blob.id ||
      priorBinding.localStorageKey !== input.localStorageKey
    ) {
      if (priorBinding.state !== "reclaimed") {
        throw new Error(
          "result media changed before its prior local bytes were reclaimed",
        );
      }
      await tx
        .update(resultMediaStorageBindings)
        .set({
          blobId: blob.id,
          localStorageKey: input.localStorageKey,
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          error: null,
          reclaimedAt: null,
          updatedAt: new Date(),
        })
        .where(
          eq(resultMediaStorageBindings.resultMediaId, input.resultMediaId),
        );
    }
    const boundAt = new Date();
    await tx
      .insert(resultMediaStorageUploads)
      .values({
        resultMediaId: input.resultMediaId,
        state: "bound",
        boundAt,
      })
      .onConflictDoUpdate({
        target: resultMediaStorageUploads.resultMediaId,
        set: {
          state: "bound",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          error: null,
          boundAt,
          updatedAt: boundAt,
        },
      });
  });
}

export async function enqueueResultMediaStorageUpload(
  db: DB,
  resultMediaId: string,
): Promise<void> {
  await db
    .insert(resultMediaStorageUploads)
    .values({ resultMediaId, state: "pending" })
    .onConflictDoNothing();
}

export async function ensureResultMediaObject(
  db: DB,
  store: ResultMediaObjectStore,
  input: ResultMediaObjectInput,
): Promise<void> {
  const existing = await loadResultMediaObjectBinding(db, input.resultMediaId);
  if (existing) {
    const differs =
      existing.localStorageKey !== input.localStorageKey ||
      existing.blob.mimeType !== input.mimeType ||
      existing.blob.sha256 !== input.sha256.toLowerCase() ||
      existing.blob.byteSize !== input.byteSize;
    if (!differs) return;
    if (existing.state !== "reclaimed") {
      throw new Error("result media already has a conflicting object binding");
    }
  }
  let local;
  try {
    local = await stat(input.localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResultMediaLocalBytesUnavailableError(input.localStorageKey);
    }
    throw error;
  }
  if (!local.isFile() || local.size !== input.byteSize) {
    throw new Error(
      "result media local bytes are unavailable for object upload",
    );
  }
  const localHash = await sha256Stream(createReadStream(input.localPath));
  if (
    localHash.byteSize !== input.byteSize ||
    localHash.sha256 !== input.sha256.toLowerCase()
  ) {
    throw new Error("result media local bytes failed exact upload preflight");
  }
  const object = await store.putFile(input);
  await bindResultMediaObject(db, input, object);
}

interface ClaimedUpload {
  result_media_id: string;
  claim_token: string;
  attempt_count: number;
}

interface ClaimedReclaim extends ClaimedUpload {
  local_storage_key: string;
}

function retryAt(attemptCount: number): Date {
  const seconds = Math.min(3600, 15 * 2 ** Math.min(attemptCount, 8));
  return new Date(Date.now() + seconds * 1000);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}

export function resultMediaLocalPath(
  storageKey: string,
  mediaRoot = process.env.MEDIA_DIR ?? "/data/airfoilfoam",
): string {
  if (!/^(?:jobs|sync-imports)\//.test(storageKey)) {
    throw new Error("result media local key is outside managed media storage");
  }
  const base = resolve(mediaRoot);
  const full = resolve(base, storageKey);
  if (full === base || !full.startsWith(base + sep)) {
    throw new Error("result media local key escapes managed media storage");
  }
  return full;
}

export async function discoverResultMediaStorageUploads(
  db: DB,
  limit = 64,
): Promise<number> {
  const rows = (await db.execute(sql`
    INSERT INTO result_media_storage_uploads (result_media_id, state)
    SELECT media.id, 'pending'::result_media_storage_upload_state
    FROM result_media media
    LEFT JOIN result_media_storage_bindings binding
      ON binding.result_media_id = media.id
    LEFT JOIN result_media_storage_uploads upload
      ON upload.result_media_id = media.id
    WHERE binding.result_media_id IS NULL
      AND upload.result_media_id IS NULL
      AND media.sha256 ~ '^[0-9a-f]{64}$'
      AND media.byte_size > 0
      AND media.storage_key ~ '^(jobs|sync-imports)/'
    ORDER BY media."createdAt" ASC, media.id ASC
    LIMIT ${Math.max(0, Math.trunc(limit))}
    ON CONFLICT (result_media_id) DO NOTHING
    RETURNING result_media_id
  `)) as unknown as Array<{ result_media_id: string }>;
  return rows.length;
}

export interface ResultMediaStorageSourceAuditCursor {
  resultMediaId: string;
}

/** Walk unbound upload rows independently of the slower GCS upload queue.
 * Missing/truncated legacy sources become repairable immediately instead of
 * waiting behind every present file that still needs object upload. */
export async function auditResultMediaStorageSources(
  db: DB,
  options: {
    limit?: number;
    concurrency?: number;
    cursor?: ResultMediaStorageSourceAuditCursor | null;
    mediaRoot?: string;
    now?: Date;
    /** Deterministic test/operator scope. Omit for the migration-wide walk. */
    resultMediaIds?: readonly string[];
  } = {},
): Promise<{
  scanned: number;
  missing: number;
  complete: boolean;
  nextCursor: ResultMediaStorageSourceAuditCursor | null;
}> {
  if (options.resultMediaIds?.length === 0) {
    return { scanned: 0, missing: 0, complete: true, nextCursor: null };
  }
  const limit = Math.max(
    1,
    Math.min(options.limit ?? SOURCE_AUDIT_LIMIT, 10_000),
  );
  const cursorId = options.cursor?.resultMediaId ?? null;
  const scopedIds = options.resultMediaIds
    ? sql`AND upload.result_media_id IN (${sql.join(
        options.resultMediaIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT
      upload.result_media_id,
      media.storage_key,
      media.byte_size::double precision AS byte_size
    FROM result_media_storage_uploads upload
    JOIN result_media media ON media.id = upload.result_media_id
    LEFT JOIN result_media_storage_bindings binding
      ON binding.result_media_id = upload.result_media_id
    WHERE upload.state = 'pending'
      AND binding.result_media_id IS NULL
      AND (${cursorId}::uuid IS NULL OR upload.result_media_id > ${cursorId}::uuid)
      ${scopedIds}
    ORDER BY upload.result_media_id ASC
    LIMIT ${limit}
  `)) as unknown as Array<{
    result_media_id: string;
    storage_key: string;
    byte_size: number | null;
  }>;
  const missingIds: string[] = [];
  await mapConcurrent(rows, options.concurrency ?? 64, async (row) => {
    try {
      const info = await stat(
        resultMediaLocalPath(row.storage_key, options.mediaRoot),
      );
      if (
        !info.isFile() ||
        row.byte_size == null ||
        !Number.isSafeInteger(row.byte_size) ||
        row.byte_size <= 0 ||
        info.size !== row.byte_size
      ) {
        missingIds.push(row.result_media_id);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missingIds.push(row.result_media_id);
    }
  });
  if (missingIds.length) {
    const now = options.now ?? new Date();
    await db
      .update(resultMediaStorageUploads)
      .set({
        state: "retry_wait",
        nextAttemptAt: new Date(now.getTime() + MISSING_LOCAL_RETRY_MS),
        error: RESULT_MEDIA_LOCAL_BYTES_UNAVAILABLE_MARKER,
        updatedAt: now,
      })
      .where(
        and(
          inArray(resultMediaStorageUploads.resultMediaId, missingIds),
          eq(resultMediaStorageUploads.state, "pending"),
        ),
      );
  }
  const complete = rows.length < limit;
  const last = rows.at(-1);
  return {
    scanned: rows.length,
    missing: missingIds.length,
    complete,
    nextCursor:
      complete || !last
        ? null
        : {
            resultMediaId: last.result_media_id,
          },
  };
}

export async function auditResultMediaStorageSourcePass(
  db: DB,
  options: {
    limit?: number;
    maxPages?: number;
    concurrency?: number;
    cursor?: ResultMediaStorageSourceAuditCursor | null;
    mediaRoot?: string;
    now?: Date;
    resultMediaIds?: readonly string[];
  } = {},
): Promise<{
  scanned: number;
  missing: number;
  complete: boolean;
  nextCursor: ResultMediaStorageSourceAuditCursor | null;
}> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 1, 1_000));
  const auditOptions = {
    limit: options.limit,
    concurrency: options.concurrency,
    mediaRoot: options.mediaRoot,
    now: options.now,
    resultMediaIds: options.resultMediaIds,
  };
  let cursor = options.cursor ?? null;
  let scanned = 0;
  let missing = 0;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const pageAudit = await auditResultMediaStorageSources(db, {
      ...auditOptions,
      cursor,
    });
    scanned += pageAudit.scanned;
    missing += pageAudit.missing;
    complete = pageAudit.complete;
    cursor = pageAudit.nextCursor;
    if (complete) break;
  }
  return { scanned, missing, complete, nextCursor: cursor };
}

async function claimResultMediaStorageUploads(
  db: DB,
  limit: number,
  resultMediaIds?: readonly string[],
): Promise<ClaimedUpload[]> {
  if (resultMediaIds?.length === 0) return [];
  const claimToken = randomUUID();
  const scopedIds = resultMediaIds
    ? sql`AND upload.result_media_id IN (${sql.join(
        resultMediaIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  return (await db.execute(sql`
    WITH candidates AS (
      SELECT upload.result_media_id
      FROM result_media_storage_uploads upload
      WHERE (
        (
          upload.state IN ('pending', 'retry_wait')
          AND (upload.next_attempt_at IS NULL OR upload.next_attempt_at <= now())
        ) OR (
          upload.state = 'running'
          AND upload.claim_expires_at <= now()
        )
      )
      ${scopedIds}
      ORDER BY upload."createdAt" ASC, upload.result_media_id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(0, Math.trunc(limit))}
    )
    UPDATE result_media_storage_uploads upload
    SET state = 'running',
        attempt_count = upload.attempt_count + 1,
        claim_token = ${claimToken}::uuid,
        claim_expires_at = now() + interval '15 minutes',
        next_attempt_at = NULL,
        error = NULL,
        "updatedAt" = now()
    FROM candidates
    WHERE upload.result_media_id = candidates.result_media_id
    RETURNING upload.result_media_id, upload.claim_token, upload.attempt_count
  `)) as unknown as ClaimedUpload[];
}

async function failResultMediaStorageUpload(
  db: DB,
  claim: ClaimedUpload,
  error: unknown,
): Promise<void> {
  const localBytesMissing =
    error instanceof ResultMediaLocalBytesUnavailableError;
  await db
    .update(resultMediaStorageUploads)
    .set({
      state: "retry_wait",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: localBytesMissing
        ? new Date(Date.now() + MISSING_LOCAL_RETRY_MS)
        : retryAt(claim.attempt_count),
      error: boundedError(error),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultMediaStorageUploads.resultMediaId, claim.result_media_id),
        eq(resultMediaStorageUploads.state, "running"),
        eq(resultMediaStorageUploads.claimToken, claim.claim_token),
      ),
    );
}

async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, Math.max(1, concurrency)) },
      async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          await fn(item);
        }
      },
    ),
  );
}

export async function processResultMediaStorageUploads(
  db: DB,
  store: ResultMediaObjectStore,
  options: {
    discoverLimit?: number;
    processLimit?: number;
    concurrency?: number;
    /** Deterministic maintenance/repair scope. Omit for the ordinary queue. */
    resultMediaIds?: readonly string[];
  } = {},
): Promise<number> {
  if (!options.resultMediaIds) {
    await discoverResultMediaStorageUploads(db, options.discoverLimit ?? 64);
  }
  const claims = await claimResultMediaStorageUploads(
    db,
    options.processLimit ?? 32,
    options.resultMediaIds,
  );
  if (!claims.length) return 0;
  const rows = await db
    .select({
      id: resultMedia.id,
      storageKey: resultMedia.storageKey,
      mimeType: resultMedia.mimeType,
      sha256: resultMedia.sha256,
      byteSize: resultMedia.byteSize,
    })
    .from(resultMedia)
    .where(
      inArray(
        resultMedia.id,
        claims.map((claim) => claim.result_media_id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  let bound = 0;
  await mapConcurrent(claims, options.concurrency ?? 4, async (claim) => {
    try {
      const media = byId.get(claim.result_media_id);
      if (
        !media ||
        !media.sha256 ||
        !SHA256_PATTERN.test(media.sha256) ||
        media.byteSize == null ||
        !Number.isSafeInteger(media.byteSize) ||
        media.byteSize <= 0
      ) {
        throw new Error(
          "result media upload owner or exact identity is missing",
        );
      }
      await ensureResultMediaObject(db, store, {
        resultMediaId: media.id,
        localStorageKey: media.storageKey,
        localPath: resultMediaLocalPath(media.storageKey),
        mimeType: media.mimeType,
        sha256: media.sha256,
        byteSize: media.byteSize,
      });
      // ensureResultMediaObject is idempotent and may encounter an already
      // committed binding whose prior upload row was interrupted.
      await db
        .update(resultMediaStorageUploads)
        .set({
          state: "bound",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          error: null,
          boundAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(resultMediaStorageUploads.resultMediaId, media.id));
      bound += 1;
    } catch (error) {
      await failResultMediaStorageUpload(db, claim, error);
    }
  });
  return bound;
}

async function claimResultMediaLocalReclaims(
  db: DB,
  limit: number,
): Promise<ClaimedReclaim[]> {
  const claimToken = randomUUID();
  return (await db.execute(sql`
    WITH candidates AS (
      SELECT binding.result_media_id
      FROM result_media_storage_bindings binding
      WHERE (
        binding.state IN ('pending', 'retry_wait')
        AND (binding.next_attempt_at IS NULL OR binding.next_attempt_at <= now())
      ) OR (
        binding.state = 'running'
        AND binding.claim_expires_at <= now()
      )
      ORDER BY binding."createdAt" ASC, binding.result_media_id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(0, Math.trunc(limit))}
    )
    UPDATE result_media_storage_bindings binding
    SET state = 'running',
        attempt_count = binding.attempt_count + 1,
        claim_token = ${claimToken}::uuid,
        claim_expires_at = now() + interval '15 minutes',
        next_attempt_at = NULL,
        error = NULL,
        "updatedAt" = now()
    FROM candidates
    WHERE binding.result_media_id = candidates.result_media_id
    RETURNING binding.result_media_id, binding.local_storage_key,
      binding.claim_token, binding.attempt_count
  `)) as unknown as ClaimedReclaim[];
}

async function failResultMediaLocalReclaim(
  db: DB,
  claim: ClaimedReclaim,
  error: unknown,
): Promise<void> {
  await db
    .update(resultMediaStorageBindings)
    .set({
      state: "retry_wait",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: retryAt(claim.attempt_count),
      error: boundedError(error),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultMediaStorageBindings.resultMediaId, claim.result_media_id),
        eq(resultMediaStorageBindings.state, "running"),
        eq(resultMediaStorageBindings.claimToken, claim.claim_token),
      ),
    );
}

async function assertLocalMediaReferencesMatch(
  db: DB,
  storageKey: string,
  expected: { sha256: string; byteSize: number; mimeType: string },
): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM solver_evidence_artifacts artifact
        WHERE artifact.storage_key = ${storageKey}
          AND (
            artifact.sha256 IS DISTINCT FROM ${expected.sha256}
            OR artifact.byte_size IS DISTINCT FROM ${expected.byteSize}
            OR artifact.mime_type IS DISTINCT FROM ${expected.mimeType}
          )
      ) AS artifact_conflict,
      EXISTS (
        SELECT 1 FROM field_render_cache render
        WHERE render.storage_key = ${storageKey}
          AND (
            render.sha256 IS DISTINCT FROM ${expected.sha256}
            OR render.byte_size IS DISTINCT FROM ${expected.byteSize}
            OR render.mime_type IS DISTINCT FROM ${expected.mimeType}
          )
      ) AS render_conflict,
      EXISTS (
        SELECT 1 FROM remote_asset_references remote
        WHERE (
          remote.local_storage_key = ${storageKey}
          OR remote.cached_storage_key = ${storageKey}
        ) AND (
          remote.sha256 IS DISTINCT FROM ${expected.sha256}
          OR remote.byte_size IS DISTINCT FROM ${expected.byteSize}
          OR remote.mime_type IS DISTINCT FROM ${expected.mimeType}
        )
      ) AS remote_conflict
  `)) as unknown as Array<{
    artifact_conflict: boolean;
    render_conflict: boolean;
    remote_conflict: boolean;
  }>;
  const row = rows[0];
  if (row?.artifact_conflict || row?.render_conflict || row?.remote_conflict) {
    throw new Error("another local media reference has a conflicting identity");
  }
}

export async function processResultMediaLocalReclaims(
  db: DB,
  options: { limit?: number; concurrency?: number; mediaRoot?: string } = {},
): Promise<number> {
  const claims = await claimResultMediaLocalReclaims(db, options.limit ?? 64);
  if (!claims.length) return 0;
  const rows = await db
    .select({
      resultMediaId: resultMediaStorageBindings.resultMediaId,
      localStorageKey: resultMediaStorageBindings.localStorageKey,
      mediaStorageKey: resultMedia.storageKey,
      mediaMimeType: resultMedia.mimeType,
      mediaSha256: resultMedia.sha256,
      mediaByteSize: resultMedia.byteSize,
      blobMimeType: resultMediaBlobs.mimeType,
      blobSha256: resultMediaBlobs.sha256,
      blobByteSize: resultMediaBlobs.byteSize,
    })
    .from(resultMediaStorageBindings)
    .innerJoin(
      resultMedia,
      eq(resultMedia.id, resultMediaStorageBindings.resultMediaId),
    )
    .innerJoin(
      resultMediaBlobs,
      eq(resultMediaBlobs.id, resultMediaStorageBindings.blobId),
    )
    .where(
      inArray(
        resultMediaStorageBindings.resultMediaId,
        claims.map((claim) => claim.result_media_id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.resultMediaId, row]));
  let reclaimed = 0;
  await mapConcurrent(claims, options.concurrency ?? 8, async (claim) => {
    try {
      const row = byId.get(claim.result_media_id);
      if (
        !row ||
        row.localStorageKey !== claim.local_storage_key ||
        row.mediaStorageKey !== row.localStorageKey ||
        !row.mediaSha256 ||
        row.mediaSha256 !== row.blobSha256 ||
        row.mediaByteSize !== row.blobByteSize ||
        row.mediaMimeType !== row.blobMimeType
      ) {
        throw new Error("result media reclaim identity changed after binding");
      }
      await assertLocalMediaReferencesMatch(db, row.localStorageKey, {
        sha256: row.blobSha256,
        byteSize: row.blobByteSize,
        mimeType: row.blobMimeType,
      });
      const path = resultMediaLocalPath(row.localStorageKey, options.mediaRoot);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size !== row.blobByteSize) {
          throw new Error("result media local bytes changed before reclaim");
        }
        const local = await sha256Stream(createReadStream(path));
        if (
          local.byteSize !== row.blobByteSize ||
          local.sha256 !== row.blobSha256
        ) {
          throw new Error(
            "result media local bytes failed reclaim verification",
          );
        }
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const [settled] = await db
        .update(resultMediaStorageBindings)
        .set({
          state: "reclaimed",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          error: null,
          reclaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resultMediaStorageBindings.resultMediaId, claim.result_media_id),
            eq(resultMediaStorageBindings.state, "running"),
            eq(resultMediaStorageBindings.claimToken, claim.claim_token),
          ),
        )
        .returning({ id: resultMediaStorageBindings.resultMediaId });
      if (settled) reclaimed += 1;
    } catch (error) {
      await failResultMediaLocalReclaim(db, claim, error);
    }
  });
  return reclaimed;
}

let scheduledMaintenance: Promise<void> | null = null;
let sourceAuditCursor: ResultMediaStorageSourceAuditCursor | null = null;
let nextSourceAuditAt = 0;

export function scheduleResultMediaStorageMaintenance(db: DB): void {
  const store = configuredResultMediaObjectStore();
  if (!store || scheduledMaintenance) return;
  scheduledMaintenance = (async () => {
    let audit: Awaited<ReturnType<typeof auditResultMediaStorageSources>> = {
      scanned: 0,
      missing: 0,
      complete: false,
      nextCursor: sourceAuditCursor,
    };
    if (sourceAuditCursor || Date.now() >= nextSourceAuditAt) {
      audit = await auditResultMediaStorageSourcePass(db, {
        cursor: sourceAuditCursor,
        maxPages: SOURCE_AUDIT_MAX_PAGES_PER_MAINTENANCE,
      });
      sourceAuditCursor = audit.nextCursor;
      if (audit.complete)
        nextSourceAuditAt = Date.now() + SOURCE_AUDIT_REPEAT_MS;
    }
    const bound = await processResultMediaStorageUploads(db, store);
    const reclaimed = await processResultMediaLocalReclaims(db);
    if (audit.scanned || bound || reclaimed) {
      console.log(
        `[sweeper] MEDIA STORAGE: audited ${audit.scanned} source(s), missing ${audit.missing}; ` +
          `bound ${bound} object(s), reclaimed ${reclaimed} local file(s)`,
      );
    }
  })()
    .catch((error) => {
      console.error(
        `[sweeper] MEDIA STORAGE: maintenance failed: ${boundedError(error)}`,
      );
    })
    .finally(() => {
      scheduledMaintenance = null;
    });
}
