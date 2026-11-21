/** 0#170 — the agent-loop `parsePocStepsArg` helper: JSON strings and parsed arrays in, malformed payloads rejected cleanly. */
import { describe, it, expect } from "vitest";
import type { PocStep } from "./shared/index.js";
import { parsePocStepsArg } from "./agent/tools.js";

function makePocSteps(): PocStep[] {
  return [
    {
      id: "setup-docker",
      kind: "setup",
      summary: "Boot the vulnerable target in Docker",
      action: { type: "shell", cmd: "docker run -d -p 8080:80 vuln/app:latest" },
      expect: { type: "exit-zero" },
    },
    {
      id: "auth-signup",
      kind: "auth",
      summary: "Create a low-privilege attacker account",
      action: {
        type: "http",
        method: "POST",
        url: "http://localhost:8080/signup",
        headers: { "Content-Type": "application/json" },
        body: '{"username":"attacker","password":"hunter2"}',
      },
      expect: { type: "http-status", status: [200, 201] },
    },
    {
      id: "exploit-rce",
      kind: "exploit",
      summary: "Trigger command injection via the avatar URL",
      action: {
        type: "http",
        method: "POST",
        url: "http://localhost:8080/profile/avatar",
        body: 'url=$(id)',
      },
      expect: { type: "body-contains", text: "uid=0(root)" },
    },
    {
      id: "verify-shell",
      kind: "verify",
      summary: "Confirm we landed a shell on the target container",
      action: { type: "docker", image: "kalilinux/kali-rolling", args: ["nc", "127.0.0.1", "4444"] },
      expect: { type: "body-matches", pattern: "root@.*#" },
    },
    {
      id: "note-cleanup",
      kind: "verify",
      summary: "Operator note: tear down the target before re-running",
      action: { type: "note", text: "docker rm -f $(docker ps -q --filter ancestor=vuln/app)" },
    },
  ];
}

describe("parsePocStepsArg (agent tool wire shape, 0#170)", () => {
  it("returns null for nullish / empty / non-string non-array input", () => {
    expect(parsePocStepsArg(null)).toBeNull();
    expect(parsePocStepsArg(undefined)).toBeNull();
    expect(parsePocStepsArg("")).toBeNull();
    expect(parsePocStepsArg(42)).toBeNull();
    expect(parsePocStepsArg(true)).toBeNull();
    expect(parsePocStepsArg({ kind: "setup" })).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parsePocStepsArg("[{")).toBeNull();
    expect(parsePocStepsArg("not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't an array", () => {
    expect(parsePocStepsArg('{"kind":"setup"}')).toBeNull();
    expect(parsePocStepsArg('"setup"')).toBeNull();
    expect(parsePocStepsArg("123")).toBeNull();
  });

  it("parses a JSON-encoded string of valid steps", () => {
    const steps = makePocSteps();
    const out = parsePocStepsArg(JSON.stringify(steps));
    expect(out).not.toBeNull();
    expect(out).toHaveLength(steps.length);
    expect(out![0].id).toBe("setup-docker");
  });

  it("accepts an already-parsed array of valid steps", () => {
    const steps = makePocSteps();
    const out = parsePocStepsArg(steps);
    expect(out).toEqual(steps);
  });

  it("drops individual malformed steps but keeps the well-formed ones", () => {
    const mixed = [
      // good
      {
        id: "ok",
        kind: "exploit",
        summary: "send the payload",
        action: { type: "shell", cmd: "id" },
      },
      // missing id
      { kind: "exploit", summary: "no id", action: { type: "shell", cmd: "id" } },
      // unknown kind
      {
        id: "x",
        kind: "armageddon",
        summary: "bad kind",
        action: { type: "shell", cmd: "id" },
      },
      // unknown action type
      {
        id: "y",
        kind: "exploit",
        summary: "bad action",
        action: { type: "smtp", host: "x" },
      },
      // not an object
      "nope",
      null,
    ];
    const out = parsePocStepsArg(mixed);
    expect(out).toHaveLength(1);
    expect(out![0].id).toBe("ok");
  });

  it("drops a malformed expect predicate but keeps the step itself", () => {
    const out = parsePocStepsArg([
      {
        id: "exp",
        kind: "exploit",
        summary: "send and check",
        action: { type: "shell", cmd: "id" },
        expect: { type: "definitely-not-a-predicate" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0].expect).toBeUndefined();
  });

  it("returns null when every candidate step is malformed", () => {
    const out = parsePocStepsArg([{ kind: "broken" }, "string", 7]);
    expect(out).toBeNull();
  });
});

