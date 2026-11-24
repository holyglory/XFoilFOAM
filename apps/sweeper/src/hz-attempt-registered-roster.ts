import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { atomicJson } from "./hz-point-history-relay-service";
import { exactId } from "./hz-attempt-wire";

export interface RegisteredAttemptPin {
  attempt: string;
  result: string;
  job: string;
  archive: string;
  generation: string;
  source_sha256: string;
  source_byte_size: number;
  stored_sha256: string;
  stored_byte_size: number;
}
const SHA = /^[a-f0-9]{64}$/;
const PAGE_SIZE = 8;

function pinFrom(value: RegisteredAttemptPin): RegisteredAttemptPin {
  const {
    attempt,
    result,
    job,
    archive,
    generation,
    source_sha256,
    source_byte_size,
    stored_sha256,
    stored_byte_size,
  } = value;
  for (const id of [attempt, result, job, archive]) exactId(id);
  if (
    typeof generation !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(generation) ||
    !SHA.test(source_sha256) ||
    !SHA.test(stored_sha256) ||
    !Number.isSafeInteger(source_byte_size) ||
    source_byte_size < 1 ||
    !Number.isSafeInteger(stored_byte_size) ||
    stored_byte_size < 1
  )
    throw Error("Invalid registered attempt original identity");
  return {
    attempt,
    result,
    job,
    archive,
    generation,
    source_sha256,
    source_byte_size,
    stored_sha256,
    stored_byte_size,
  };
}

type State = {
  attempt: string;
  matches: boolean;
  current_archive: string | null;
  event: string | null;
  app_readback: string | null;
  saved: number | null;
};
/** Only the pinned PKs, the original identity and an existing completed receipt are needed here.
 * The normal producer and scientific readers still decide whether warm evidence may move. */
export async function registeredAttemptStates(
  db: DB,
  input: unknown,
  instance: string,
) {
  if (!Array.isArray(input) || !input.length || input.length > PAGE_SIZE)
    throw new Error("Invalid registered attempt page");
  exactId(instance);
  const pins = input.map(pinFrom);
  return db.execute<State>(sql`WITH wanted AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(pins)}::jsonb)
    AS w(attempt uuid,result uuid,job uuid,archive uuid,generation text,source_sha256 text,source_byte_size int,stored_sha256 text,stored_byte_size int))
    SELECT w.attempt, a.id IS NOT NULL AND ar.id IS NOT NULL AS matches,
      a.evidence_archive_id current_archive,e.id event,e.app_readback_at::text app_readback,e.net_value_bytes_saved::int saved
    FROM wanted w LEFT JOIN result_attempts a ON a.id=w.attempt AND a.result_id=w.result AND a.sim_job_id=w.job
    LEFT JOIN attempt_evidence_archives ar ON ar.id=w.archive AND ar.result_attempt_id=w.attempt AND ar.result_id=w.result
      AND ar.sim_job_id=w.job AND ar.source_instance=${instance} AND ar.generation=w.generation
      AND ar.source_sha256=w.source_sha256 AND ar.source_byte_size=w.source_byte_size
      AND ar.stored_sha256=w.stored_sha256 AND ar.stored_byte_size=w.stored_byte_size
    LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id
      AND e.archive_id=a.evidence_archive_id AND e.archive_id=ar.id AND e.completed AND e.action='shorten'
    ORDER BY w.attempt`);
}

export async function openRegisteredAttemptRoster(
  path: string,
  sha256: string,
  directory: string,
  binding: string,
) {
  if (!SHA.test(sha256) || !SHA.test(binding))
    throw Error("Invalid registered roster checksum or binding");
  const file = await open(path, "r");
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > 32 * 1024 * 1024)
      throw Error("Unexpected registered roster file size");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw Error("Truncated registered roster");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== stat.size)
      throw Error("Registered roster changed");
  } finally {
    await file.close();
  }
  const data = await promisify(gunzip)(bytes, {
    maxOutputLength: 96 * 1024 * 1024,
  });
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw Error("Registered roster content changed");
  const pins: RegisteredAttemptPin[] = [];
  for (const line of data.toString("utf8").trimEnd().split("\n")) {
    const value = pinFrom(JSON.parse(line));
    if (
      pins.length >= 100_000 ||
      (pins.length && pins[pins.length - 1]!.attempt >= value.attempt)
    )
      throw Error(
        "Registered roster must have bounded distinct ordered attempt IDs",
      );
    pins.push(value);
  }
  if (!pins.length) throw Error("Empty registered roster");
  const scope = join(directory, `registered-${sha256}-${binding}`);
  await mkdir(scope, { recursive: true, mode: 0o700 });
  const checkpoint = join(scope, "checkpoint.json");
  let after = 0;
  try {
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    if (
      saved.sha256 !== sha256 ||
      saved.binding !== binding ||
      saved.total !== pins.length ||
      !Number.isSafeInteger(saved.after) ||
      saved.after < 0 ||
      saved.after > pins.length ||
      (saved.after !== pins.length && saved.after % PAGE_SIZE !== 0)
    )
      throw Error("Invalid registered roster checkpoint");
    after = saved.after;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return {
    get complete() {
      return after === pins.length;
    },
    async advance(
      states: (page: RegisteredAttemptPin[]) => Promise<State[]>,
      migrate: (pin: RegisteredAttemptPin) => Promise<{ limited?: string }>,
      signal: AbortSignal,
    ) {
      if (after === pins.length) return null;
      const page = pins.slice(after, after + PAGE_SIZE);
      const before = await states(page);
      const holds = new Map<string, string>();
      for (const [i, pin] of page.entries()) {
        signal.throwIfAborted();
        const prior = before[i];
        if (!prior || prior.attempt !== pin.attempt)
          throw Error("Registered page returned another owner");
        if (!prior.matches)
          holds.set(pin.attempt, "registered-original-owner-changed");
        else if (prior.current_archive && prior.current_archive !== pin.archive)
          holds.set(pin.attempt, "another-current-original");
        else if (!prior.app_readback) {
          try {
            const result = await migrate(pin);
            if (result.limited) holds.set(pin.attempt, result.limited);
          } catch (e) {
            if (
              !(e instanceof HistoryOperationError) ||
              !["integrity", "input", "database_busy"].includes(e.category)
            )
              throw e;
            holds.set(pin.attempt, e.operation + "/" + e.category);
          }
        }
      }
      const actual = await states(page);
      const receipts = page.map((pin, i) => {
        const row = actual[i];
        if (!row || row.attempt !== pin.attempt)
          throw Error("Registered readback lost its owner");
        const confirmed =
          row.matches &&
          row.current_archive === pin.archive &&
          !!row.event &&
          !!row.app_readback;
        const reason =
          holds.get(pin.attempt) ??
          (row.current_archive === pin.archive && row.event
            ? "pending-application-readback"
            : "registered-source-changed");
        return confirmed
          ? {
              ...pin,
              event: row.event,
              appReadback: row.app_readback,
              netValueBytes: row.saved,
            }
          : { ...pin, held: reason };
      });
      const next = after + page.length;
      await atomicJson(join(scope, `members-${after}.json`), {
        sha256,
        binding,
        after,
        next,
        receipts,
      });
      await atomicJson(checkpoint, {
        sha256,
        binding,
        total: pins.length,
        after: next,
      });
      after = next;
      return {
        after,
        total: pins.length,
        confirmed: receipts.filter((r) => "event" in r).length,
        held: receipts.filter((r) => "held" in r).length,
      };
    },
  };
}
