import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { Readable } from "node:stream";

import { env } from "./env";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".gz": "application/gzip",
};

function mimeFor(key: string): string {
  const i = key.lastIndexOf(".");
  return (i >= 0 && MIME[key.slice(i).toLowerCase()]) || "application/octet-stream";
}

/**
 * Media abstraction. The default serves files from the shared CFD data volume
 * that the Python engine writes into. Swap for an S3/MinIO impl later — only
 * this file changes.
 */
export interface MediaStore {
  stream(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number; mime: string }>;
  url(key: string): string;
}

export class VolumeMediaStore implements MediaStore {
  constructor(private baseDir: string = env.mediaDir) {}

  private resolveKey(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    const base = resolve(this.baseDir);
    const full = resolve(base, clean);
    if (full !== base && !full.startsWith(base + "/")) throw new Error("path traversal blocked");
    return full;
  }

  async stream(key: string) {
    const full = this.resolveKey(key);
    try {
      const s = await stat(full);
      return { stream: createReadStream(full), size: s.size, mime: mimeFor(key) };
    } catch (err) {
      const proxied = await this.streamFromEngine(key);
      if (proxied) return proxied;
      throw err;
    }
  }

  url(key: string): string {
    return `/api/media/${key.replace(/^\/+/, "")}`;
  }

  private async streamFromEngine(key: string) {
    const m = key.match(/^jobs\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const url = `${env.engineUrl.replace(/\/$/, "")}/jobs/${encodeURIComponent(m[1])}/files/${m[2]}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) return null;
    const size = Number(res.headers.get("content-length") ?? 0);
    const mime = res.headers.get("content-type") ?? mimeFor(key);
    return {
      stream: Readable.fromWeb(res.body),
      size,
      mime,
    };
  }
}

export const mediaStore: MediaStore = new VolumeMediaStore();
