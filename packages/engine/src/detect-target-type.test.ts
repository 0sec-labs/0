import { describe, expect, it } from "vitest";
import { detectTargetType as detectPrepare } from "./prepare.js";
import { detectTargetType as detectPipeline } from "./unified-pipeline/target-prep.js";

describe.each([["prepare", detectPrepare], ["unified pipeline", detectPipeline]] as const)("detectTargetType (%s)", (_name, detect) => {
  it.each(["HTTP://EXAMPLE.COM", "Https://example.com/a", "  https://example.com  ", "http://user:pw@example.com:8080/x", "http://[::1]:3000/", "https://münchen.de/ä"])("treats %j as a url", target => {
    expect(detect(target)).toBe("url");
  });
  it.each(["--registry=http://127.0.0.1/", "-g", "file:///etc/passwd", "git+https://github.com/a/b", "my project dir"])("never treats %j as an npm package", target => {
    expect(detect(target)).not.toBe("npm-package");
  });
  it("keeps real package names as packages", () => {
    for (const name of ["lodash", "@scope/pkg@1.2.3", "node-forge@0.10.0"]) expect(detect(name)).toBe("npm-package");
  });
});
