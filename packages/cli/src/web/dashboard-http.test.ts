import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebRequestError, errorStatusCode, readJsonObject } from "./dashboard-http.js";

const body = (text: string) => Readable.from([Buffer.from(text)]) as never;

describe("dashboard http errors", () => {
  it("maps malformed percent-encoding in a path to a client error", () => {
    expect(() => decodeURIComponent("%zz")).toThrow(URIError);
    expect(errorStatusCode(new URIError("URI malformed"))).toBe(400);
  });

  it("requires a JSON object body", async () => {
    await expect(readJsonObject(body('{"a":1}'))).resolves.toEqual({ a: 1 });
    for (const bad of ["null", "[]", '"x"', "7"]) {
      await expect(readJsonObject(body(bad))).rejects.toMatchObject({ statusCode: 400 });
      await expect(readJsonObject(body(bad))).rejects.toBeInstanceOf(WebRequestError);
    }
  });
});

describe("json() compression and conditional GET", () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "lorem ipsum dolor sit amet" })) };
  const small = { ok: true };

  async function serve(handler: (res: import("node:http").ServerResponse) => void) {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => handler(res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    return { port, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }
  async function get(port: number, headers: Record<string, string>) {
    const { request } = await import("node:http");
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/", headers }, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject).end();
    });
  }

  it("negotiates gzip, brotli and identity for large bodies only", async () => {
    const { gunzipSync, brotliDecompressSync } = await import("node:zlib");
    const { json } = await import("./dashboard-http.js");
    const s = await serve(res => json(res, 200, big));
    try {
      const gz = await get(s.port, { "accept-encoding": "gzip" });
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(gz.headers["vary"]).toBe("Accept-Encoding");
      expect(gz.body.length).toBeLessThan(JSON.stringify(big).length / 4);
      expect(JSON.parse(gunzipSync(gz.body).toString())).toEqual(big);
      const br = await get(s.port, { "accept-encoding": "gzip, br" });
      expect(br.headers["content-encoding"]).toBe("br");
      expect(JSON.parse(brotliDecompressSync(br.body).toString())).toEqual(big);
      const identity = await get(s.port, {});
      expect(identity.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(identity.body.toString())).toEqual(big);
      const refused = await get(s.port, { "accept-encoding": "gzip;q=0, br;q=0" });
      expect(refused.headers["content-encoding"]).toBeUndefined();
      expect(refused.headers["cache-control"]).toBe("no-store");
    } finally { await s.close(); }
    const t = await serve(res => json(res, 200, small));
    try {
      const r = await get(t.port, { "accept-encoding": "gzip, br" });
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(r.body.toString())).toEqual(small);
    } finally { await t.close(); }
  });

  it("answers a matching If-None-Match with 304 on conditional responses only", async () => {
    const { json } = await import("./dashboard-http.js");
    const s = await serve(res => json(res, 200, big, { conditional: true }));
    try {
      const first = await get(s.port, { "accept-encoding": "gzip" });
      const etag = first.headers["etag"] as string;
      expect(etag).toMatch(/^W\/"/);
      expect(first.headers["cache-control"]).toBe("private, no-cache");
      const again = await get(s.port, { "accept-encoding": "gzip", "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(again.body.length).toBe(0);
      expect((await get(s.port, { "if-none-match": '"other"' })).status).toBe(200);
      expect((await get(s.port, { "if-none-match": `"x", ${etag}` })).status).toBe(304);
    } finally { await s.close(); }
    const plain = await serve(res => json(res, 200, big));
    try {
      const r = await get(plain.port, {});
      expect(r.headers["etag"]).toBeUndefined();
      expect((await get(plain.port, { "if-none-match": "*" })).status).toBe(200);
    } finally { await plain.close(); }
  });
});
