import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { CRC32C } from "@google-cloud/storage";

/** A loopback GCS JSON-API transport for the real SDK. Records pins, reads,
 * unique allocated bytes, preconditions and absence of an upload on replay. */
export async function startReportObjectServer() {
  const objects = new Map<
    string,
    { metadata: Record<string, unknown>; bytes: Buffer }
  >();
  const sessions = new Map<
    string,
    { key: string; metadata: Record<string, unknown> }
  >();
  const media: string[] = [],
    requests: string[] = [];
  let next = 9007199254740993123n;
  const app = createServer(async (req, res) => {
    const base = "http://" + req.headers.host,
      url = new URL(req.url!, base);
    let status = 200;
    const json = (code: number, value: unknown) => {
      status = code;
      const raw = Buffer.from(JSON.stringify(value));
      res.writeHead(code, {
        "content-type": "application/json",
        "content-length": raw.length,
      });
      res.end(raw);
    };
    requests.push(req.method + " " + url.pathname);
    res.once("finish", () =>
      requests.push("HTTP " + res.statusCode + " " + url.pathname),
    );
    try {
      const chunks: Buffer[] = [];
      for await (const b of req) chunks.push(Buffer.from(b));
      const body = Buffer.concat(chunks);
      const put = (
        key: string,
        meta: Record<string, unknown>,
        bytes: Buffer,
      ) => {
        if (objects.has(key))
          return json(412, {
            error: { code: 412, message: "immutable object exists" },
          });
        const crc = new CRC32C();
        crc.update(bytes);
        const metadata = {
          ...meta,
          kind: "storage#object",
          bucket: "shared-fixture",
          name: key,
          generation: String(++next),
          size: String(bytes.length),
          crc32c: crc.toString(),
        };
        objects.set(key, { metadata, bytes });
        json(200, metadata);
      };
      if (
        url.pathname.includes("/upload/storage/v1/") &&
        req.method === "POST"
      ) {
        if (url.searchParams.get("ifGenerationMatch") !== "0")
          return json(400, {
            error: { code: 400, message: "expected create-only" },
          });
        if (url.searchParams.get("uploadType") === "resumable") {
          const meta = JSON.parse(body.toString()),
            key = url.searchParams.get("name") ?? meta.name,
            id = randomUUID();
          sessions.set(id, {
            key,
            metadata: {
              ...meta,
              contentType:
                meta.contentType ?? req.headers["x-upload-content-type"],
            },
          });
          res.writeHead(200, {
            location: base + "/session/" + id,
            "content-length": 0,
          });
          return res.end();
        }
        const boundary = String(req.headers["content-type"]).match(
          /boundary="?([^";\s]+)/,
        )?.[1];
        if (!boundary) throw Error("No multipart boundary");
        const d = Buffer.from("--" + boundary),
          mid = body.indexOf(d, d.length),
          end = body.indexOf(d, mid + d.length),
          b1 = body.indexOf("\r\n\r\n") + 4,
          b2 = body.indexOf("\r\n\r\n", mid) + 4;
        const meta = JSON.parse(body.subarray(b1, mid - 2).toString());
        const key = url.searchParams.get("name") ?? meta.name;
        return put(key, meta, body.subarray(b2, end - 2));
      }
      if (url.pathname.startsWith("/session/") && req.method === "PUT") {
        const session = sessions.get(url.pathname.split("/").pop()!);
        if (!session) throw Error("Unknown upload session");
        return put(session.key, session.metadata, body);
      }
      const match = url.pathname.match(/\/b\/[^/]+\/o\/(.+)$/);
      if (!match)
        return json(404, {
          error: { code: 404, message: "unknown route " + url.pathname },
        });
      const key = decodeURIComponent(match[1]);
      const o = objects.get(key),
        gen = url.searchParams.get("generation");
      if (!o || (gen !== null && gen !== o.metadata.generation))
        return json(404, {
          error: { code: 404, message: "unknown generation" },
        });
      if (url.searchParams.get("alt") === "media") {
        if (gen !== o.metadata.generation) throw Error("Unpinned media GET");
        media.push(key + "@" + gen);
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": o.bytes.length,
          "x-goog-generation": String(gen),
          "x-goog-hash": "crc32c=" + o.metadata.crc32c,
        });
        res.end(o.bytes);
        return;
      }
      return json(200, o.metadata);
    } catch (e) {
      requests.push(String(e));
      if (!res.headersSent)
        json(500, { error: { code: 500, message: String(e) } });
      else res.destroy();
    }
  });
  await new Promise<void>((ok, fail) => {
    app.once("error", fail);
    app.listen(0, "127.0.0.1", ok);
  });
  const addr = app.address();
  if (!addr || typeof addr === "string") throw Error("Missing test socket");
  return {
    url: "http://127.0.0.1:" + addr.port,
    objects,
    media,
    requests,
    close: async () => {
      app.closeAllConnections();
      await new Promise<void>((r) => app.close(() => r()));
    },
  };
}
