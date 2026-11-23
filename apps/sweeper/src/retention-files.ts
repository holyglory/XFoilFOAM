import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { ProgressiveEvidenceCustodyReceipt } from "@aerodb/db";
import type {
  ClosedProgressiveBackend, ClosedProgressiveManifest, ClosedProgressiveReadback,
  ClosedProgressiveReclaimResponse, ClosedProgressiveNativeOwner, VerifiedArchiveRestore,
} from "./closed-progressive-retention";

const sourceRoot = fileURLToPath(new URL("../../../src/", import.meta.url));
const installed = "/opt/airfoilfoam-retention/bin/python";
const main = "import sys; sys.path.insert(0, sys.argv.pop(1)); from airfoilfoam.automatic_retention import main; main()";
type Packet = { action: string; job: string; [key: string]: unknown };

export class FileRetentionHold extends Error {}

/** The only native writer used by the normal progressive sweep. The child inherits no sync credentials. */
export class RetentionFiles implements ClosedProgressiveBackend {
  private readonly owners = new Map<string, ClosedProgressiveNativeOwner>();

  constructor(private readonly volume: string, private readonly signal?: AbortSignal) {
    if (!isAbsolute(volume)) throw new Error("An absolute results volume is required");
  }

  private python() {
    return process.env.AIRFOILFOAM_RETENTION_PYTHON ||
      (existsSync(installed) ? installed : resolve(sourceRoot, "../.venv/bin/python"));
  }

  available() {
    try {
      accessSync(this.python(), constants.X_OK);
      accessSync(resolve(sourceRoot, "airfoilfoam/automatic_retention.py"), constants.R_OK);
      return statSync(resolve(this.volume, "jobs")).isDirectory();
    } catch {
      return false;
    }
  }

  private async run<T>(packet: Packet, body?: ReadableStream<Uint8Array>, signal = this.signal): Promise<T | undefined> {
    signal?.throwIfAborted();
    const python = this.python();
    const child = spawn(python, ["-IB", "-c", main, sourceRoot, this.volume], {
      stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH }, signal,
    });
    const exit = new Promise<void>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code) => code === 0 ? done() : fail(new Error("Native retention peer did not complete")));
    });
    async function* input() {
      yield Buffer.from(JSON.stringify(packet) + "\n");
      if (body) yield* body as unknown as AsyncIterable<Uint8Array>;
    }
    const receive = async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > 8 * 1024 ** 2) {
          child.kill();
          throw new Error("Native retention inventory exceeded its response bound");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    };
    const [finished, output, inputDone] = await Promise.allSettled([
      exit, receive(), pipeline(Readable.from(input()), child.stdin, { signal }),
    ]);
    if (finished.status === "rejected") throw finished.reason;
    if (output.status === "rejected") throw output.reason;
    const reply = JSON.parse(output.value.toString("utf8")) as { result?: T; refused?: string; absent?: boolean };
    if (reply.refused) throw new FileRetentionHold(reply.refused);
    if (reply.absent === true) return undefined;
    if (inputDone.status === "rejected") throw inputDone.reason;
    if (!reply.result) throw new Error("Native retention peer omitted its result");
    return reply.result;
  }

  async reclaimClosedProgressiveFiles(job: string, manifests: ClosedProgressiveManifest[], plan?: string,
                                     readbacks?: ClosedProgressiveReadback[], signal?: AbortSignal) {
    const owner = this.owners.get(job);
    if (plan && !owner) throw new Error("Native file removal has no preview identity");
    const result = await this.run<ClosedProgressiveReclaimResponse>({
      action: "progressive", job, manifests, plan, readbacks, owner,
    }, undefined, signal ?? this.signal);
    if (!result) throw new FileRetentionHold("native job directory is absent");
    if (!result.nativeOwner) throw new Error("Native peer omitted its worker lock identity");
    this.owners.set(job, result.nativeOwner);
    return result;
  }

  async restoreArchive(job: string, manifest: ClosedProgressiveManifest, archive: ProgressiveEvidenceCustodyReceipt["remote"],
                       body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const owner = this.owners.get(job);
    if (!owner) throw new Error("Archive restore has no native preview identity");
    const result = await this.run<VerifiedArchiveRestore>({ action: "restore", job, manifest, archive, owner }, body, signal);
    if (!result || result.manifestSha256 !== manifest.manifestSha256 || result.memberCount !== archive.bundledFileCount + 1 ||
        !/^[0-9a-f]{64}$/.test(result.memberSetSha256) || !result.sample || !/^[0-9a-f]{64}$/.test(result.sample.sha256))
      throw new Error("Native restored member inventory differs from signed custody");
    return result;
  }

  async discard(job: string, cutoff?: number) {
    return await this.run<{state: "removed"; files: number; allocatedBytes: number}>({ action: "discard", job, cutoff });
  }

  async strip(job: string, keepCaseState: boolean) {
    return await this.run<{job_id: string; bytes_freed: number; files_removed: number; kept_case_state: boolean}>({
      action: "legacy", job, keepCaseState,
    });
  }
}
