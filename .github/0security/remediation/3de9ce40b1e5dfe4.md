# Recommended fixes

Several dependencies need a change that could not be completed automatically. Each entry below names the version to move to and what is left to do.

Use these steps with your coding agent. This draft contains guidance only. The findings remain open until the change is verified.

Source revision: 45384f71627b3e076ae0b7af35318b1fd4c1baf2

## Affected dependencies

- crypto\-bigint 0\.5\.5 (crates\.io) in 0verse/native/windows\-token\-capture/Cargo\.lock. Advisory-listed fixed versions: 0\.7\.6. Automatic updates are not supported for this package manager or lockfile. Prepare and test the update with your coding agent.
- @hono/node\-server 1\.19\.17 (npm) in pnpm\-lock\.yaml. Advisory-listed fixed versions: 2\.1\.3. Dependency constraints prevent the fixed version from resolving. Update the constraints or parent dependency.

## Advisories

- [GHSA\-rmxm\-3fg6\-px4f](https://osv.dev/vulnerability/GHSA-rmxm-3fg6-px4f)
- [RUSTSEC\-2026\-0387](https://osv.dev/vulnerability/RUSTSEC-2026-0387)

## Steps for your coding agent

### Automatic updates are not supported for this package manager or lockfile. Prepare and test the update with your coding agent.

1. Use this ecosystem's package manager to inspect available fixed versions and dependency constraints.
2. Prepare an update or mitigation manually, including any required application changes.
3. Run the project's tests and recheck the advisory.

### Dependency constraints prevent the fixed version from resolving. Update the constraints or parent dependency.

1. Inspect the dependency tree and the constraints that prevent the fixed version from resolving.
2. Update the parent dependency or compatible version constraints, then regenerate the lockfile.
3. Run installation, application tests and the advisory recheck.

Keep the finding open until an update or mitigation has been reviewed and verified.
