import { createHash } from "node:crypto";
import { accessMilestoneFromArtifact } from "@0/shared";
import { osecDB } from "@0/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../tools.js";
import { SessionEngine } from "../session.js";
import type { ToolContext } from "../types.js";
import { fetchScoped } from "../../http.js";

vi.mock("../../http.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchScoped: vi.fn(),
}));

const target = "https://target.test";
const request = {
  allow_mutation: true, owner_identity: "owner", actor_identity: "actor",
  observation_url: `${target}/resource`, observation_json_pointer: "/marker", expected_state: "unique-marker",
  steps: [{ method: "POST", url: `${target}/resource`, body: '{"marker":"unique-marker"}' }],
};
function executor(db: osecDB | null = null, fixtures?: ToolContext["accessControlFixtures"]) {
  const session = new SessionEngine([
    { label: "owner", role: "admin", auth: { type: "bearer", token: "owner-secret" } },
    { label: "actor", role: "user", auth: { type: "bearer", token: "actor-secret" } },
  ]);
  const context: ToolContext = { target, scanId: "workflow", findings: [], attackResults: [], targetInfo: {}, session, accessControlFixtures: fixtures };
  return new ToolExecutor(context, db);
}
const response = (marker: unknown, status = 200) => new Response(JSON.stringify({ marker }), { status });
afterEach(() => vi.mocked(fetchScoped).mockReset());

describe("access_control_workflow", () => {
  it("confirms a real state transition with isolated owner and actor credentials", async () => {
    let marker = "before";
    const identities: string[] = [];
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      identities.push(new Headers(init.headers).get("authorization") ?? "");
      if (init.method === "POST") marker = "unique-marker";
      return response(marker);
    });
    const result = await executor().execute({ name: "access_control_workflow", arguments: request });
    expect(result.output).toMatchObject({ verdict: "confirmed" });
    expect(identities).toEqual(["Bearer owner-secret", "Bearer actor-secret", "Bearer owner-secret"]);
    expect(JSON.stringify(result)).not.toContain("owner-secret");
    expect(JSON.stringify(result)).not.toContain("actor-secret");
  });

  it("retains host-observed conditional milestone evidence without inferring authorization or cleanup", async () => {
    const db = new osecDB(":memory:");
    db.createScan({ target, mode: "web", depth: "default", format: "json", timeout: 5000, runtime: "api" }, "workflow");
    let marker: string | null = null;
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      if (init.method === "POST") marker = "unique-marker";
      return response(marker);
    });
    try {
      await executor(db).execute({ name: "access_control_workflow", arguments: request });
      const artifact = db.getEvents("workflow", { eventType: "tool_artifact" })[0];
      expect(artifact).toBeDefined();
      const milestone = accessMilestoneFromArtifact(artifact.eventType, JSON.parse(artifact.payload), artifact.scanId);
      expect(milestone).toMatchObject({ status: "conditional", cleanup: "unknown", asset: target });
      expect(artifact.payload).not.toContain("owner-secret");
      expect(artifact.payload).not.toContain("actor-secret");
    } finally { db.close(); }
  });

  it("does not treat successful HTTP status alone as an authorization break", async () => {
    vi.mocked(fetchScoped).mockImplementation(async () => response("before"));
    const result = await executor().execute({ name: "access_control_workflow", arguments: request });
    expect(result.output).toMatchObject({ verdict: "no_change" });
  });

  it("requires successful owner observations, even when an error body contains the marker", async () => {
    vi.mocked(fetchScoped)
      .mockResolvedValueOnce(response("before"))
      .mockResolvedValueOnce(response("ok"))
      .mockResolvedValueOnce(response("unique-marker", 403));
    const result = await executor().execute({ name: "access_control_workflow", arguments: request });
    expect(result.output).toMatchObject({ verdict: "inconclusive" });
  });

  it("rejects an invalid later step before sending an earlier mutating request", async () => {
    const result = await executor().execute({ name: "access_control_workflow", arguments: {
      ...request, steps: [...request.steps, { method: "POST", url: `${target}/resource`, headers: { Authorization: "Bearer owner-secret" } }],
    } });
    expect(result.success).toBe(false);
    expect(fetchScoped).not.toHaveBeenCalled();
  });

  it("requires mutation consent before making any request", async () => {
    const result = await executor().execute({ name: "access_control_workflow", arguments: { ...request, allow_mutation: false } });
    expect(result.success).toBe(false);
    expect(fetchScoped).not.toHaveBeenCalled();
  });

  it("stops a workflow after a transport failure and refuses to attribute a concurrent change", async () => {
    vi.mocked(fetchScoped)
      .mockResolvedValueOnce(response("before"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(response("unique-marker"));
    const result = await executor().execute({ name: "access_control_workflow", arguments: {
      ...request, steps: [...request.steps, { method: "DELETE", url: `${target}/resource` }],
    } });
    expect(result.output).toMatchObject({ verdict: "inconclusive", steps: [{ error: "connection reset" }] });
    expect(fetchScoped).toHaveBeenCalledTimes(3);
  });

  it("does not coerce a number into the declared string marker", async () => {
    vi.mocked(fetchScoped)
      .mockResolvedValueOnce(response("before")).mockResolvedValueOnce(response("ok"))
      .mockResolvedValueOnce(response(42));
    const result = await executor().execute({ name: "access_control_workflow", arguments: { ...request, expected_state: "42" } });
    expect(result.output).toMatchObject({ verdict: "inconclusive" });
  });

  it("accepts null as a present baseline value, not a missing pointer", async () => {
    vi.mocked(fetchScoped)
      .mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response("ok"))
      .mockResolvedValueOnce(response("unique-marker"));
    const result = await executor().execute({ name: "access_control_workflow", arguments: request });
    expect(result.output).toMatchObject({ verdict: "confirmed" });
  });

  it("does not mutate when the expected marker already exists", async () => {
    vi.mocked(fetchScoped).mockImplementation(async () => response("unique-marker"));
    const result = await executor().execute({ name: "access_control_workflow", arguments: request });
    expect(result.output).toMatchObject({ verdict: "no_change" });
    expect(fetchScoped).toHaveBeenCalledTimes(1);
  });
});

