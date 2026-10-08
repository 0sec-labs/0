/** Browser projection of authenticated team state; identity comes from the server. */
export interface TeamMember {
  userId: string;
  displayName: string;
  role: string;
  joinedAt: number;
}
export interface TeamProposal {
  id: string;
  submittedBy: { userId: string; displayName: string };
  text: string;
  createdAt: number;
  status: "pending" | "dispatching" | "accepted" | "rejected" | "failed";
  error?: string;
}
export interface TeamSnapshot {
  conversationId: string;
  workspaceId: string;
  viewer: { userId: string; displayName: string; role: string };
  controller: { userId: string; displayName: string; expiresAt: number } | null;
  revision: number;
  canControl: boolean;
  members: TeamMember[];
  presence: Array<{ userId: string; displayName: string; viewing: boolean; typing: boolean; updatedAt: number }>;
  proposals: TeamProposal[];
}
/** Adapter is permanently bound to the authenticated owning backend. */
export interface TeamClient {
  snapshot(sessionId: string, signal?: AbortSignal): Promise<TeamSnapshot>;
  presence(sessionId: string, input: { typing: boolean; viewing: boolean }, signal?: AbortSignal): Promise<TeamSnapshot>;
  control(sessionId: string, input: { action: "claim" | "release"; expectedRevision: number }, signal?: AbortSignal): Promise<TeamSnapshot>;
  propose(sessionId: string, input: { text: string }, signal?: AbortSignal): Promise<TeamSnapshot>;
  decide(sessionId: string, proposalId: string, input: { action: "accept" | "reject"; expectedRevision: number }, signal?: AbortSignal): Promise<TeamSnapshot>;
}

const leases = new Map<string, { token: string; expiresAt: number }>();
function leaseKey(backendId: string, conversationId: string): string { return JSON.stringify([backendId, conversationId]); }
/** Memory-only lease used by existing authenticated console mutations. */
export function getTeamLeaseToken(backendId: string, conversationId: string): string | undefined {
  const key = leaseKey(backendId, conversationId);
  const lease = leases.get(key);
  if (lease && lease.expiresAt <= Date.now()) { leases.delete(key); return undefined; }
  return lease?.token;
}
export function clearTeamLeaseTokens(backendId: string): void {
  for (const key of leases.keys()) if ((JSON.parse(key) as string[])[0] === backendId) leases.delete(key);
}

/** Transport must be the owning backend's authenticated request facade. */
export function createTeamClient(backendId: string, transport: (path: string, init?: RequestInit) => Promise<Response>): TeamClient {
  const route = (id: string) => `/api/team/conversations/${encodeURIComponent(id)}`;
  async function request<T>(id: string, suffix: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    const headers = new Headers({ "Content-Type": "application/json" });
    const lease = getTeamLeaseToken(backendId, id);
    if (lease) headers.set("X-0-Team-Lease", lease);
    const response = await transport(`${route(id)}${suffix}`, { method: input === undefined ? "GET" : "POST", ...(input === undefined ? {} : { body: JSON.stringify(input) }), headers, signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 409 && suffix === "/control") leases.delete(leaseKey(backendId, id));
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Team request failed (${response.status}).`);
    }
    if (!response.headers.get("Content-Type")?.includes("json")) throw new Error("Team backend returned a non-JSON response.");
    return await response.json() as T;
  }
  const snapshot = async (id: string, signal?: AbortSignal) => {
    const next = await request<TeamSnapshot>(id, "", undefined, signal);
    if (next.conversationId !== id) throw new Error("Team response belongs to another conversation.");
    if (!next.canControl) leases.delete(leaseKey(backendId, id));
    return { ...next, canControl: next.canControl && Boolean(getTeamLeaseToken(backendId, id)) };
  };
  async function control(id: string, action: "claim" | "renew" | "release", signal?: AbortSignal): Promise<TeamSnapshot> {
    const response = await request<{ leaseToken?: string; expiresAt?: number }>(id, "/control", { action }, signal);
    signal?.throwIfAborted();
    if (action === "release") leases.delete(leaseKey(backendId, id));
    else if (typeof response.leaseToken === "string" && response.leaseToken && typeof response.expiresAt === "number" && Number.isFinite(response.expiresAt) && response.expiresAt > Date.now()) leases.set(leaseKey(backendId, id), { token: response.leaseToken, expiresAt: response.expiresAt });
    else { leases.delete(leaseKey(backendId, id)); throw new Error("Team backend did not return a controller lease."); }
    return snapshot(id, signal);
  }
  return {
    snapshot,
    async presence(id, input, signal) {
      if (getTeamLeaseToken(backendId, id)) await control(id, "renew", signal);
      await request(id, "/presence", input, signal);
      return snapshot(id, signal);
    },
    control: (id, input, signal) => control(id, input.action, signal),
    async propose(id, input, signal) { await request(id, "/proposals", input, signal); return snapshot(id, signal); },
    async decide(id, proposalId, input, signal) { await request(id, `/proposals/${encodeURIComponent(proposalId)}`, { action: input.action }, signal); return snapshot(id, signal); },
  };
}

export function teamInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toLocaleUpperCase() || "?";
}
