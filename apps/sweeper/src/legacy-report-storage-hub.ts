import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  assertLegacyObject,
  LegacyStorageOperationError,
  legacySshOperationError,
  legacySha256,
  type LegacyBackupObject,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";

/** The code is public source, passed as a single quoted argument. Only backup
 * bytes and nonsecret object identity cross stdin/stdout. Tokens stay on hub. */
export async function legacyHubHelperSource(): Promise<string> {
  const source = await readFile(
    new URL("./legacy-report-storage-gcs.ts", import.meta.url),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
  return (
    javascript +
    `
let operation='hub_read';
try {
 let header = Buffer.alloc(0), request, parts = [], size = 0;
 for await (const chunk of process.stdin) {
   let bytes = Buffer.from(chunk);
   if (!request) {
     header = Buffer.concat([header,bytes]);
     const newline = header.indexOf(10);
     if (newline < 0) { if (header.length > 65536) throw Error('Oversized helper request'); continue; }
     if (newline > 65536) throw Error('Oversized helper request');
     request = JSON.parse(header.subarray(0,newline).toString('utf8'));
     operation=request.operation==='put'?'hub_put':'hub_read';
     if (!['put','read'].includes(request.operation) || !Number.isSafeInteger(request.inputBytes) || request.inputBytes<0 || request.inputBytes>536870912)
       throw Error('Invalid helper request');
     bytes = header.subarray(newline+1); header = Buffer.alloc(0);
   }
   size += bytes.length;
   if (size > request.inputBytes) throw Error('Helper input exceeds bound');
   parts.push(bytes);
 }
 if (!request || size !== request.inputBytes) throw Error('Truncated helper input');
 const store = new LegacyHubGcsStore(request.bucket,request.serviceAccount);
 if (request.operation === 'put') {
   const bytes=Buffer.concat(parts);
   if (legacySha256(bytes)!==request.sha256) throw Error('Helper input hash mismatch');
   const object=await store.put(request.objectKey,bytes);
   process.stdout.write(JSON.stringify(object)+'\\n');
 } else {
   if (size!==0) throw Error('Read helper cannot accept a body');
   process.stdout.write(await store.read(request.object));
 }
 } catch(error) {
 const category=/hash|SHA|mismatch|truncated|exceeds|byte.*bound/i.test(error.message??'')?'integrity':/invalid|required|must/i.test(error.message??'')?'bad_input':'operation_failed';
 const failure=error instanceof LegacyStorageOperationError ? error : new LegacyStorageOperationError({operation,category});
 process.stderr.write('LEGACY_STORAGE_FAILURE '+JSON.stringify(failure.details)+'\\n');process.exitCode=74;
}
`
  );
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/** Production topology: dev owns BOTH SSH sessions. The hub never SSHes to HZ. */
export class LegacyHubSshStore implements LegacyBackupStore {
  private provenTarget = false;
  acceptVerifiedTransportHistory() {
    this.provenTarget = true;
  }
  constructor(
    readonly host: string,
    readonly container: string,
    private readonly bucket: string,
    private readonly serviceAccount: string,
  ) {
    if (
      !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(container)
    )
      throw new Error(
        "Use the existing hub SSH alias and exact sweeper container",
      );
  }

  private async run(
    request: Record<string, unknown>,
    bytes: Buffer,
    outputLimit: number,
  ): Promise<Buffer> {
    const helper = await legacyHubHelperSource();
    const command = `docker exec -i ${this.container} node --input-type=module -e ${quote(helper)}`;
    return new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        "ssh",
        [
          "-T",
          "-C",
          "-oBatchMode=yes",
          "-oStrictHostKeyChecking=yes",
          "-oConnectTimeout=10",
          this.host,
          command,
        ],
        {
          timeout: 600000,
          maxBuffer: outputLimit,
          encoding: "buffer",
          killSignal: "SIGTERM",
        },
        (error, stdout, stderr) => {
          if (error) {
            const operation =
              request.operation === "put" ? "hub_put" : "hub_read";
            const wire = stderr
              .toString("utf8")
              .slice(0, 16384)
              .split("\n")
              .find((line) => line.startsWith("LEGACY_STORAGE_FAILURE "));
            if (wire)
              try {
                const details = JSON.parse(
                  wire.slice("LEGACY_STORAGE_FAILURE ".length),
                );
                if (
                  String(details.operation).startsWith("gcs_") &&
                  typeof details.httpStatus === "number"
                )
                  this.provenTarget = true;
                reject(
                  new LegacyStorageOperationError({
                    ...details,
                    exitCode: details.exitCode ?? error.code,
                    signal: details.signal ?? error.signal,
                  }),
                );
                return;
              } catch {
                /* Unrecognized protocol fails closed; never print raw output. */
              }
            reject(
              legacySshOperationError(
                operation,
                error,
                stderr,
                this.provenTarget,
              ),
            );
          } else resolve(stdout);
        },
      );
      child.stdin!.on("error", () => undefined);
      child.stdin!.write(
        JSON.stringify({
          ...request,
          bucket: this.bucket,
          serviceAccount: this.serviceAccount,
          inputBytes: bytes.length,
        }) + "\n",
      );
      child.stdin!.end(bytes);
    });
  }

  async put(objectKey: string, bytes: Buffer): Promise<LegacyBackupObject> {
    const object = JSON.parse(
      (
        await this.run(
          { operation: "put", objectKey, sha256: legacySha256(bytes) },
          bytes,
          65536,
        )
      ).toString("utf8"),
    ) as LegacyBackupObject;
    assertLegacyObject(object);
    if (
      object.bucket !== this.bucket ||
      object.objectKey !== objectKey ||
      object.sha256 !== legacySha256(bytes) ||
      object.byteSize !== bytes.length
    )
      throw new Error("Hub returned another backup object");
    this.provenTarget = true;
    return object;
  }
  async read(object: LegacyBackupObject): Promise<Buffer> {
    assertLegacyObject(object);
    if (object.bucket !== this.bucket)
      throw new Error("Backup bucket mismatch");
    const bytes = await this.run(
      { operation: "read", object },
      Buffer.alloc(0),
      Math.max(object.byteSize + 65536, 1024 * 1024),
    );
    if (
      bytes.length !== object.byteSize ||
      legacySha256(bytes) !== object.sha256
    )
      throw new Error("Hub readback size/SHA256 mismatch");
    this.provenTarget = true;
    return bytes;
  }
}
