# Explicit continuation boundaries

A new `RunAgent` request may name `continuation_of` for either a succeeded completed
answer or a failed operation whose agent status is `turn_limit` and whose outcome
advertises `continuation_artifact`. The caller supplies a new command ID and prompt.
This is explicit continuation, not automatic restart or replay of historical work.

For a turn limit, `agent.continuation` is a bounded versioned immutable artifact
written after the final complete tool round and before parent settlement. It
retains exact normalized post-tool input, including provider-native replay data
and exact tool-result strings. Its metadata binds session, parent, the complete
admitted parent payload, final inference identity, completion digest and turn
number. Parent payload identity includes provider/endpoint/wire/rates, instructions,
execution snapshot/profile, optional retained source authority, and plugin context.

Loading checks the attachment and outcome digest, artifact bytes, final model
journal and exact model-input/replay prefix. Every last-round call must have one
ordered output, unique call IDs, and a settled child or the exact shape of a tool
rejection. A checkpoint cannot precede a later inference attempt. Changed
provider, instructions, rates, source pin, plugin generation/launch or snapshot
is rejected by continuation admission. Prospective accumulated context is checked
against provider limits before the new command or budget reservation is admitted.

Cancelled, unknown, partial-round and generic failed operations are ineligible.
An old turn-limit operation without a checkpoint is also ineligible. Checkpoint
write failure becomes a failed operation, not advertised resumability. Known
nonzero guest exits remain exact nonzero tool observations; continuation does not
convert them into successful execution.

Accounting is independent: a completed provider response can leave a reservation
held when its usage cannot be priced. Continuation preserves that hold unchanged,
charges only new model work, and reserves against the remaining session budget.
It neither releases nor reprices historical holds. Operators can use the existing
explicit usage reconciliation command when evidence permits.

The old completed-answer continuation path remains supported. No database schema
migration is required; checkpoints use existing immutable operation artifacts.
The optional result field is absent for old outcomes and non-checkpointed cases.
This boundary does not implement durable message queues, interrupted-turn recovery,
context compaction or the legacy in-process engine replacement checkpoint ABI.
