import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./index.js";
import { TOOL_DISPATCH } from "./dispatch.js";
import {
  offensiveEngineToolDefinitions,
  offensiveEngineDispatch,
  OFFENSIVE_SCOPED_TOOL_NAMES,
  MEMSAFETY_TOOL_NAMES,
  NPM_DISCOVERY_TOOL_NAMES,
  KERNEL_WEAPONIZE_TOOL_NAMES,
  CVE_ADAPT_TOOL_NAMES,
} from "./offensive-engines.js";
import { getToolsForRole } from "../tools.js";

// Phase-2 offensive / active engines (dev-live-engine-recovery). This suite is
// the PROOF that the deny-by-default gating is correct — it is deliberately
// exhaustive about which tools appear for which (role, scope, flag) triple.

// GROUP 1 — offline; join the DEFAULT read-only role set, no extra gating.
const GROUP1_TOOLS = ["variant_hunt", "assumption_hunt", "generate_fix"] as const;
// GROUP 2 — engagement-scoped; offered only when a scope is active.
const GROUP2_TOOLS = ["verify_finding", "protocol_conformance", "spec_drift", "safety_eval"] as const;
// GROUP 3 — feature-flag + scope gated, deny-by-default. tool → env flag.
const GROUP3_FLAGGED: Array<{ tool: string; flag: string }> = [
  { tool: "memsafety_fuzz", flag: "ZERO_FEATURE_MEMSAFETY" },
  { tool: "npm_dynamic_discovery", flag: "ZERO_FEATURE_NPM_DISCOVERY" },
  { tool: "weaponize_kernel", flag: "ZERO_FEATURE_KERNEL_WEAPONIZE" },
  { tool: "cve_adapt", flag: "ZERO_FEATURE_CVE_ADAPT" },
];

const ALL_TOOLS = [...GROUP1_TOOLS, ...GROUP2_TOOLS, ...GROUP3_FLAGGED.map((g) => g.tool)];

const GROUP3_FLAGS = GROUP3_FLAGGED.map((g) => g.flag);

/** Snapshot + clear the GROUP-3 feature flags so each case controls them. */
function withGroup3Flags(set: Record<string, boolean>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const flag of GROUP3_FLAGS) {
    saved[flag] = process.env[flag];
    delete process.env[flag];
  }
  try {
    for (const [flag, on] of Object.entries(set)) if (on) process.env[flag] = "1";
    fn();
  } finally {
    for (const flag of GROUP3_FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag]!;
    }
  }
}

function attackNames(opts?: Parameters<typeof getToolsForRole>[1]): string[] {
  return getToolsForRole("attack", opts).map((t) => t.name);
}

