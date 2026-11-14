# Plugin permission hardening

Status: proposal, not implemented.

This note replaces the premise of external RFC PR #346 (credit: Amresh-01 for
raising the sandboxing concern). That draft assumed plugins have no capability
model. They do. This note covers only what is still missing.

## 1. What already ships

| Piece | Location | What it gives |
|---|---|---|
| Closed capability vocabulary, mandatory per tool, empty list rejected, `gateFlagsFor` | `packages/engine/src/plugins/manifest.ts`, `plugin-manifest.schema.json` | Fail-closed declaration. Seven capabilities: `compute`, `model-call`, `network`, `filesystem-read`, `filesystem-write`, `process-exec`, `findings-write`. |
| Invocation-time classification | `capability-classification.ts` | `checkInvocationCapabilities` routes plugin tools through the same scope, local-filesystem and co-pilot gates as built-ins. |
| Monotonic deny-only guards | `guards.ts` | Guards can only narrow what a call may do. |
| Operator enablement and per-workspace trust | `enablement.ts`, `harness-trust.ts` | Installing never enables; a trust grant is operator-owned and never inferred from workspace contents. |
| Loader hardening | `loader.ts` | No shell, fixed argv, explicit cwd, allowlisted env minus target auth; the child is treated as untrusted. |
| Registry client | `registry-client.ts` | HTTPS only, index treated as data, every entry re-validated, signature policy with an injected verifier. |
| GitHub plugin install | `packages/cli/src/web/github-plugin-install.ts` | Review step pins the commit SHA and reads only the two plugin files from the git object database; approval must echo the reviewed SHA and permission hash; no auto-update. |
| Custom MCP approval | `packages/cli/src/web/custom-mcp.ts` | Every create/edit/enable bound to a reviewed fingerprint of command, args, cwd, env key names, URL and header names; secrets write-only. |

Capabilities therefore gate tool authorization. They do not constrain the
syscalls of a loaded plugin process, which still runs as the operator.

## 2. Real gaps

1. No OS-level enforcement: a plugin process that is enabled and trusted can
   read any file, open any socket or spawn anything regardless of its declared
   capabilities. A declared `compute`-only tool is not technically prevented
   from exfiltrating.
2. The signature verifier is a stub (`createStubSignatureVerifier` refuses
   everything) and no signing key ships, so signature policy cannot be turned on.
3. Granularity: capabilities are declared per tool, but approval and trust are
   per package. The process-level envelope is the union of all tools, and the
   review UI only shows an aggregate hash.
4. Update and pinning policy is implicit: GitHub installs pin a SHA and do not
   auto-update, but registry installs, re-review on change and rollback are not
   specified, and custom MCP fingerprints cover config but not the code a stdio
   command resolves to.

Non-goals: new capability names, a second manifest format, or a parallel
authorization path. The seven-capability vocabulary and `manifest.json` stay
the single source of truth.

## 3. Proposal

### 3.1 OS-level enforcement

Derive a process envelope from the package's union of capabilities, using the
existing `gateFlagsFor`/classification as the single translation:

| Capability union | Envelope |
|---|---|
| no `network`, no `process-exec` | no outbound sockets; no child process creation |
| no `filesystem-read`/`filesystem-write` | only the plugin's own directory (read) and a private scratch dir (write) |
| `filesystem-read` only | read-only mounts of the workspace; no writes outside scratch |
| `process-exec` | treated as `network` as well (already true in `manifest.ts`) |

Backends, in order of preference per platform, behind one `PluginSandbox`
interface chosen by the loader at spawn:

1. The SmolVM sandbox direction in `docs/design/fast-sandbox-startup-20261002.md`
   where available (strongest isolation, network policy at the VM edge).
2. Platform process sandboxes: macOS `sandbox-exec` profile, Linux
   namespaces/seccomp via a small helper.
3. Node permission flags (`--permission --allow-fs-read=...`) as a defence in
   depth for filesystem and child-process limits only. They do not restrict
   network, so they never satisfy a "no network" envelope alone.

Enforcement mode is per workspace: `off` (today), `warn` (log would-be denials),
`enforce`. A plugin whose envelope cannot be established on the host in
`enforce` mode fails to start with an explicit error; it never silently runs
unconfined. Guards stay deny-only: the sandbox can narrow, never widen.

### 3.2 Real signature verification

Inject a real verifier at the registry-client boundary (the seam already
exists). Ship a pinned public key set with key ids and rotation, verify over
the canonical manifest plus entry digest, and keep the current
`unverified`/`refused-*` states. Policy default stays "unverified allowed with a
visible badge" until a key ships; flipping to required is a separate decision.

### 3.3 Per-tool granularity

Keep per-tool declarations. Add to the review step a per-tool breakdown next to
the package aggregate, and record per-tool approval so that adding a tool or a
capability to an existing tool invalidates approval only for that tool. The
process envelope stays the union; per-tool checks continue to run in
`checkInvocationCapabilities`.

### 3.4 Update and pinning policy

- Every install records source, resolved SHA (or registry version) and the
  entry digest; the loader refuses an entry whose digest differs from the
  approved one.
- Any change to the permission hash or entry digest returns the plugin to
  "installed, not enabled" and requires a fresh review. No auto-update.
- Registry installs get the same review/approve flow as GitHub installs.
- For custom MCP stdio servers, record the resolved command path and digest
  where it is a local file, and include it in the reviewed fingerprint.
- Rollback is re-installing a previously approved pin.

## 4. Migration

1. Ship the sandbox interface and `warn` mode; existing plugins keep working and
   operators see what `enforce` would deny.
2. Add per-tool approval records; existing package approvals are migrated by
   treating them as approving all currently declared tools.
3. Add digest recording at next enablement; plugins without a recorded digest
   are re-reviewed once.
4. Offer `enforce` per workspace, default off, then default on for newly
   installed plugins. Existing installs are not force-migrated.
5. Signature requirement is switched on only after a real key and verifier
   ship.

Compatibility: manifests and capability names do not change, so published
plugins need no edits.

## 5. Open questions

- Which backend is the Linux baseline when SmolVM is unavailable?
- Is a per-tool process split worth it for high-risk capability mixes?
- Key custody and rotation for the registry signing key.

## 6. Verification plan (when implemented)

Per backend, tests that a declared-`compute` plugin cannot open a socket, read
outside its directory or spawn a process; that an unavailable backend fails
closed in `enforce`; and that approval invalidates on digest or permission-hash
change.
