# Recommended fixes

Several dependencies need a change that could not be completed automatically. Each entry below names the version to move to and what is left to do.

Use these steps with your coding agent. This draft contains guidance only. The findings remain open until the change is verified.

Source revision: 45384f71627b3e076ae0b7af35318b1fd4c1baf2

## Affected dependencies

- crypto\-bigint 0\.5\.5 (crates\.io) in 0verse/native/windows\-token\-capture/Cargo\.lock. Advisory-listed fixed versions: 0\.7\.6. Automatic updates are not supported for this package manager or lockfile. Prepare and test the update with your coding agent.
- @hono/node\-server 1\.19\.17 (npm) in pnpm\-lock\.yaml. Advisory-listed fixed versions: 2\.1\.3. We could not verify the upgrade. Review the checks and setup before deciding whether application changes are needed.

## Advisories

- [GHSA\-rmxm\-3fg6\-px4f](https://osv.dev/vulnerability/GHSA-rmxm-3fg6-px4f)
- [RUSTSEC\-2026\-0387](https://osv.dev/vulnerability/RUSTSEC-2026-0387)

## Steps for your coding agent

### Automatic updates are not supported for this package manager or lockfile. Prepare and test the update with your coding agent.

1. Use this ecosystem's package manager to inspect available fixed versions and dependency constraints.
2. Prepare an update or mitigation manually, including any required application changes.
3. Run the project's tests and recheck the advisory.

### We could not verify the upgrade. Review the checks and setup before deciding whether application changes are needed.

1. Review the installation, build and test results, including any setup failures or incomplete checks.
2. Check the dependency's migration guide and affected call sites. Make setup or application changes only if the checks show they are needed.
3. Test the update and recheck the advisory before merging.

Keep the finding open until an update or mitigation has been reviewed and verified.
