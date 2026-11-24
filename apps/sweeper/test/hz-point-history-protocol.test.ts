import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  HistoryMessages,
  boundedPacked,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import {
  PointHistoryHubStorage,
  runHistoryHubSession,
} from "../src/hz-point-history-hub";
import {
  pointHistoryCrc32c,
  type PointHistorySource,
} from "@aerodb/core/point-history-working-copy";

it("reads fragmented and combined messages without closing stdin after the first header", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    channel = new HistoryMessages(input, output);
  input.write(Buffer.from('{"payload":"λ'));
  input.write(Buffer.from('🌬️"}\n{"id":2}\n'));
  expect(await channel.read()).toEqual({ payload: "λ🌬️" });
  expect(await channel.read()).toEqual({ id: 2 });
  input.end();
  await expect(channel.read()).rejects.toMatchObject({ category: "transport" });
  expect(() => boundedPacked("not base64")).toThrow();
});
it("acknowledges the real hub handshake before any upload, keeps exact generations and refuses wrong account/corruption", async () => {
  const account = "canonical@fixture-project.iam.gserviceaccount.com",
    objects = new Map<
      string,
      { bytes: Buffer; generation: string; crc32c: string; metadata: any }
    >();
  let interruptMedia: (() => Promise<never>) | undefined;
  let wrongAccount = false,
    corrupt = false,
    puts = 0;
  const requests: URL[] = [];
  const request = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(init.redirect).toBe("error");
    if (url.pathname.endsWith("/email"))
      return new Response(wrongAccount ? "other" : account, {
        headers: { "Metadata-Flavor": "Google" },
      });
    if (url.pathname.endsWith("/token"))
      return new Response(
        JSON.stringify({
          access_token: "never-log-token",
          token_type: "Bearer",
        }),
        { headers: { "Metadata-Flavor": "Google" } },
      );
    if (url.searchParams.get("uploadType") === "multipart") {
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      const bytes = Buffer.from(init.body as unknown as Buffer),
        boundary = (init.headers as Record<string, string>)[
          "Content-Type"
        ].split("boundary=")[1];
      const jsonStart = bytes.indexOf("\r\n\r\n") + 4,
        jsonEnd = bytes.indexOf(`\r\n--${boundary}`, jsonStart),
        metadata = JSON.parse(bytes.subarray(jsonStart, jsonEnd).toString());
      const start = bytes.indexOf("\r\n\r\n", jsonEnd + 4) + 4,
        end = bytes.indexOf(`\r\n--${boundary}--`, start),
        packed = bytes.subarray(start, end);
      if (objects.has(metadata.name)) return new Response("", { status: 412 });
      puts++;
      objects.set(metadata.name, {
        bytes: Buffer.from(packed),
        generation: "18446744073709551615",
        crc32c: pointHistoryCrc32c(packed),
        metadata,
      });
      return new Response("{}");
    }
    const key = decodeURIComponent(url.pathname.split("/o/")[1]),
      object = objects.get(key);
    if (!object) return new Response("missing", { status: 404 });
    if (url.searchParams.has("generation"))
      expect(url.searchParams.get("generation")).toBe(object.generation);
    if (url.searchParams.get("alt") === "media") {
      if (interruptMedia) {
        const fail = interruptMedia;
        interruptMedia = undefined;
        await fail();
      }
      return new Response(
        new Uint8Array(corrupt ? Buffer.from("bad") : object.bytes),
      );
    }
    return new Response(
      JSON.stringify({
        ...object.metadata,
        generation: object.generation,
        size: String(object.bytes.length),
        crc32c: object.crc32c,
      }),
    );
  }) as typeof fetch;
  const store = new PointHistoryHubStorage("fixture-bucket", account, request),
    toHub = new PassThrough(),
    fromHub = new PassThrough();
  const client = new HistoryMessages(fromHub, toHub),
    server = new HistoryMessages(toHub, fromHub);
  const session = runHistoryHubSession(
    server,
    "fixture-bucket",
    (_bucket, _account) => store,
  );
  await client.send({ id: "hello", bucket: "fixture-bucket", account });
  expect(await client.read()).toMatchObject({
    id: "hello",
    result: { ready: true },
  });
  const source: PointHistorySource = {
    sourceKind: "force_history",
    sourceId: "11111111-1111-4111-8111-111111111111",
    resultId: "22222222-2222-4222-8222-222222222222",
    resultAttemptId: null,
    payloadText:
      '{"t":[0,0.100000000000000000001],"cl":[0.4,0.41],"cd":[0.02,0.021],"cm":null}',
  };
  const first = await store.put("fixture-hz", source),
    second = await store.put("fixture-hz", source);
  await client.send({
    id: "wire-put",
    operation: "put",
    instance: "fixture-hz",
    source,
  });
  const putResponse = await client.read();
  expect(putResponse.id).toBe("wire-put");
  expect(boundedPacked(putResponse.result.packed).equals(first.packed)).toBe(
    true,
  );
  await client.send({
    id: "wire-read",
    operation: "read",
    identity: putResponse.result.identity,
  });
  const readResponse = await client.read();
  expect(boundedPacked(readResponse.result.packed).equals(first.packed)).toBe(
    true,
  );
  expect(puts).toBe(1);
  expect(second.identity.generation).toBe(first.identity.generation);
  expect((await store.read(first.identity)).equals(first.packed)).toBe(true);
  for (const fail of [
    async () => {
      const deadline = AbortSignal.timeout(2);
      await new Promise<void>((done) =>
        deadline.addEventListener("abort", () => done(), { once: true }),
      );
      throw deadline.reason;
    },
    async () => {
      throw new TypeError("private URL and secret", {
        cause: Object.assign(new Error("sensitive transport detail"), {
          code: "ECONNRESET",
        }),
      });
    },
  ]) {
    interruptMedia = fail;
    await client.send({
      id: "lost-after-upload",
      operation: "put",
      instance: "fixture-hz",
      source,
    });
    const lost = await client.read();
    expect(lost.error).toEqual({
      operation: "hub_history_put_transport",
      category: "transport",
      retryable: true,
    });
    await client.send({
      id: "retry-exact",
      operation: "read",
      identity: putResponse.result.identity,
    });
    const recovered = await client.read();
    expect(boundedPacked(recovered.result.packed)).toEqual(first.packed);
    expect(objects.size).toBe(1);
    expect(puts).toBe(1);
  }
  corrupt = true;
  await expect(store.read(first.identity)).rejects.toThrow();
  await client.send({
    id: "corrupt",
    operation: "read",
    identity: putResponse.result.identity,
  });
  expect((await client.read()).error).toEqual({
    operation: "hub_history",
    category: "integrity",
    retryable: false,
  });
  corrupt = false;
  wrongAccount = true;
  await expect(store.read(first.identity)).rejects.toThrow(/identity/);
  expect(
    requests.some(
      (url) => url.searchParams.get("generation") === "18446744073709551615",
    ),
  ).toBe(true);
  await client.send({ operation: "close" });
  await session;
});

it("keeps reads serial, rotates a full channel, and falls back to one-shot old peers", async () => {
  const { AttemptReadSession, MAX_ATTEMPT_READ_MESSAGES } = await import("../src/hz-attempt-read-session");
  for (const supports of [true, false]) {
    let opens = 0, closes = 0, active = 0;
    const seen: unknown[] = [];
    const session = new AttemptReadSession("worker", () => {
      opens++;
      return {
        continuesAttemptReadSession: supports,
        async ask(request) {
          expect(++active).toBe(1);
          seen.push(request.attemptReadSession);
          await Promise.resolve();
          active--;
          return request.index;
        },
        async close() { closes++; },
      };
    });
    const total = MAX_ATTEMPT_READ_MESSAGES + 1;
    const values = Array.from({ length: total }, (_, index) => index);
    expect(await Promise.all(values.map(index => session.ask({operation:"one",index})))).toEqual(values);
    expect(() => session.ask({operation:"commit"})).toThrow(/read operation/);
    await session.close();
    expect(opens).toBe(supports ? 2 : total);
    expect(closes).toBe(opens);
    expect(seen.filter(value => value === "worker")).toHaveLength(supports ? total : 1);
  }
});
