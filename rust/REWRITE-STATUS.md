# Rust rewrite status

Updated 2026-09-19 for the native repair workflow checkpoint. This is a feature
inventory, not a percentage estimate. A bounded working workflow does not prove
full TypeScript parity, general security effectiveness, platform support or
production readiness. Production CLI routing remains TypeScript.

| User workflow | Current evidence and remaining scope |
| --- | --- |
| Scoped HTTP investigation | Native scan, adaptive requests, host scope, accounting, cancellation, retained reports and retries are implemented with executable fixtures. Browser sessions, multiple principals/reset and specialist verification remain incomplete. See `crates/zero-cli/tests/scan.rs`, `crates/zero-engine/tests/scan_authority.rs`. |
| Local source review | Dirty/untracked workspace selection, adaptive source tools, cited hypotheses, archive retention and source-independent history/report work. Diff/package profiles and complete legacy workflow parity remain open. See `SOURCE-WORKFLOW.md`, `crates/zero-cli/tests/review.rs`. |
| Git source acquisition | Explicit Git ref capture, pinned source/receipt, bounded process supervision and CLI review handoff work. Typed receipt binding to review admission, private repository authentication, package/OCI acquisition remain open. See `SOURCE-ACQUISITION.md`. |
| Reproduce a retained source claim | Native archive-backed reproduction has separate authorization, exact execution permits, independent assessment and offline inspection. Real backend qualification and specialist oracles remain open. See `crates/zero-cli/tests/support/review_reproduce.rs`. |
| Repair and export | Native repair admission, two freshly materialized candidate matrices, independent report and archive-backed unified patch export are implemented. No original checkout is changed. Applying/retesting in a user workspace and PR automation remain open. See `crates/zero-cli/tests/support/review_repair.rs`, `crates/zero-engine/src/native_repair_export/tests.rs`. |
| Interactive delegated investigation | Sessions, durable queues/steering/questions/approvals, delegation and native console/TUI primitives exist. Full shorthand, tool suite, persistent shell/workspace behavior and product UX parity remain incomplete. See `crates/zero-cli/src/args.rs`, `crates/zero-tui/README.md`. |
| Providers and credentials | Multiple provider adapters, bounded credentials and Entra refresh exist. Complete legacy provider/login/process-provider coverage and live qualification remain incomplete. See `crates/zero-provider/README.md`. |
| Sandbox and plugin execution | Pinned Docker/smolvm execution and language-neutral persistent worker transport exist. Engine worker integration is separately qualified on branch `rust-harness-parity-20260919` at `da71fceb`; it is not integrated by this repair checkpoint. Full plugin/MCP/tool breadth and real isolation qualification remain open. See `PLUGIN-WORKERS.md`. |
| Self-improvement | Budgeted strategy generation, independent holdouts/canaries, eligibility and guarded activation exist for bounded advisory strategy artifacts. General autonomous harness-code evolution remains incomplete. See `AUTONOMY.md`. |
| Managed cloud product | Native grant/result producer and cloud contract/persistence/admission/accounting helpers exist. Real configuration staging, launch, authenticated recoverable transport, polling and dashboard integration remain incomplete. See `NATIVE-WORKER-CONTRACT.md`; sibling cloud repo `docs/NATIVE-MANAGED-EXECUTION.md`. Cloud audit baseline was `38f598871`; no production promotion is claimed. |
| Specialist security workflows | Most native recon, npm, AD/cloud-target auditing, kernel/binary, CVE/research, protocol/spec drift and disclosure equivalents remain missing. General agent/sandbox primitives do not complete these workflows. Compare `crates/zero-cli/src/args.rs` with `../packages/cli/src/commands/index.ts`. |
| Distribution and cutover | Experimental native binary exists. Production aliases/options, installers/images, supported platforms, old-state migration, operational comparisons and rollback release remain open. See `MIGRATION.md`, `../packages/cli/src/routing.ts`. |

## Next integration priorities

1. Integrate and qualify the persistent Engine worker branch against current Store
   and CLI changes, then bind Git acquisition provenance into review admission.
2. Connect existing managed-cloud components into an executable product workflow.
3. Port remaining user-facing tools/providers and qualify state/distribution
   compatibility before production cutover.

Historical sections of `MIGRATION.md` and provider documentation describe earlier
checkpoints. Resolve them against current source and executable acceptance tests;
do not count old unchecked boxes, test totals or Rust line counts as completion.
The native repair checkpoint advances Store schema to 21. Its process fixtures
exercise lifecycle and evidence binding, not real Docker isolation or deployment.