describe("operator-owned read milestone receipts", () => {
  const marker = "PRIVATE_OWNER_CANARY_12345";
  const fixture = { url: `${target}/resource`, ownerIdentity: "owner", comparisonIdentities: ["actor"], ownershipMarker: marker };
  const probe = { url: fixture.url, baseline_identity: "owner", compare_identities: ["actor"], ownership_marker: marker, expect_denied: true };
  it.each([true, false])("retains confirmed or blocked read proof only with a configured fixture (allowed=%s)", async allowed => {
    const db = new osecDB(":memory:");
    db.createScan({ target, mode: "web", depth: "default", format: "json", timeout: 5000, runtime: "api" }, "workflow");
    vi.mocked(fetchScoped).mockResolvedValueOnce(response(marker)).mockResolvedValueOnce(allowed ? response(marker) : response(null, 403));
    try {
      await executor(db, [fixture]).execute({ name: "access_control_probe", arguments: probe });
      const artifact = db.getEvents("workflow", { eventType: "tool_artifact" })[0];
      const milestone = accessMilestoneFromArtifact(artifact.eventType, JSON.parse(artifact.payload), artifact.scanId);
      expect(milestone).toMatchObject({ status: allowed ? "confirmed" : "blocked", cleanup: "not-required", asset: target });
      expect(artifact.payload).not.toContain(marker); expect(artifact.payload).not.toContain("owner-secret");
    } finally { db.close(); }
  });
  it.each(["truncated", "partial-coverage"])("does not overstate %s evidence", async kind => {
    const db = new osecDB(":memory:");
    db.createScan({ target, mode: "web", depth: "default", format: "json", timeout: 5000, runtime: "api" }, "workflow");
    vi.mocked(fetchScoped).mockResolvedValueOnce(response(marker)).mockResolvedValueOnce(kind === "truncated" ? response(marker + "x".repeat(11000)) : response(null, 403));
    try {
      await executor(db, [{ ...fixture, comparisonIdentities: kind === "partial-coverage" ? ["actor", "untested"] : ["actor"] }]).execute({ name: "access_control_probe", arguments: probe });
      const artifact = db.getEvents("workflow", { eventType: "tool_artifact" })[0];
      expect(accessMilestoneFromArtifact(artifact.eventType, JSON.parse(artifact.payload), artifact.scanId)).toBeNull();
    } finally { db.close(); }
  });
  it("does not elevate a model-supplied ownership assertion into a milestone", async () => {
    const db = new osecDB(":memory:");
    db.createScan({ target, mode: "web", depth: "default", format: "json", timeout: 5000, runtime: "api" }, "workflow");
    vi.mocked(fetchScoped).mockImplementation(async () => response(marker));
    try {
      await executor(db).execute({ name: "access_control_probe", arguments: probe });
      const artifact = db.getEvents("workflow", { eventType: "tool_artifact" })[0];
      expect(accessMilestoneFromArtifact(artifact.eventType, JSON.parse(artifact.payload), artifact.scanId)).toBeNull();
    } finally { db.close(); }
  });
});

