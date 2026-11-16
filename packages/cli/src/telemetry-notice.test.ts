import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceFromArgv } from "./surface.js";
import {
  TELEMETRY_DOCS_URL,
  TELEMETRY_NOTICE_FILENAME,
  maybePrintTelemetryNotice,
  wantsMachineOutput,
} from "./telemetry-notice.js";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "0-notice-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function run(h: string, over: Partial<Parameters<typeof maybePrintTelemetryNotice>[0]> = {}) {
  const written: string[] = [];
  const printed = maybePrintTelemetryNotice({
    args: ["scan", "web", "x"], telemetryActive: true, env: {}, stderrIsTTY: true, homeDir: h,
    write: (t) => written.push(t), ...over,
  });
  return { printed, text: written.join("") };
}

describe("first-run telemetry notice", () => {
  it("prints once per install, to the injected stderr writer, naming the opt-outs and real docs URL", () => {
    const h = home();
    const first = run(h);
    expect(first.printed).toBe(true);
    expect(first.text).toContain("anonymous usage counts and crash reports");
    expect(first.text).toContain("no targets, findings or code");
    expect(first.text).toContain(TELEMETRY_DOCS_URL);
    expect(first.text).toContain("ZERO_NO_TELEMETRY=1");
    expect(first.text).toContain("0 config set analyticsLevel off");
    expect(existsSync(join(h, ".0", TELEMETRY_NOTICE_FILENAME))).toBe(true);
    expect(run(h).printed).toBe(false);
    expect(run(h, { args: ["web"] }).printed).toBe(false);
  });

  it("is TTY-only: nothing and no flag when stderr is not a TTY", () => {
    const h = home();
    expect(run(h, { stderrIsTTY: false }).printed).toBe(false);
    expect(existsSync(join(h, ".0", TELEMETRY_NOTICE_FILENAME))).toBe(false);
    expect(run(h).printed).toBe(true);
  });

  it.each([
    [["scan", "x", "--format", "json"]], [["scan", "x", "--format=ndjson"]], [["scan", "--json"]], [["web", "--ready-json"]],
  ])("is silent for machine output %j", (args) => {
    const h = home();
    expect(run(h, { args }).printed).toBe(false);
    expect(existsSync(join(h, ".0", TELEMETRY_NOTICE_FILENAME))).toBe(false);
  });

  it("is silent in CI, for help/version, and for config management", () => {
    const h = home();
    expect(run(h, { env: { CI: "true" } }).printed).toBe(false);
    expect(run(h, { args: ["--help"] }).printed).toBe(false);
    expect(run(h, { args: ["--version"] }).printed).toBe(false);
    expect(run(h, { args: ["config", "set", "analyticsLevel", "off"] }).printed).toBe(false);
    expect(run(h, { env: { ZERO_LOG_FORMAT: "json" } }).printed).toBe(false);
  });

  it("is silent when telemetry is not active or an opt-out env is set", () => {
    const h = home();
    expect(run(h, { telemetryActive: false }).printed).toBe(false);
    for (const name of ["DO_NOT_TRACK", "ZERO_NO_TELEMETRY", "ZERO_OFFLINE"]) {
      expect(run(h, { env: { [name]: "1" } }).printed).toBe(false);
    }
    expect(existsSync(join(h, ".0", TELEMETRY_NOTICE_FILENAME))).toBe(false);
  });

  it("shows on the first `0 web` start as well", () => {
    expect(run(home(), { args: ["web", "--no-open"] }).printed).toBe(true);
    expect(run(home(), { args: [] }).printed).toBe(true);
  });

  it("detects machine output flags", () => {
    expect(wantsMachineOutput(["x", "--format", "text"], {})).toBe(false);
    expect(wantsMachineOutput(["x", "--format", "sarif"], {})).toBe(true);
  });
});

describe("telemetry surface", () => {
  it("is web for `0 web` and a bare `0`, otherwise cli", () => {
    expect(surfaceFromArgv(["node", "0"])).toBe("web");
    expect(surfaceFromArgv(["node", "0", "web", "--port", "1"])).toBe("web");
    expect(surfaceFromArgv(["node", "0", "--headless", "--ready-json"])).toBe("web");
    expect(surfaceFromArgv(["node", "0", "--host=127.0.0.1", "--no-open"])).toBe("web");
    expect(surfaceFromArgv(["node", "0", "scan", "web", "x"])).toBe("cli");
    expect(surfaceFromArgv(["node", "0", "doctor"])).toBe("cli");
  });
});
