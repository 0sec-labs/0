import { describe, expect, it } from "vitest";
import { restartCommand } from "./self-restart.js";

describe("restartCommand", () => {
  it("re-runs a compiled binary with the same arguments, the bound port and no browser tab", () => {
    expect(restartCommand({ execPath: "/opt/0/bin/0", argv: ["/opt/0/bin/0", "/$bunfs/root/0", "web", "--port", "0", "--db-path", "/d/x.db", "--asset-dir", "/a"], compiled: true, port: 51234 }))
      .toEqual({ command: "/opt/0/bin/0", args: ["web", "--db-path", "/d/x.db", "--asset-dir", "/a", "--port", "51234", "--no-open"] });
  });
  it("drops --port=N too, and does not repeat --no-open", () => {
    expect(restartCommand({ execPath: "/x/0", argv: ["/x/0", "/$bunfs/root/0", "web", "--port=48123", "--no-open"], compiled: true, port: 48124 }).args)
      .toEqual(["web", "--no-open", "--port", "48124"]);
  });
  it("keeps the script path and runtime flags for a non-compiled start", () => {
    expect(restartCommand({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/r/dist/index.js", "web"], execArgv: ["--max-old-space-size=4096"], compiled: false }).args)
      .toEqual(["--max-old-space-size=4096", "/r/dist/index.js", "web", "--no-open"]);
  });
});
