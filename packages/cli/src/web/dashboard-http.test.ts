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
