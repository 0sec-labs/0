# Formal campaign driver

This configures two replay-model challenges through Zero's campaign API.
There is currently **no qualified checker backend registered**. The driver
returns unresolved results and exits with code 2 before model requests or
candidate execution:

```
node research/formal-campaign/driver.mjs
```

## Correction to earlier evidence

The former local checker accepted a candidate containing the intended statement
in a comment followed by a theorem of `True`. A controlled reproduction caused
both challenges to receive false `checked` receipts. The checker has been
removed; historical receipts under `artifacts/`, including `formal-cNJTCN/`,
must not be treated as independently verified proof evidence.

Earlier runs demonstrated compiler acceptance of generated source, not secure
theorem correspondence or independent kernel verification. Repeating the same
Lean compiler in another process does not create an independent checker.

## Required trust boundary

Use a trusted challenge and pinned dependencies with
[Comparator](https://github.com/leanprover/comparator) for semantic theorem
correspondence and axiom checks, plus a compatible independent external kernel
such as nanoda. Compile generated source only in an isolated worker with no
provider credentials, bounded resources, and restricted filesystem/network
access. Comparator is not itself a second kernel.

Even a correctly checked theorem certifies a formal model, not correspondence
with deployed software. Keep source revision, modeling assumptions, runtime
reproduction, and proof evidence as separate records.
