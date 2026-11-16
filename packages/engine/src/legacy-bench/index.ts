/**
 * legacy-bench: the pre-agentic staged scanner and the package-audit family.
 *
 * @deprecated Production runs go through `executeAssessment` (agenticScan for
 * web targets, runPipeline for source and packages). These two paths survive
 * only because the benchmark runners (bench/src/{runner,xbow-runner,
 * argus-runner,bench-integrations/xbow,npm-bench}.ts) and the bench adapters
 * still call them for their non-agentic arms and recorded baselines. They are
 * not equivalent to agenticScan (different stages, prompts and tool sets), so
 * removal is blocked on re-running the XBOW and npm baselines through the
 * single entry. See docs/design/lean-engine.md.
 */
export { scan } from "./scan.js";
export { packageAudit, runPerFileAudit, runSupplyChainScan } from "./package-audit.js";
