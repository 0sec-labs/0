# Pinned offline plugin commands

This integration runs admitted native plugin tools through the fixed host sandbox
profile. It does not install/activate plugins, execute model-selected backends,
infer host grants, or implement bidirectional broker calls.

The host reconstructs a `zero_harness::Harness` using explicit engine identity
and `HostGrants`, then calls `Engine::configure_plugins(harness, Launch)` once
while idle. Launch limits are validated before configuration. A
`SessionCreatePinned { budget_limit }` request captures the selected generation
and activation epoch. Legacy sessions with only a generation string cannot run
plugins. `RunPlugin { session_id, command_id, plugin, tool, input }` supplies no
launch limits or backend overrides. The offline path does not consume inference
budget or invent a compute price; it enforces the fixed sandbox resource limits.

New work requires the session's exact current generation and epoch, including
when rollback selects a previously used digest. Exact admitted command retries
return their durable state/outcome, even after later activation or restart. A
changed command/profile conflicts and never triggers another process.

## Durable boundaries

1. Admit and begin the operation, then persist `plugin.preparing` with the
   operation-correlated lease owner and deterministic private attempt directory.
2. Acquire the harness lease with owner equal to operation ID. Validate and stage
   artifacts through `Runner::prepare_in`; no guest starts during preparation.
3. Persist `plugin.prepared` with lease/generation/plugin pin, execution ID,
   staging path, request digest and fixed host profile, then consume the prepared
   dispatch permit. A crash before this event cannot have launched a guest.
4. Await owned sandbox cleanup and persist `PluginOutcome` before releasing the
   separate evolution lease. Journal `plugin.lease_released` or
   `plugin.lease_release_failed` afterwards.

These are multiple durable transactions across two databases, not one atomic
commit. A lost reply never authorizes reexecution. Crash recovery correlates
leases by operation ID and source staging by the prior intent. Unknown cleanup
retains the lease and recovery path. Prepared-but-lost work is not automatically
resumed. The host must fence/quiesce owners and inspect backend recovery identity
before reconciling leases; engine restart does not silently release them.

`Reply::Plugin` contains the durable operation, optional `PluginOutcome`, and
retry flag. The outcome carries optional generation/lease pin, raw sandbox
result, explicitly untrusted result/error, error text and staging recovery path.
The immutable operation outcome does not claim the later lease release occurred;
that fact is independently journaled. A guest RPC error is not a successful tool
result. Event loss requests cancellation and waits for owned cleanup.

Validation covers restart retry without effects, durable preparation before
launcher start, stale rollback epochs, legacy-session rejection, unknown cleanup
with outstanding lease, cancellation with confirmed cleanup, rejected offline
capabilities and invalid launch configuration. Fixtures execute no real targets
or paid model calls.
