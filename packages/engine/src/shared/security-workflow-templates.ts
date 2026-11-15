import { parseSecurityWorkflowInput, type SecurityWorkflowInput, type SecurityWorkflowNode, type SecurityWorkflowOperation } from "./security-workflows.js";
import type { ScanGoal } from "./types.js";

export type SecurityWorkflowTargetType = "source-code" | "npm-package" | "pypi-package" | "cargo-package" | "oci-image" | "url" | "web-app";
export interface SecurityWorkflowTemplate { id: string; revision: number; name: string; description: string; compatibleTargetTypes: readonly SecurityWorkflowTargetType[]; executor: "assessment" | Exclude<SecurityWorkflowOperation, "audit">; profile: "default"; expectedOutputs: readonly string[]; inputRequirements: readonly { names: readonly string[]; required: boolean; description: string }[]; category: "repository" | "package" | "web" | "contracts" | "security"; definition: SecurityWorkflowInput; /** Present only for templates offered as starting points; the rest stay resolvable by id. */ starter?: SecurityWorkflowStarter }
export type SecurityWorkflowStarterIcon = "shield-search" | "microscope" | "package" | "key-round" | "file-code" | "cpu" | "globe" | "lock-keyhole";
/** What a starting point needs: the workspace (implicit) or a URL to test. */
export interface SecurityWorkflowStarter { group: "code" | "web"; scope: "workspace" | "url"; icon: SecurityWorkflowStarterIcon; aliases: readonly string[] }
function phase(id: string, label: string, goal: ScanGoal, instructions: string, depth: "quick" | "default" | "deep" = "default"): SecurityWorkflowNode {
  return { id, type: "audit", label, enabled: true, plan: { goal, depth, runCount: 1, executionMode: "sequential", timeCapMs: 600_000, costCapUsd: 5 }, execution: { instructions } };
}
function template(id: string, name: string, description: string, category: SecurityWorkflowTemplate["category"], phases: SecurityWorkflowNode[]): SecurityWorkflowTemplate {
  const nodes: SecurityWorkflowNode[] = [{ id: "start", type: "trigger", label: "Start manually", enabled: true }, ...phases, { id: "report", type: "report", label: "Collect results", enabled: true }];
  const compatibleTargetTypes: SecurityWorkflowTargetType[] = category === "web" || category === "security"
    ? ["url", "web-app"] : category === "package"
    ? ["source-code", "npm-package", "pypi-package", "cargo-package"] : ["source-code"];
  return { id, revision: 1, name, description, category, compatibleTargetTypes, executor: "assessment", profile: "default", expectedOutputs: ["findings", "artifacts"], inputRequirements: [], definition: parseSecurityWorkflowInput({ name, instructions: description, target: "", nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id })) }) };
}
function operationTemplate(id: string, name: string, description: string, operation: Exclude<SecurityWorkflowOperation, "audit">, compatibleTargetTypes: SecurityWorkflowTargetType[], inputRequirements: SecurityWorkflowTemplate["inputRequirements"], inputs?: Record<string, unknown>): SecurityWorkflowTemplate {
  const base = template(id, name, description, "repository", [{ id: "operation", type: operation, label: name, enabled: true, ...(inputs ? { inputs } : {}) }]);
  return { ...base, executor: operation, compatibleTargetTypes, inputRequirements, expectedOutputs: operation === "fix" ? ["candidate", "validation", "artifacts"] : operation === "verify" ? ["verification", "artifacts"] : ["findings", "artifacts"] };
}
const FINDING_INPUT_REQUIREMENT = { names: ["finding", "findingPath", "findingId"], required: true, description: "Supply an existing finding, a finding JSON path, or a retained finding ID. Connected earlier finding evidence can also provide the input." };
/** Ready-to-customize drafts; selecting one neither installs anything nor authorizes an assessment. */
const CATALOG: readonly SecurityWorkflowTemplate[] = [
  template("repository-review", "Review my code for vulnerabilities", "Find exploitable auth, injection and trust-boundary bugs, then verify each one.", "repository", [
    phase("dependencies", "Dependency exposure", "known-vulnerabilities", "Inspect dependency manifests and lockfiles. Prioritize reachable vulnerable dependencies and supply-chain trust boundaries; distinguish confirmed exposure from version-only matches.", "quick"),
    phase("boundaries", "Trust boundaries", "unknown-vulnerabilities", "Trace authentication, authorization, tenant isolation, and privileged entry points in the authorized repository. Follow input-to-sink paths and report only supported security findings.", "deep"),
    phase("configuration", "Configuration and secrets", "misconfigurations", "Review repository configuration, credential handling, unsafe defaults, and sensitive debug surfaces. Do not expose secret values in reports."),
  ]),
  template("dependency-review", "Dependency and supply-chain check", "Flag vulnerable and suspicious dependencies, and check if they are reachable.", "package", [
    phase("advisories", "Advisory triage", "known-vulnerabilities", "Review declared and locked dependencies against supported advisory sources. Check affected versions and whether vulnerable functionality is used.", "quick"),
    phase("lifecycle", "Lifecycle and trust", "unknown-vulnerabilities", "Inspect package installation hooks, dynamic downloads, credential access, and dependency trust changes. Support suspicious behavior with code evidence, without executing untrusted installation scripts.", "deep"),
  ]),
  template("api-security", "API authorization test", "Probe your API for broken access control and unsafe input handling.", "web", [
    phase("surface", "API surface and defaults", "misconfigurations", "Map documented and reachable authorized API endpoints, exposed documentation, error disclosures, and security defaults. Stay within the supplied scope and avoid destructive requests.", "quick"),
    phase("authorization", "Authorization boundaries", "unknown-vulnerabilities", "Assess object ownership, role boundaries, tenant isolation, and authentication requirements using only identities and targets explicitly authorized for the engagement. Do not invent credentials.", "deep"),
    phase("inputs", "Input handling", "unknown-vulnerabilities", "Review request parsing, injection boundaries, resource references, and validation. Use bounded non-destructive checks and retain evidence for confirmed impact."),
  ]),
  template("web-configuration", "Test my web app", "Check exposure, headers, sessions and known component issues.", "web", [
    phase("exposure", "Public exposure", "misconfigurations", "Review in-scope publicly reachable files, admin/debug surfaces, transport defaults, and error disclosures using non-destructive checks.", "quick"),
    phase("sessions", "Browser and session controls", "misconfigurations", "Review observed cookie attributes, cache handling of sensitive responses, cross-origin policy, redirect handling, and browser security headers. Explain practical impact rather than treating every absent header as a vulnerability."),
    phase("advisories", "Known component exposure", "known-vulnerabilities", "Assess observed components against supported known-vulnerability sources. Separate inferred versions from verified affected versions and avoid unsupported exploit claims."),
  ]),
  template("scoped-penetration-test", "Scoped penetration test", "Plan and assess only an explicitly authorized target, with bounded discovery and non-destructive validation.", "security", [
    phase("discovery", "Scoped discovery", "misconfigurations", "Map only the authorized attack surface and identify exposed configuration and trust boundaries. Honor exclusions and rate limits; do not enumerate unrelated hosts.", "quick"),
    phase("known", "Known vulnerability triage", "known-vulnerabilities", "Check supported known-vulnerability leads against observed target behavior. Verify applicability with bounded evidence; do not run broad third-party scanners or destructive exploit payloads."),
    phase("validation", "Targeted validation", "unknown-vulnerabilities", "Investigate authorization, input handling, and sensitive state transitions within explicit scope. Prefer minimal non-destructive proof; stop before destructive actions or accessing unrelated user data.", "deep"),
  ]),
  template("package-behavior", "Package behavior investigation", "Review an authorized package's security-relevant code paths and suspicious behavior.", "package", [
    phase("entrypoints", "Entrypoints and advisories", "known-vulnerabilities", "Inspect package metadata, entrypoints, and supported advisories; identify security-sensitive or remotely reachable behavior.", "quick"),
    phase("behavior", "Suspicious behavior", "unknown-vulnerabilities", "Trace filesystem and credential access, network destinations, obfuscated code, dynamic evaluation, and lifecycle hooks. Distinguish legitimate functionality from suspicious behavior with evidence; do not execute untrusted install scripts.", "deep"),
  ]),
  template("contract-review", "Smart contract review", "Check access control, upgrades and accounting bugs in contract source.", "contracts", [
    phase("access", "Authority and upgrade paths", "unknown-vulnerabilities", "Review contract source for privileged roles, initialization, upgrades, trust in external calls, and missing authorization. Identify the contract ecosystem from source; do not submit transactions or invent specialized verification results.", "deep"),
    phase("accounting", "Asset and state invariants", "unknown-vulnerabilities", "Trace value transfers, balance accounting, state transitions, rounding, and reentrancy boundaries in the authorized source. Support findings with concrete call sequences; do not move assets or publish exploits.", "deep"),
    phase("configuration", "Deployment assumptions", "misconfigurations", "Review source-visible deployment and initialization assumptions, privileged configuration, and dependency trust. Clearly distinguish code evidence from unverified deployed state."),
  ]),
  template("native-code-review", "Native code review", "Look for memory-safety, parser and privilege bugs in C, C++ and Rust.", "repository", [
    phase("parsers", "Parsers and memory boundaries", "unknown-vulnerabilities", "Trace untrusted input through parsing, length calculations, ownership, and memory operations. Prioritize reachable paths and concrete invalid-state evidence in the authorized source.", "deep"),
    phase("privileges", "Privilege and resource boundaries", "unknown-vulnerabilities", "Review privilege transitions, filesystem paths, subprocess inputs, concurrency, and resource lifetime. Avoid speculative issues without a supported attacker-controlled path.", "deep"),
  ]),
  template("secrets-config-review", "Secrets and config check", "Look for leaked credentials, unsafe defaults and debug surfaces.", "repository", [
    phase("secrets", "Credentials", "misconfigurations", "Search the repository and its history-visible files for committed credentials, tokens and keys. Never print secret values in reports.", "quick"),
    phase("defaults", "Defaults and debug surfaces", "misconfigurations", "Review configuration for unsafe defaults, permissive CORS or network binding, disabled security controls, and debug or admin surfaces left enabled."),
  ]),
  operationTemplate("finding-verification", "Finding verification", "Verify an existing finding using an explicitly selected execution runner and preserve the verification evidence.", "verify", ["source-code", "url", "web-app"], [FINDING_INPUT_REQUIREMENT, { names: ["runner"], required: true, description: "Select local, smolvm, docker, or qemu. Existing verification scope and prerequisite checks apply." }]),
  operationTemplate("fix-candidate", "Fix candidate and validation", "Propose and test a source fix candidate without applying it to the repository.", "fix", ["source-code"], [FINDING_INPUT_REQUIREMENT, { names: ["testCommand"], required: true, description: "Provide the explicit repository regression test command." }]),
  operationTemplate("security-research", "Security research", "Research an authorized source repository end to end and keep the findings and supporting files.", "research", ["source-code"], [], { engine: "pipeline" }),
  operationTemplate("deep-source-review", "Deep code review", "Slow, thorough pass over the whole repo, with evidence kept.", "deep-review", ["source-code"], []),
];
const STARTERS: Record<string, { starter: SecurityWorkflowStarter; prompt: string }> = {
  "repository-review": { starter: { group: "code", scope: "workspace", icon: "shield-search", aliases: ["whitebox pentest", "pentest", "source code", "security review"] }, prompt: "Review this repo for exploitable auth and injection bugs. Verify each finding with evidence. Report only confirmed issues." },
  "deep-source-review": { starter: { group: "code", scope: "workspace", icon: "microscope", aliases: ["security research", "deep source review", "thorough"] }, prompt: "Review the whole repo in depth. Keep the evidence for every finding and report only what you can support." },
  "dependency-review": { starter: { group: "code", scope: "workspace", icon: "package", aliases: ["supply chain", "advisories", "packages", "sca"] }, prompt: "Check dependencies for known vulnerabilities and suspicious behavior. Say whether each vulnerable dependency is reachable from our code." },
  "secrets-config-review": { starter: { group: "code", scope: "workspace", icon: "key-round", aliases: ["secrets", "credentials", "configuration", "defaults"] }, prompt: "Find leaked credentials, unsafe defaults and debug surfaces in this repo. Never print secret values." },
  "contract-review": { starter: { group: "code", scope: "workspace", icon: "file-code", aliases: ["solidity", "contracts", "blockchain"] }, prompt: "Review the contract source for missing authorization, unsafe upgrades and accounting bugs. Back each finding with a concrete call sequence." },
  "native-code-review": { starter: { group: "code", scope: "workspace", icon: "cpu", aliases: ["memory safety", "c++", "rust", "parser", "boundary"] }, prompt: "Review the native code for memory-safety, parser and privilege-boundary bugs. Report only issues with an attacker-controlled path." },
  "web-configuration": { starter: { group: "web", scope: "url", icon: "globe", aliases: ["web configuration", "headers", "sessions", "website"] }, prompt: "Check this site for public exposure, weak browser and session controls, and known component issues. Use safe, non-destructive checks only." },
  "api-security": { starter: { group: "web", scope: "url", icon: "lock-keyhole", aliases: ["api authorization", "access control", "idor"] }, prompt: "Probe this API for broken access control and unsafe input handling. Use safe, non-destructive requests and keep evidence for each finding." },
};
/** Templates offered as starting points, in display order. Everything else stays resolvable by id for existing automations. */
export const SECURITY_WORKFLOW_TEMPLATES: readonly SecurityWorkflowTemplate[] = CATALOG.map(entry => {
  const meta = STARTERS[entry.id];
  return meta ? { ...entry, starter: meta.starter, definition: { ...entry.definition, instructions: meta.prompt } } : entry;
});
/** The templates to show as starting points: code first, then web. */
export function securityWorkflowStarters(): SecurityWorkflowTemplate[] {
  return Object.keys(STARTERS).map(id => SECURITY_WORKFLOW_TEMPLATES.find(entry => entry.id === id)!);
}
/** Does an automation need a URL (or other scope) from the person, rather than the workspace? */
export function securityWorkflowScopeKind(templateId: string | undefined): "workspace" | "url" {
  const found = SECURITY_WORKFLOW_TEMPLATES.find(entry => entry.id === templateId);
  return found?.compatibleTargetTypes.includes("url") ? "url" : "workspace";
}
/** Resolve a pinned catalog revision before creating a run or draft. */
export function getSecurityWorkflowTemplate(id: string, revision?: number): SecurityWorkflowTemplate {
  const found = SECURITY_WORKFLOW_TEMPLATES.find(entry => entry.id === id);
  if (!found) throw new Error("Unknown security workflow template.");
  if (revision !== undefined && revision !== found.revision) throw new Error(`Template revision mismatch: ${id} is revision ${found.revision}.`);
  return structuredClone(found);
}
export function checkSecurityWorkflowTemplateTarget(template: SecurityWorkflowTemplate, targetType: string): void {
  if (!template.compatibleTargetTypes.includes(targetType as SecurityWorkflowTargetType)) {
    throw new Error(`Template ${template.id} does not support target type ${targetType}. Supported types: ${template.compatibleTargetTypes.join(", ")}.`);
  }
}
export function createSecurityWorkflowTemplate(id: string, options: { target?: string; targetType?: string; revision?: number } = {}): SecurityWorkflowInput {
  const found = getSecurityWorkflowTemplate(id, options.revision);
  if (options.targetType !== undefined) checkSecurityWorkflowTemplateTarget(found, options.targetType);
  return parseSecurityWorkflowInput({ ...found.definition, template: { id: found.id, revision: found.revision }, ...(options.target !== undefined ? { target: options.target } : {}) });
}
