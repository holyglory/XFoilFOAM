import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface WorkerVolumeIdentity {
  storedSha256: string;
  storedByteSize: number;
}
const maxBytes = 512 * 1024 * 1024;
const defaultDirectory = "/data/airfoilfoam/report-archives/v1";

function location(identity: WorkerVolumeIdentity, root: string) {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    !/^[a-f0-9]{64}$/.test(identity.storedSha256) ||
    !Number.isSafeInteger(identity.storedByteSize) ||
    identity.storedByteSize < 1 ||
    identity.storedByteSize > maxBytes
  )
    throw new Error("Invalid compressed worker report identity");
  return join(
    root,
    identity.storedSha256.slice(0, 2),
    identity.storedSha256 + ".jsonl.gz",
  );
}

async function syncDirectory(path: string) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readWorkerReportVolume(
  identity: WorkerVolumeIdentity,
  root = process.env.AIRFOILFOAM_REPORT_VOLUME_DIR || defaultDirectory,
): Promise<Readable | null> {
  const path = location(identity, root);
  try {
    if ((await realpath(dirname(path))) !== dirname(path))
      throw new Error("Unexpected worker report volume path");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== identity.storedByteSize)
        throw new Error(
          "Worker report file size differs from its GCS identity",
        );
      return file.createReadStream({ autoClose: true });
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hashStream(identity: WorkerVolumeIdentity) {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(raw: Buffer, _encoding, done) {
      size += raw.length;
      if (size > identity.storedByteSize)
        return done(new Error("Worker report exceeded its GCS size"));
      hash.update(raw);
      done(null, raw);
    },
    flush(done) {
      done(
        size === identity.storedByteSize &&
          hash.digest("hex") === identity.storedSha256
          ? undefined
          : new Error("Worker report differs from the verified GCS bytes"),
      );
    },
  });
}

// A worker unable to fetch evidence from its hub still needs its own original
// history. Keep one compressed file per exact object on its persistent volume.
export async function storeWorkerReportVolume(
  source: Readable,
  identity: WorkerVolumeIdentity,
  root = process.env.AIRFOILFOAM_REPORT_VOLUME_DIR || defaultDirectory,
): Promise<void> {
  const target = location(identity, root);
  const shard = dirname(target);
  const created = await mkdir(shard, { recursive: true, mode: 0o700 });
  if ((await realpath(shard)) !== shard || !(await lstat(shard)).isDirectory())
    throw new Error("Worker report volume needs a real directory");
  if (created) {
    let dir = shard;
    while (dir !== dirname(created)) {
      await syncDirectory(dirname(dir));
      dir = dirname(dir);
    }
  }
  const temp = join(shard, ".pending-" + randomUUID());
  try {
    await pipeline(
      source,
      hashStream(identity),
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
    );
    const file = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(shard);
    const installed = await readWorkerReportVolume(identity, root);
    if (!installed) throw new Error("Installed worker report is missing");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of installed) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      hash.update(bytes);
    }
    if (
      size !== identity.storedByteSize ||
      hash.digest("hex") !== identity.storedSha256
    )
      throw new Error("Installed worker report failed exact readback");
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function retainWorkerReportVolume(
  path: string,
  identity: WorkerVolumeIdentity,
) {
  return storeWorkerReportVolume(createReadStream(path), identity);
}

export async function* workerReportVolumeFiles(root = process.env.AIRFOILFOAM_REPORT_VOLUME_DIR || defaultDirectory) {
  let directory;
  try { directory=await opendir(root); }
  catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return; throw error; }
  for await (const shard of directory) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    for await (const file of await opendir(join(root,shard.name))) {
      if (!file.isFile() || !file.name.startsWith(shard.name) || !/^[a-f0-9]{64}\.jsonl\.gz$/.test(file.name)) continue;
      const storedSha256=file.name.slice(0,64);
      const info=await lstat(join(root,shard.name,file.name));
      yield {storedSha256,storedByteSize:info.size};
    }
  }
}

/** The caller must freshly restore each catalogued use through the registered
 * upstream reader before the worker can give up its private working copy. */
export async function releaseVerifiedWorkerVolume(identity: WorkerVolumeIdentity,
  upstreamReadable: () => Promise<boolean>,root = process.env.AIRFOILFOAM_REPORT_VOLUME_DIR || defaultDirectory) {
  const path=location(identity,root);
  const before=await lstat(path,{bigint:true});
  if (!before.isFile() || before.size!==BigInt(identity.storedByteSize) || before.nlink!==1n) return false;
  if (!await upstreamReadable()) return false;
  const local=await readWorkerReportVolume(identity,root);
  if (!local) return false;
  const hash=createHash("sha256");
  for await (const chunk of local) hash.update(chunk);
  if (hash.digest("hex")!==identity.storedSha256) throw new Error("Local working copy differs from verified cloud content");
  const now=await lstat(path,{bigint:true});
  if (now.dev!==before.dev || now.ino!==before.ino || now.ctimeNs!==before.ctimeNs) return false;
  await unlink(path);
  await syncDirectory(dirname(path));
  return true;
}