describe("offensive-engine tools — registration (dev-live-engine-recovery)", () => {
  it("registers exactly the eleven engines in the domain module", () => {
    expect(Object.keys(offensiveEngineToolDefinitions).sort()).toEqual([...ALL_TOOLS].sort());
    expect(Object.keys(offensiveEngineDispatch).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it("each engine is in TOOL_DEFINITIONS, TOOL_REGISTRY_ORDER, and TOOL_DISPATCH", () => {
    const order = Object.keys(TOOL_DEFINITIONS); // == registry order (assembled from it)
    for (const name of ALL_TOOLS) {
      const def = TOOL_DEFINITIONS[name];
      expect(def, `${name} in TOOL_DEFINITIONS`).toBeDefined();
      expect(def.name).toBe(name);
      expect(def.description).toBeTruthy();
      expect(order, `${name} in registry order`).toContain(name);
      expect(TOOL_DISPATCH[name], `${name} has a dispatch route`).toBeTruthy();
    }
  });

  it("the gating name-sets carry the right tools", () => {
    expect([...OFFENSIVE_SCOPED_TOOL_NAMES].sort()).toEqual([...GROUP2_TOOLS].sort());
    expect([...MEMSAFETY_TOOL_NAMES]).toEqual(["memsafety_fuzz"]);
    expect([...NPM_DISCOVERY_TOOL_NAMES]).toEqual(["npm_dynamic_discovery"]);
    expect([...KERNEL_WEAPONIZE_TOOL_NAMES]).toEqual(["weaponize_kernel"]);
    expect([...CVE_ADAPT_TOOL_NAMES]).toEqual(["cve_adapt"]);
  });
});

describe("GROUP 1 — offline engines are in the DEFAULT read-only role", () => {
  it("are ABSENT from the scoped-source-audit set (attacker-controlled boundary)", () => {
    // They stay OUT of the ATTACKER-CONTROLLED scoped source boundary — the
    // trust surface must stay minimal inside a hostile scope.
    for (const role of ["audit", "review"]) {
      const scoped = getToolsForRole(role, { hasScope: true }).map((t) => t.name);
      for (const name of GROUP1_TOOLS) {
        expect(scoped, `${name} must be absent from scoped ${role}`).not.toContain(name);
      }
    }
  });

  it("appear in the no-scope audit/review 'everything' set (trusted role)", () => {
    for (const role of ["audit", "review"]) {
      const everything = getToolsForRole(role).map((t) => t.name);
      for (const name of GROUP1_TOOLS) {
        expect(everything, `${name} offered to ${role} (no scope)`).toContain(name);
      }
    }
  });

  it("are NOT gated behind a feature flag (present in the non-scoped role)", () => {
    withGroup3Flags({}, () => {
      const everything = getToolsForRole("audit").map((t) => t.name);
      for (const name of GROUP1_TOOLS) expect(everything).toContain(name);
    });
  });
});

describe("GROUP 2 — scope-gated engines (deny-by-default without scope)", () => {
  it("are ABSENT for a no-scope attack session", () => {
    const names = attackNames();
    for (const name of GROUP2_TOOLS) {
      expect(names, `${name} must be absent without scope`).not.toContain(name);
    }
  });

  it("are PRESENT for an in-scope attack session", () => {
    const names = attackNames({ hasScope: true });
    for (const name of GROUP2_TOOLS) {
      expect(names, `${name} must be present with scope`).toContain(name);
    }
  });

  it("are ABSENT from the no-scope audit/review 'everything' set", () => {
    for (const role of ["audit", "review"]) {
      const everything = getToolsForRole(role).map((t) => t.name);
      for (const name of GROUP2_TOOLS) {
        expect(everything, `${name} must be absent from no-scope ${role}`).not.toContain(name);
      }
    }
  });
});

describe("GROUP 3 — feature-flag + scope gated (deny-by-default)", () => {
  it("are ABSENT without their feature flag, even WITH a scope", () => {
    withGroup3Flags({}, () => {
      const names = attackNames({ hasScope: true });
      for (const { tool } of GROUP3_FLAGGED) {
        expect(names, `${tool} must be absent without its flag`).not.toContain(tool);
      }
    });
  });

  it("are ABSENT with their flag but WITHOUT a scope", () => {
    withGroup3Flags(Object.fromEntries(GROUP3_FLAGS.map((f) => [f, true])), () => {
      const names = attackNames(); // no scope
      for (const { tool } of GROUP3_FLAGGED) {
        expect(names, `${tool} must be absent without scope`).not.toContain(tool);
      }
    });
  });

  it("are PRESENT only with BOTH their flag AND a scope", () => {
    withGroup3Flags(Object.fromEntries(GROUP3_FLAGS.map((f) => [f, true])), () => {
      const names = attackNames({ hasScope: true });
      for (const { tool } of GROUP3_FLAGGED) {
        expect(names, `${tool} must be present with flag + scope`).toContain(tool);
      }
    });
  });

  it("each flag gates ONLY its own tool (no cross-leak)", () => {
    for (const target of GROUP3_FLAGGED) {
      withGroup3Flags({ [target.flag]: true }, () => {
        const names = attackNames({ hasScope: true });
        expect(names, `${target.tool} enabled by ${target.flag}`).toContain(target.tool);
        for (const other of GROUP3_FLAGGED) {
          if (other.tool === target.tool) continue;
          expect(names, `${other.tool} must stay gated when only ${target.flag} is set`).not.toContain(other.tool);
        }
      });
    }
  });

  it("are ABSENT from the no-scope audit/review 'everything' set even with flags on", () => {
    withGroup3Flags(Object.fromEntries(GROUP3_FLAGS.map((f) => [f, true])), () => {
      for (const role of ["audit", "review"]) {
        const everything = getToolsForRole(role).map((t) => t.name);
        for (const { tool } of GROUP3_FLAGGED) {
          expect(everything, `${tool} must be absent from no-scope ${role}`).not.toContain(tool);
        }
      }
    });
  });
});
