---
title: Dependencies
description: Check your project's dependencies against advisory databases and apply the package manager's fixes.
---

`0 deps` runs your ecosystem's own audit tool and prints vulnerable dependencies in one format.

```bash
cd my-app
0 deps scan
```

No model or API key is needed.

## Scan

```bash
0 deps scan
0 deps scan --cwd ./services/api --json
0 deps scan --ecosystem pnpm
```

0 detects the ecosystem from the files in the project directory, in this order:

| Files found | Ecosystem | Command 0 runs |
|---|---|---|
| `pnpm-lock.yaml` | `pnpm` | `pnpm audit --json` |
| `package-lock.json` or `npm-shrinkwrap.json` | `npm` | `npm audit --json` |
| `Cargo.lock` or `Cargo.toml` | `cargo` | `cargo audit --json` |
| `uv.lock`, `poetry.lock` or `requirements.txt` | `pypi` | `pip-audit --format=json` |

`--ecosystem` overrides detection. The tool must be installed and on your `PATH`: `cargo audit` comes from `cargo install cargo-audit`, `pip-audit` from `pip install pip-audit`.

### Output

```text
npm: 2 vulnerable dependencies
- lodash [high]: Prototype Pollution in lodash (fix: 4.17.21)
- minimist [critical]: Prototype Pollution in minimist (fix: available)
```

`--json` prints the ecosystem, the command, its exit code, the parsed findings (`package`, `severity`, `advisory`, `fix`) and the tool's raw JSON.

| Exit | Meaning |
|---|---|
| `0` | No vulnerable dependencies reported |
| `1` | At least one vulnerable dependency |
| `2` | The audit tool exited with an error and 0 parsed no findings |

## Fix

Commit or stash your work first. With `--yes`, `deps fix` changes your lockfile and manifests.

```bash
0 deps fix
0 deps fix --yes
0 deps fix --yes --cwd ./services/api
```

Without `--yes`, 0 prints the command it would run and changes nothing.

| Ecosystem | Command 0 runs |
|---|---|
| `pnpm` | `pnpm audit --fix` |
| `npm` | `npm audit fix` |
| `cargo` | `cargo update` |
| `pypi` | `pip-audit --fix` |

With `--yes`, 0 prints the tool's output and exits with its exit code. Run `0 deps scan` again and your tests afterwards.

## Scan a package you depend on

`deps` reports known advisories. To review the code of one package, including issues with no advisory yet, run a package scan:

```bash
0 scan package lodash --package-version 4.17.20
```

See [Scan code](/scan-code/#package-scan).

## Limits

- Results are only as complete as the audit tool and its advisory database. A vulnerable version with no published advisory is not reported.
- An advisory match does not mean the vulnerable code is reachable in your project.
- `cargo update` updates within your semver ranges; it can change more than the vulnerable crates and cannot fix an advisory that needs a major version bump.
- For Python, 0 runs `pip-audit` with no arguments, which audits the active Python environment, not the lockfile. Activate the project's environment first. `pip-audit --fix` upgrades packages in that environment.
- Only the four ecosystems above are supported. Other manifests fail with "No supported dependency manifest found".

## Next

- [Scan code](/scan-code/) to review the code itself.
- [CLI reference](/commands/) for every command.
