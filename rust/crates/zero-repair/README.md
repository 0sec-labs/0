# zero-repair

Single-file candidate materialization for the native source workflow. This crate
never invokes a model, executes a candidate, edits the original checkout, applies
a patch with Git, or asserts that a vulnerability was fixed.

The host supplies a `MaterializeRequest`: the complete frozen baseline
`SnapshotPin`, an existing relative target, a separate exact-path allowlist,
protected files/directory prefixes, an exact preimage SHA-256, and replacement
UTF-8 text. A model may propose replacement bytes; its output cannot grant its own
allowlist or change the protected paths. Names such as `test.js` have no implicit
special status: the host must freeze the actual oracle/test/config protections.

`materialize(&request)` verifies the complete baseline through the executor's
anchored no-follow snapshot traversal and copies it into a new private directory.
It checks the source preimage, replaces exactly that file, then pins and compares
the complete candidate manifest. It preserves replacement bytes exactly, including
newlines. Paths must be normal relative paths; duplicates, protected-target
overlap, new files, symlinks, traversal, changed/unindexed baseline files, binary
source text, NULs and size overflow fail. Limits are 4096 files / 64 MiB per complete
snapshot and 128 KiB for both target source and replacement. Policy lists are also
bounded to 4096 entries and paths to 4096 bytes.

The returned `Candidate` is a non-cloneable, non-deserializable owner of the private
staged directory. `snapshot()` and `receipt()` return shared references;
`replacement_bytes()` supplies exact bytes for an immutable artifact store. `cleanup(self)` explicitly removes the private directory and returns
`Error::Cleanup { path }` on failure so the owner can recover it. Drop
attempts best-effort cleanup only. Executors must stage this pin into their
own execution-owned copy before the candidate owner is dropped; do not mount this
short-lived materialization tree directly. No cleanup-confirmation claim is made
for a destructor I/O failure.

The serializable `CandidateReceipt` is inert identity data binding baseline,
target/preimage, replacement, candidate snapshot and canonical sorted host policy.
It deliberately excludes temporary root paths so fresh reconstruction yields the
same receipt. SHA-256 identity is not authority or behavioral verification. A
receipt deserialized from elsewhere does not materialize anything or authorize
execution. Retain the request/baseline and replacement artifacts separately for
fresh reconstruction; this crate has no durable artifact store.

A future engine workflow must independently execute the original host-owned
oracle against the candidate and a freshly reconstructed candidate, preserving the
baseline plan identity and its explicit candidate observations. Materialization
alone is neither reproduction nor a validated repair, even when the bytes are
unchanged or the replacement is empty. Synchronous traversal should run off async
runtime workers. No CLI or engine integration is provided here.
