# Apply and recover exported workspace changes

The explicit `workspace-apply` commands consume a workspace export without
opening the Engine database, contacting a provider or executing guest code.
Application does not certify a repair: exported tests remain unverified evidence.

```sh
0sec-native workspace-apply preview --bundle /private/export --root /work/project
0sec-native workspace-apply run --bundle /private/export --root /work/project \
  --journal /work/project/.0sec-application-unique
0sec-native workspace-apply status --journal /work/project/.0sec-application-unique
0sec-native workspace-apply rollback --journal /work/project/.0sec-application-unique
```

Preview verifies archive contents, executable modes, the complete change list,
allowed path preconditions and the existing files. Run rechecks these conditions
and retains the exact originals in a new private journal before installing files.
Unrelated checkout files are left alone. Original ownership, group, permissions,
supported user extended attributes and POSIX ACLs are preserved. Unsupported
security/filesystem attributes cause rejection rather than silent metadata loss.
Symlinks, hardlinks, repository control paths and substituted directories reject.

This is a journaled sequence of file changes, not an atomic replacement of the
whole directory. Originals are moved to retained journal entries; all install and
restore renames refuse to replace an unexpected existing file. An error or signal
may leave a partial application. Inspect the journal, then explicitly roll back.
Signal handling joins the current filesystem operation before the CLI exits.
Rollback requires exact file, parent, root and journal identities. Later edits,
permission changes or unexplained deletion of installed files stop recovery and
leave retained data available. Newly created directories remain; recovery never
removes directories that might contain user files. Do not delete the journal
until its retained originals and removed candidate files are no longer needed.

Existing run journals are inspected only, never resumed automatically. Completed
application and rollback phases are historical receipts; they do not claim that
the checkout still has those contents. A repeated completed rollback leaves
later user edits alone. Recovery needs the journal and original checkout root,
but does not need the exported bundle, provider configuration or Engine state.

The current implementation requires Linux and keeps the journal and changed
paths on the same filesystem. Paths must be absolute with no symlink components.
Directory locks serialize cooperating apply/recovery commands. They cannot stop
unrelated editors from writing; identity checks detect races and retained data
supports recovery. The host account and journal are trusted; this is not an
isolation boundary against a malicious process with the same filesystem access.
