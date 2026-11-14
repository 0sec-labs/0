# RFC: Capability-Based Permission Model for Hackstore Extensions

**Status:** Draft for Review
**Author:** Amresh-01
**Related Issue:** #341

## 1. Context & Problem Statement

Currently, Hackstore extensions are loaded and executed as local child processes with the full privileges of the host user. The official documentation explicitly states: *"Loading executes the source under your account, not in a sandbox."*

For an AI security harness that markets itself on trust, reproducibility, and enterprise readiness, this represents a critical supply-chain risk. A malicious or compromised extension can silently:
- Read sensitive files from the user's filesystem (e.g., SSH keys, `.env` files, proprietary source code).
- Exfiltrate credentials or code to external endpoints.
- Execute destructive shell commands with the user's privileges.

To maintain the integrity of the platform and unlock broader enterprise adoption, we must transition from an implicit "trust by default" model to an explicit "capability-based" security model.

## 2. Proposed Solution: Capability-Based Permissions

We propose a capability-based permission model inspired by Deno and VS Code extensions. Extensions must explicitly declare their required capabilities in a manifest. The runtime will enforce these boundaries, denying any undeclared access.

### 2.1. Manifest Schema

Extensions must provide a manifest file (e.g., `plugin.manifest.json`) or extend their existing `package.json` with a `0` or `plugin` key:

```json
{
  "name": "my-custom-scanner",
  "version": "1.0.0",
  "capabilities": [
    "network:outbound",
    "fs:read:workspace",
    "process:spawn:safe-list"
  ]
}