describe("fixture-backed state milestones and read-only cleanup", () => {
  const writeMarker = "PRIVATE_STATE_MARKER_34f70dff321e45";
  const writeRequest = { ...request, expected_state: writeMarker, steps: [{ ...request.steps[0], body: JSON.stringify({ marker: writeMarker }) }] };
  const fixture = { url: request.observation_url, ownerIdentity: "owner", comparisonIdentities: ["actor"],
    ownershipMarker: writeMarker, stateChange: { disposable: true as const, jsonPointer: "/marker", stepUrls: [request.observation_url] } };
  function database() {
    const db = new osecDB(":memory:");
    db.createScan({ target, mode: "web", depth: "default", format: "json", timeout: 5000, runtime: "api" }, "workflow");
    return db;
  }
  const cleanup = { name: "access_control_cleanup", arguments: { observation_url: request.observation_url, owner_identity: "owner" } };
  it("emits a confirmed write only for the operator restriction, then recovers cleanup authority in a fresh executor", async () => {
    const db = database(); let marker: string | null = "original-private-state";
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      if (init.method === "POST") marker = JSON.parse(String(init.body)).marker;
      return response(marker);
    });
    try {
      const result = await executor(db, [fixture]).execute({ name: "access_control_workflow", arguments: writeRequest });
      const proof = (result.output as any).state_access_proof;
      const sentBody = String(vi.mocked(fetchScoped).mock.calls[1][1]?.body);
      expect(sentBody).not.toContain(writeMarker);
      expect((result.output as any).steps[0].request_body_digest).toBe("sha256:" + createHash("sha256").update(sentBody).digest("hex"));
      expect((result.output as any).steps[0].request_body_bytes).toBe(Buffer.byteLength(sentBody));
      expect(proof).toMatchObject({ challenge_bound: true, access_class: "unauthorized-write", status: "confirmed", cleanup: "required", generation: 1 });
      const original = db.getEvents("workflow", { eventType: "tool_artifact" })[0];
      expect(accessMilestoneFromArtifact(original.eventType, JSON.parse(original.payload), original.scanId, original.id)).toMatchObject({ status: "confirmed", severity: "unassessed", cleanup: "required", accessLevel: "Resource write" });
      marker = "original-private-state";
      vi.mocked(fetchScoped).mockClear();
      const restored = await executor(db, [fixture]).execute(cleanup);
      expect(restored).toMatchObject({ success: true, output: { state_access_proof: { proof_id: proof.proof_id, cleanup: "completed", cleanup_revision: 1 } } });
      expect(vi.mocked(fetchScoped)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchScoped).mock.calls[0][1]).toMatchObject({ method: "GET" });
      const receipt = db.getRecentScanEvents("workflow", "tool_artifact", 5)[0];
      const milestone = accessMilestoneFromArtifact(receipt.eventType, JSON.parse(receipt.payload), receipt.scanId, receipt.id)!;
      expect(milestone).toMatchObject({ status: "confirmed", cleanup: "completed", evidenceEventId: original.id, cleanupEvidenceEventId: receipt.id });
      expect(receipt.payload).not.toContain("original-private-state");
      expect(receipt.payload).not.toContain("owner-secret");
    } finally { db.close(); }
  });
  it.each(["unconfigured", "wrong-pointer", "wrong-step", "redacted", "long-baseline", "numeric-baseline"])("does not elevate %s observations", async kind => {
    const db = database();
    const configured = kind === "unconfigured" ? undefined : [{ ...fixture, stateChange: { ...fixture.stateChange,
      jsonPointer: kind === "wrong-pointer" ? "/other" : "/marker", stepUrls: kind === "wrong-step" ? [`${target}/other`] : fixture.stateChange.stepUrls } }];
    const baseline = kind === "redacted" ? "owner-secret" : kind === "long-baseline" ? "x".repeat(501) : kind === "numeric-baseline" ? 42 : "before";
    let marker: unknown = baseline;
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      if (init.method === "POST") marker = JSON.parse(String(init.body)).marker;
      return response(marker);
    });
    try {
      const result = await executor(db, configured).execute({ name: "access_control_workflow", arguments: writeRequest });
      expect((result.output as any).state_access_proof).toBeUndefined();
    } finally { db.close(); }
  });
  it("cleanup needs a retained matching contract and never accepts a supplied baseline", async () => {
    const db = database();
    try {
      expect((await executor(db, [fixture]).execute(cleanup)).success).toBe(false);
      expect((await executor(db, [fixture]).execute({ ...cleanup, arguments: { ...cleanup.arguments, baseline_digest: "forged" } })).success).toBe(false);
      expect(fetchScoped).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("keeps failed cleanup distinct from unavailable observation and preserves the original proof", async () => {
    const db = database();
    let marker = "before";
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      if (init.method === "POST") marker = JSON.parse(String(init.body)).marker;
      return response(marker);
    });
    try {
      await executor(db, [fixture]).execute({ name: "access_control_workflow", arguments: writeRequest });
      vi.mocked(fetchScoped).mockResolvedValueOnce(response("still-changed"));
      expect(await executor(db, [fixture]).execute(cleanup)).toMatchObject({ success: true, output: { state_access_proof: { status: "confirmed", cleanup: "failed" } } });
      const count = db.getEvents("workflow").length;
      vi.mocked(fetchScoped).mockResolvedValueOnce(response(null, 403));
      expect((await executor(db, [fixture]).execute(cleanup)).success).toBe(false);
      expect(db.getEvents("workflow")).toHaveLength(count);
    } finally { db.close(); }
  });
  it("a state-restoration workflow updates cleanup, rather than creating a second compromise", async () => {
    const db = database();
    let marker = "before";
    vi.mocked(fetchScoped).mockImplementation(async (_url: unknown, init: RequestInit) => {
      if (init.method === "POST") marker = JSON.parse(String(init.body)).marker;
      return response(marker);
    });
    try {
      const first = await executor(db, [fixture]).execute({ name: "access_control_workflow", arguments: writeRequest });
      const restored = await executor(db, [fixture]).execute({ name: "access_control_workflow", arguments: { ...writeRequest, expected_state: "before", steps: [{ ...writeRequest.steps[0], body: JSON.stringify({ marker: "before" }) }] } });
      expect((restored.output as any).state_access_proof).toMatchObject({ proof_id: (first.output as any).state_access_proof.proof_id, generation: 1, cleanup: "completed" });
    } finally { db.close(); }
  });
});
