import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function stoppedReportReceiptDirectory() {
  return process.env.AIRFOILFOAM_STOPPED_SHARED_REPORT_RECEIPTS ||
    "/data/airfoilfoam/report-archives/shared-result-v1";
}

export function stoppedReportArchivePrefix() {
  return process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1";
}

export async function readReceipt<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function writeReceipt(file: string, value: unknown) {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tmp = join(folder, ".new-" + randomUUID());
  const f = await open(tmp, "wx", 0o600);
  try {
    try {
      await f.writeFile(JSON.stringify(value) + "\n");
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, file);
    const parent = await open(folder, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(tmp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
