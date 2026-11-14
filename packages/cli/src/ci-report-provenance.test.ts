import { describe, expect, it } from "vitest";
import { ciReportProvenance } from "./ci-report-provenance.js";
describe("browser CI provenance projection", () => {
  it("exposes source identity without the raw report or executable claims", () => {
    const value=ciReportProvenance(JSON.stringify({originalReport:{secret:"private",verificationSpec:{command:"touch /tmp/no"}},ciImport:{schemaVersion:1,source:"ci",trust:"unverified",digest:"a".repeat(64),importedAt:"2026-11-13T10:00:00Z",sourceExecutionStatus:"failed",metadata:{repository:"example/app",reviewedRevision:"abc",githubEventRevision:"different",cliExitCode:2,secret:"private"}}}));
    expect(value).toMatchObject({trust:"unverified",sourceExecutionStatus:"failed",repository:"example/app",reviewedRevision:"abc",githubEventRevision:"different",cliExitCode:2});
    expect(JSON.stringify(value)).not.toMatch(/secret|private|verificationSpec/);
  });
  it("ignores malformed/native summaries and never promotes unknown status", () => {
    for(const value of [undefined,"null","not JSON",'{}','{"ciImport":{"schemaVersion":1,"trust":"verified"}}']) expect(ciReportProvenance(value)).toBeUndefined();
    expect(ciReportProvenance(JSON.stringify({ciImport:{schemaVersion:1,source:"ci",trust:"unverified",digest:"a".repeat(64),importedAt:"date",sourceExecutionStatus:"invented"}}))?.sourceExecutionStatus).toBe("unknown");
  });
});
