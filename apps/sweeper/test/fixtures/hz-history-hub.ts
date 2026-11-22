import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CRC32C } from "@google-cloud/storage";
import {
  runHistoryHubSession,
  PointHistoryHubStorage,
} from "../../src/hz-point-history-hub";
import { HistoryMessages } from "@aerodb/core/point-history-protocol";

// The hub helper and its wire protocol are real. The only external API in
// this fixture is a file-backed stand-in for Google's metadata/object endpoints.
const root = process.env.HISTORY_TEST_STATE!;
const fixtureFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (init.redirect !== "error") throw new Error("unexpected redirect policy");
  if (url.hostname === "metadata.google.internal") {
    const headers = { "Metadata-Flavor": "Google" };
    if (url.pathname.endsWith("/email"))
      return new Response("canonical@fixture-project.iam.gserviceaccount.com", {
        headers,
      });
    return new Response(
      JSON.stringify({ access_token: "fixture", token_type: "Bearer" }),
      { headers },
    );
  }
  if (
    url.hostname !== "storage.googleapis.com" ||
    new Headers(init.headers).get("Authorization") !== "Bearer fixture"
  )
    return new Response("", { status: 403 });
  const path = (key: string) =>
    join(root, createHash("sha256").update(key).digest("hex"));
  if (url.searchParams.get("uploadType") === "multipart") {
    if (url.searchParams.get("ifGenerationMatch") !== "0")
      return new Response("", { status: 400 });
    const bytes = Buffer.from(init.body as unknown as Buffer);
    const boundary = new Headers(init.headers)
      .get("Content-Type")!
      .split("boundary=")[1];
    const start = bytes.indexOf("\r\n\r\n") + 4,
      split = bytes.indexOf("\r\n--" + boundary, start);
    const meta = JSON.parse(bytes.subarray(start, split).toString("utf8"));
    const dataStart = bytes.indexOf("\r\n\r\n", split + 4) + 4;
    const packed = bytes.subarray(
      dataStart,
      bytes.indexOf("\r\n--" + boundary + "--", dataStart),
    );
    const crc = new CRC32C();
    crc.update(packed);
    try {
      await writeFile(path(meta.name) + ".gz", packed, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return new Response("", { status: 412 });
      throw error;
    }
    await writeFile(
      path(meta.name) + ".json",
      JSON.stringify({
        ...meta,
        size: String(packed.length),
        crc32c: crc.toString(),
        generation: "18446744073709551615",
      }),
    );
    return new Response("{}");
  }
  const key = decodeURIComponent(url.pathname.split("/o/")[1]);
  const meta = await readFile(path(key) + ".json", "utf8");
  const gen = url.searchParams.get("generation");
  if (gen !== null && gen !== JSON.parse(meta).generation)
    return new Response("", { status: 404 });
  if (url.searchParams.get("alt") === "media") {
    if (!gen) return new Response("", { status: 412 });
    return new Response(new Uint8Array(await readFile(path(key) + ".gz")));
  }
  return new Response(meta);
};
await runHistoryHubSession(
  new HistoryMessages(process.stdin, process.stdout),
  "fixture-bucket",
  (bucket, account) =>
    new PointHistoryHubStorage(bucket, account, fixtureFetch),
);
