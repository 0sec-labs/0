import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advisorySweep, buildIntelDossier, inferTargetHistoryInputFromRepo, lookupAdvisory, searchAdvisories, lookupCve, searchSimilar, searchTargetHistory } from "./index.js";
import { ToolExecutor } from "../agent/tools.js";
import type { ToolContext } from "../agent/types.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const OSV_RESPONSE = {
  vulns: [
    {
      id: "GHSA-aaaa-bbbb-cccc",
      aliases: ["CVE-2024-0001"],
      summary: "Zip entries can escape the extraction directory",
      database_specific: { severity: "HIGH" },
      references: [{ type: "ADVISORY", url: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc" }],
      affected: [
        {
          package: { ecosystem: "npm", name: "zipper" },
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "1.2.3" }],
            },
          ],
        },
      ],
    },
  ],
};

const GHSA_RESPONSE = [
  {
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    cve_id: "CVE-2024-0001",
    summary: "Zip slip in zipper",
    severity: "high",
    html_url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "zipper" },
        vulnerable_version_range: "< 1.2.3",
        first_patched_version: { identifier: "1.2.3" },
      },
    ],
    cwes: [{ cwe_id: "CWE-22" }],
  },
];

const NVD_RESPONSE = {
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2024-0001",
        published: "2024-01-01T00:00:00.000",
        lastModified: "2024-01-02T00:00:00.000",
        descriptions: [{ lang: "en", value: "Path traversal in archive extraction" }],
        metrics: {
          cvssMetricV31: [
            {
              cvssData: {
                baseScore: 8.1,
                baseSeverity: "HIGH",
                vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
                version: "3.1",
              },
            },
          ],
        },
        weaknesses: [{ description: [{ lang: "en", value: "CWE-22" }] }],
        references: [{ url: "https://example.com/patch", tags: ["Patch"] }],
      },
    },
  ],
};

const KEV_RESPONSE = {
  vulnerabilities: [
    {
      cveID: "CVE-2024-0001",
      vulnerabilityName: "Example path traversal vulnerability",
      dateAdded: "2024-02-01",
      requiredAction: "Apply mitigations per vendor instructions.",
      dueDate: "2024-02-22",
      knownRansomwareCampaignUse: "Known",
    },
  ],
};

describe("vulnerability intel", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "0-intel-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("merges OSV, GitHub, NVD, and CISA KEV into sourced advisory intel", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json(OSV_RESPONSE);
      if (url.startsWith("https://api.github.com/advisories")) return json(GHSA_RESPONSE);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(NVD_RESPONSE);
      if (url.startsWith("https://www.cisa.gov/")) return json(KEV_RESPONSE);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchAdvisories(
      { ecosystem: "npm", packageName: "zipper", version: "1.0.0", cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]!.id).toBe("CVE-2024-0001");
    expect(result.advisories[0]!.sources).toEqual(expect.arrayContaining(["osv", "github", "nvd", "cisa-kev"]));
    expect(result.advisories[0]!.fixedVersions).toContain("1.2.3");
    expect(result.advisories[0]!.cwes).toContain("CWE-22");
    expect(result.advisories[0]!.kev?.knownExploited).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "kev")).toBe(true);
  });

  it("looks up CVEs with KEV enrichment", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(NVD_RESPONSE);
      if (url.startsWith("https://www.cisa.gov/")) return json(KEV_RESPONSE);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await lookupCve({ cveId: "cve-2024-0001", cacheDir }, { fetchImpl: fetchMock });
    expect(result?.id).toBe("CVE-2024-0001");
    expect(result?.cvss?.score).toBe(8.1);
    expect(result?.kev?.dateAdded).toBe("2024-02-01");
  });

  it("searches similar advisories through NVD keyword search", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("keywordSearch")).toContain("CWE-22");
      expect(url.searchParams.get("keywordSearch")).toContain("archive extraction");
      expect(url.searchParams.get("resultsPerPage")).toBe("10");
      return json(NVD_RESPONSE);
    }) as unknown as typeof fetch;
    const result = await searchSimilar(
      { cwe: "CWE-22", keywords: ["archive extraction"], cacheDir },
      { fetchImpl: fetchMock },
    );
    expect(result.advisories[0]?.summary).toContain("Path traversal");
  });

  it("falls back to NVD keyword search for Go standard-library advisory lookups", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json({ vulns: [] });
      if (url.startsWith("https://api.github.com/advisories")) return json([]);
      if (url.startsWith("https://services.nvd.nist.gov/")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("keywordSearch")).toContain("golang");
        expect(parsed.searchParams.get("keywordSearch")).toContain("standard library");
        expect(parsed.searchParams.get("resultsPerPage")).toBe("20");
        return json({
          vulnerabilities: [{
            cve: {
              ...NVD_RESPONSE.vulnerabilities[0]!.cve,
              descriptions: [{ lang: "en", value: "Vulnerability in the Go standard library net/http package" }],
              references: [{ url: "https://groups.google.com/g/golang-announce/c/example", tags: ["Vendor Advisory"] }],
            },
          }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchAdvisories(
      { ecosystem: "Go", packageName: "stdlib", version: "1.28.0", enrich: false, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(result.advisories[0]?.id).toBe("CVE-2024-0001");
    expect(result.advisories[0]?.sources).toContain("nvd");
  });

  it("warns and returns partial advisory data when one package source fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json(OSV_RESPONSE);
      if (url.startsWith("https://api.github.com/advisories")) throw new Error("github unavailable");
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchAdvisories(
      { ecosystem: "npm", packageName: "zipper", version: "1.0.0", enrich: false, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]!.sources).toEqual(["osv"]);
    expect(warn).toHaveBeenCalledWith(
      "[intel] queryGitHubAdvisories failed",
      expect.objectContaining({ reason: "github unavailable" }),
    );
  });

  it("warns and keeps NVD data when KEV lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(NVD_RESPONSE);
      if (url.startsWith("https://www.cisa.gov/")) throw new Error("kev unavailable");
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await lookupCve({ cveId: "CVE-2024-0001", cacheDir }, { fetchImpl: fetchMock });

    expect(result?.id).toBe("CVE-2024-0001");
    expect(result?.sources).toEqual(["nvd"]);
    expect(warn).toHaveBeenCalledWith(
      "[intel] lookupKev failed",
      expect.objectContaining({ reason: "kev unavailable" }),
    );
  });

  it("builds a package intel dossier with risk summary and variant leads", async () => {
    const similarResponse = {
      vulnerabilities: [
        {
          cve: {
            id: "CVE-2024-9999",
            descriptions: [{ lang: "en", value: "Another path traversal in archive extraction" }],
            metrics: {
              cvssMetricV31: [
                { cvssData: { baseScore: 7.5, baseSeverity: "HIGH", version: "3.1" } },
              ],
            },
            weaknesses: [{ description: [{ lang: "en", value: "CWE-22" }] }],
            references: [{ url: "https://example.com/variant", tags: ["Exploit"] }],
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json(OSV_RESPONSE);
      if (url.startsWith("https://api.github.com/advisories")) return json(GHSA_RESPONSE);
      if (url.includes("cveId=CVE-2024-0001")) return json(NVD_RESPONSE);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(similarResponse);
      if (url.startsWith("https://www.cisa.gov/")) return json(KEV_RESPONSE);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const dossier = await buildIntelDossier(
      { ecosystem: "npm", packageName: "zipper", version: "1.0.0", keywords: ["archive extraction"], cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(dossier.summary.advisoryCount).toBe(1);
    expect(dossier.summary.kevCount).toBe(1);
    expect(dossier.summary.riskLevel).toBe("critical");
    expect(dossier.summary.recommendedFocus).toEqual(expect.arrayContaining(["known exploited CVEs", "CWE-22"]));
    expect(dossier.variantLeads[0]?.id).toBe("CVE-2024-9999");
    expect(dossier.playbooks[0]?.bugClass).toBe("Path traversal / archive extraction escape");
    expect(dossier.playbooks[0]?.priorVulnerabilityIds).toEqual(expect.arrayContaining(["CVE-2024-0001", "CVE-2024-9999"]));
    expect(dossier.playbooks[0]?.steps.map((step) => step.id)).toEqual(expect.arrayContaining(["map-entrypoints", "trace-sinks", "exercise-path-bypasses", "prove-or-retire"]));
    expect(dossier.auditGraph.entrypointNodeIds).toHaveLength(1);
    expect(dossier.auditGraph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining([
      "prior_vulnerability",
      "bug_class",
      "investigation_step",
      "evidence_query",
    ]));
    expect(dossier.auditGraph.edges.map((edge) => edge.kind)).toEqual(expect.arrayContaining([
      "INFORMS",
      "HAS_STEP",
      "NEXT_STEP",
      "SEEKS_EVIDENCE",
    ]));
    expect(dossier.graph.nodes.length).toBeGreaterThan(0);
  });

  it("searches historical CVEs for the exact target/project", async () => {
    const targetHistoryResponse = {
      vulnerabilities: [
        {
          cve: {
            ...NVD_RESPONSE.vulnerabilities[0]!.cve,
            descriptions: [{ lang: "en", value: "Path traversal in zipper archive extraction" }],
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "services.nvd.nist.gov") {
        expect(url.searchParams.get("keywordSearch")).toMatch(/zipper|org\/zipper/i);
        return json(targetHistoryResponse);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const history = await searchTargetHistory(
      { repository: "https://github.com/org/zipper", product: "zipper", limit: 5, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(history.target.repository).toBe("org/zipper");
    expect(history.summary.advisoryCount).toBe(1);
    expect(history.advisories[0]?.id).toBe("CVE-2024-0001");
    expect(history.playbooks[0]?.priorVulnerabilityIds).toContain("CVE-2024-0001");
    expect(history.playbooks[0]?.steps.map((step) => step.id)).toContain("trace-sinks");
    expect(history.auditGraph.nodes.some((node) => node.kind === "evidence_query")).toBe(true);
    expect(history.auditGraph.edges.some((edge) => edge.kind === "NEXT_STEP")).toBe(true);
  });

  it("infers target-history hints from local repo metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "@org/zipper",
        repository: { type: "git", url: "git+https://github.com/org/zipper.git" },
      }));
      writeFileSync(join(repo, ".git", "config"), [
        "[remote \"origin\"]",
        "\turl = https://github.com/fallback/ignored.git",
        "",
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual(expect.arrayContaining(["package.json", ".git/config"]));
      expect(inferred.input.ecosystem).toBe("npm");
      expect(inferred.input.packageName).toBe("@org/zipper");
      expect(inferred.input.product).toBe("zipper");
      expect(inferred.input.repository).toBe("org/zipper");
      expect(inferred.input.vendor).toBe("org");
      expect(inferred.input.keywords).toEqual(expect.arrayContaining(["@org/zipper"]));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("infers target-history hints from pyproject.toml", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      writeFileSync(join(repo, "pyproject.toml"), [
        "[project]",
        'name = "my-flask-app"',
        "",
        "[project.urls]",
        'repository = "https://github.com/acme/my-flask-app"',
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual(["pyproject.toml"]);
      expect(inferred.input.ecosystem).toBe("pypi");
      expect(inferred.input.packageName).toBe("my-flask-app");
      expect(inferred.input.product).toBe("my-flask-app");
      expect(inferred.input.repository).toBe("acme/my-flask-app");
      expect(inferred.input.vendor).toBe("acme");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("infers target-history hints from Cargo.toml", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      writeFileSync(join(repo, "Cargo.toml"), [
        "[package]",
        'name = "serde_json"',
        'repository = "https://github.com/serde-rs/json"',
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual(["Cargo.toml"]);
      expect(inferred.input.ecosystem).toBe("cargo");
      expect(inferred.input.packageName).toBe("serde_json");
      expect(inferred.input.product).toBe("serde_json");
      expect(inferred.input.repository).toBe("serde-rs/json");
      expect(inferred.input.vendor).toBe("serde-rs");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("infers target-history hints from go.mod", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      writeFileSync(join(repo, "go.mod"), [
        "module github.com/gin-gonic/gin",
        "",
        "go 1.21",
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual(["go.mod"]);
      expect(inferred.input.ecosystem).toBe("Go");
      expect(inferred.input.packageName).toBe("github.com/gin-gonic/gin");
      expect(inferred.input.product).toBe("gin");
      expect(inferred.input.repository).toBe("gin-gonic/gin");
      expect(inferred.input.vendor).toBe("gin-gonic");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("infers target-history hints from .git/config alone", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "config"), [
        "[remote \"origin\"]",
        "\turl = git@github.com:django/django.git",
        "",
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual([".git/config"]);
      expect(inferred.input.repository).toBe("django/django");
      expect(inferred.input.vendor).toBe("django");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prefers package.json ecosystem over pyproject.toml when both exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "my-tool",
        repository: "https://github.com/acme/my-tool",
      }));
      writeFileSync(join(repo, "pyproject.toml"), [
        "[project]",
        'name = "my-tool-py"',
      ].join("\n"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      expect(inferred.sources).toEqual(expect.arrayContaining(["package.json", "pyproject.toml"]));
      expect(inferred.input.ecosystem).toBe("npm");
      expect(inferred.input.packageName).toBe("my-tool");
      expect(inferred.input.repository).toBe("acme/my-tool");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects leaf symlink that resolves outside repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "0-intel-outside-"));
    try {
      // Create a legitimate-looking external metadata file
      writeFileSync(join(outsideDir, "package.json"), JSON.stringify({
        name: "exfiltrated-package",
        repository: "https://github.com/evil/exfiltrated",
      }));

      // Repo root has no own package.json; the symlink should NOT be followed
      mkdirSync(join(repo, ".git"), { recursive: true });
      symlinkSync(join(outsideDir, "package.json"), join(repo, "package.json"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      // package.json present as a symlink but outside — must be ignored
      expect(inferred.sources).not.toContain("package.json");
      expect(inferred.input.ecosystem).toBeUndefined();
      expect(inferred.input.packageName).toBeUndefined();
      expect(inferred.input.repository).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects intermediate directory symlink that escapes repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "0-intel-outside-"));
    try {
      // External metadata file
      writeFileSync(join(outsideDir, "Cargo.toml"), [
        "[package]",
        'name = "escaped-crate"',
        'repository = "https://github.com/evil/escaped"',
      ].join("\n"));

      // .git is a symlink to outsideDir — .git/config should resolve outside
      symlinkSync(outsideDir, join(repo, ".git"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      // .git/config via symlinked .git directory — must be ignored
      expect(inferred.sources).not.toContain(".git/config");
      expect(inferred.input.repository).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("preserves normal in-root inference alongside symlink rejections", () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "0-intel-outside-"));
    try {
      // A legitimate in-root package.json
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "legitimate-pkg",
        repository: "https://github.com/legit/pkg",
      }));
      writeFileSync(join(repo, ".git", "config"), [
        "[remote \"origin\"]",
        "\turl = git@github.com:legit/pkg.git",
        "",
      ].join("\n"));

      // An unrelated external file + a symlink to it outside — should be ignored
      writeFileSync(join(outsideDir, "malicious.json"), JSON.stringify({
        name: "malicious",
        repository: "https://github.com/evil/malicious",
      }));
      writeFileSync(join(outsideDir, "pyproject.toml"), [
        "[project]",
        'name = "poisoned"',
        'repository = "https://github.com/evil/poisoned"',
      ].join("\n"));
      symlinkSync(join(outsideDir, "pyproject.toml"), join(repo, "pyproject.toml"));

      const inferred = inferTargetHistoryInputFromRepo(repo);

      // Legitimate in-root metadata still detected
      expect(inferred.sources).toContain("package.json");
      expect(inferred.input.ecosystem).toBe("npm");
      expect(inferred.input.packageName).toBe("legitimate-pkg");
      expect(inferred.input.repository).toBe("legit/pkg");

      // pyproject.toml is a symlink to outside — must NOT be in sources
      expect(inferred.sources).not.toContain("pyproject.toml");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("uses inferred repo metadata for target-history searches while preserving overrides", async () => {
    const repo = mkdtempSync(join(tmpdir(), "0-intel-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "@org/zipper",
        repository: "https://github.com/org/zipper",
      }));
      const targetHistoryResponse = {
        vulnerabilities: [
          {
            cve: {
              ...NVD_RESPONSE.vulnerabilities[0]!.cve,
              descriptions: [{ lang: "en", value: "Path traversal in zipper archive extraction" }],
            },
          },
        ],
      };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://api.osv.dev/")) return json({ vulns: [] });
        if (url.startsWith("https://api.github.com/advisories")) return json([]);
        if (url.startsWith("https://services.nvd.nist.gov/")) return json(targetHistoryResponse);
        throw new Error(`unexpected URL ${url}`);
      }) as unknown as typeof fetch;

      const history = await searchTargetHistory(
        { repoPath: repo, product: "zipper-enterprise", keywords: ["zipper"], cacheDir },
        { fetchImpl: fetchMock },
      );

      expect(history.target.repository).toBe("org/zipper");
      expect(history.target.packageName).toBe("@org/zipper");
      expect(history.target.product).toBe("zipper-enterprise");
      expect(history.summary.advisoryCount).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns an empty low-noise dossier when no advisories match", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json({ vulns: [] });
      if (url.startsWith("https://api.github.com/advisories")) return json([]);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const dossier = await buildIntelDossier(
      { ecosystem: "npm", packageName: "quiet-package", includeSimilar: false, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(dossier.summary.riskScore).toBe(0);
    expect(dossier.summary.riskLevel).toBe("none");
    expect(dossier.advisories).toHaveLength(0);
    expect(dossier.variantLeads).toHaveLength(0);
    expect(dossier.playbooks).toHaveLength(0);
    expect(dossier.auditGraph).toEqual({ entrypointNodeIds: [], nodes: [], edges: [] });
  });

  const GHSA_ADVISORY = {
    ghsa_id: "GHSA-xxxx-yyyy-zzzz",
    cve_id: null,
    summary: "Prototype pollution in widget",
    severity: "critical",
    html_url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "widget" },
        vulnerable_version_range: "< 2.0.0",
        first_patched_version: { identifier: "2.0.0" },
      },
    ],
    cwes: [{ cwe_id: "CWE-1321" }],
  };

  it("looks up a specific GHSA id directly via GET /advisories/{id}", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toBe("https://api.github.com/advisories/GHSA-XXXX-YYYY-ZZZZ");
      return json(GHSA_ADVISORY);
    }) as unknown as typeof fetch;

    const advisory = await lookupAdvisory({ ghsaId: "ghsa-xxxx-yyyy-zzzz", cacheDir }, { fetchImpl: fetchMock });
    expect(advisory?.id).toBe("GHSA-XXXX-YYYY-ZZZZ");
    expect(advisory?.severity).toBe("critical");
    expect(advisory?.cwes).toContain("CWE-1321");
  });

  it("returns null for an unknown GHSA id (404)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const advisory = await lookupAdvisory({ ghsaId: "GHSA-0000-0000-0000", cacheDir }, { fetchImpl: fetchMock });
    expect(advisory).toBeNull();
  });

  it("drops spurious substring matches but keeps whole-word target matches", async () => {
    const noisyResponse = {
      vulnerabilities: [
        {
          cve: {
            ...NVD_RESPONSE.vulnerabilities[0]!.cve,
            id: "CVE-2024-3001",
            descriptions: [{ lang: "en", value: "Auth bypass in KrakenD API gateway" }],
          },
        },
        {
          cve: {
            ...NVD_RESPONSE.vulnerabilities[0]!.cve,
            id: "CVE-2024-3002",
            descriptions: [{ lang: "en", value: "Kraken registry mishandles blob replication" }],
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(noisyResponse);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const history = await searchTargetHistory(
      { product: "kraken", limit: 5, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(history.summary.advisoryCount).toBe(1);
    expect(history.advisories[0]?.id).toBe("CVE-2024-3002");
    expect(history.advisories[0]?.matchConfidence).toBe("medium");
    expect(history.summary.confidenceCounts).toEqual({ high: 0, medium: 1, low: 0 });
  });

  it("scores exact repository reference matches as high confidence", async () => {
    const repoResponse = {
      vulnerabilities: [
        {
          cve: {
            ...NVD_RESPONSE.vulnerabilities[0]!.cve,
            id: "CVE-2024-4001",
            descriptions: [{ lang: "en", value: "Unrelated summary text" }],
            references: [{ url: "https://github.com/org/zipper/issues/9", tags: [] }],
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(repoResponse);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const history = await searchTargetHistory(
      { repository: "https://github.com/org/zipper", limit: 5, cacheDir },
      { fetchImpl: fetchMock },
    );
    expect(history.advisories[0]?.matchConfidence).toBe("high");
    expect(history.summary.confidenceCounts.high).toBe(1);
  });

  it("advisory_sweep fans out and returns a de-duped, confidence-ranked lead list", async () => {
    const issuesResponse = {
      total_count: 2,
      items: [
        { title: "Possible SSRF via blob fetch", html_url: "https://github.com/org/widget/issues/7", state: "open", number: 7, body: "report" },
        { title: "Fix pollution", html_url: "https://github.com/org/widget/pull/8", state: "closed", number: 8, pull_request: {}, body: "patch" },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/search/issues")) return json(issuesResponse);
      if (url.startsWith("https://api.github.com/advisories/GHSA")) return json(GHSA_ADVISORY);
      if (url.startsWith("https://api.github.com/advisories")) return json(GHSA_RESPONSE);
      if (url.startsWith("https://api.osv.dev/")) return json({ vulns: [] });
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await advisorySweep(
      {
        repository: "org/widget",
        ecosystem: "npm",
        packageName: "widget",
        keywords: ["prototype pollution"],
        ghsaIds: ["GHSA-xxxx-yyyy-zzzz"],
        cacheDir,
      },
      { fetchImpl: fetchMock },
    );

    // 2 advisories (direct GHSA + package CVE-2024-0001) + 2 public reports.
    expect(result.counts.advisories).toBe(2);
    expect(result.counts.publicReports).toBe(2);
    expect(result.counts.high).toBe(2);
    expect(result.leads[0]?.confidence).toBe("high");
    expect(result.leads.some((lead) => lead.id === "GHSA-XXXX-YYYY-ZZZZ")).toBe(true);
    expect(result.leads.some((lead) => lead.kind === "public_report" && lead.url?.endsWith("/pull/8"))).toBe(true);
    expect(result.provenance.unverified).toBe(true);
    expect(result.caveat).toMatch(/not 'definitely unique'/i);
  });

  it("exposes a specific GHSA lookup through the intel tool", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/advisories/GHSA")) return json(GHSA_ADVISORY);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const ctx: ToolContext = {
      target: "widget",
      scanId: "scan-1",
      findings: [],
      attackResults: [],
      targetInfo: {},
      role: "audit",
    };
    const executor = new ToolExecutor(ctx, null);
    const result = await executor.execute({
      name: "intel",
      arguments: { action: "lookup_cve", ghsa_id: "GHSA-xxxx-yyyy-zzzz" },
    });
    expect(result.success).toBe(true);
    const output = result.output as { found: boolean; advisory: { id: string } };
    expect(output.found).toBe(true);
    expect(output.advisory.id).toBe("GHSA-XXXX-YYYY-ZZZZ");
  });

  it("exposes public-report (issue/PR) search through the intel tool", async () => {
    const issuesResponse = {
      total_count: 1,
      items: [
        { title: "ReplicateToRemote leaks blob", html_url: "https://github.com/uber/kraken/issues/1", state: "open", number: 1, body: "details" },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/search/issues")) return json(issuesResponse);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const ctx: ToolContext = {
      target: "uber/kraken",
      scanId: "scan-1",
      findings: [],
      attackResults: [],
      targetInfo: {},
      role: "audit",
    };
    const executor = new ToolExecutor(ctx, null);
    const result = await executor.execute({
      name: "intel",
      arguments: {
        action: "search_public_reports",
        repository: "uber/kraken",
        terms: "ReplicateToRemote remote blob replicate",
      },
    });
    expect(result.success).toBe(true);
    const output = result.output as { count: number; reports: Array<{ url: string }>; note: string };
    expect(output.count).toBe(1);
    expect(output.reports[0]?.url).toBe("https://github.com/uber/kraken/issues/1");
    expect(output.note).toMatch(/unverified/i);
  });

  it("exposes advisory search as an agent tool", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json(OSV_RESPONSE);
      if (url.startsWith("https://api.github.com/advisories")) return json([]);
      return json({ vulnerabilities: [] });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const ctx: ToolContext = {
      target: "zipper",
      scanId: "scan-1",
      findings: [],
      attackResults: [],
      targetInfo: {},
      role: "audit",
    };
    const executor = new ToolExecutor(ctx, null);
    const result = await executor.execute({
      name: "intel",
      arguments: {
        action: "search_advisories",
        ecosystem: "npm",
        package_name: "zipper",
        version: "1.0.0",
        enrich: false,
      },
    });
    expect(result.success).toBe(true);
    expect((result.output as { count: number }).count).toBe(1);
  });

  it("exposes intel dossiers as an agent tool", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json(OSV_RESPONSE);
      if (url.startsWith("https://api.github.com/advisories")) return json([]);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json({ vulnerabilities: [] });
      return json({ vulnerabilities: [] });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const ctx: ToolContext = {
      target: "zipper",
      scanId: "scan-1",
      findings: [],
      attackResults: [],
      targetInfo: {},
      role: "audit",
    };
    const executor = new ToolExecutor(ctx, null);
    const result = await executor.execute({
      name: "intel",
      arguments: {
        action: "build_dossier",
        ecosystem: "npm",
        package_name: "zipper",
        version: "1.0.0",
        include_similar: false,
      },
    });
    expect(result.success).toBe(true);
    const output = result.output as { summary: { advisoryCount: number; playbookCount: number }; playbooks: Array<{ steps: unknown[] }> };
    expect(output.summary.advisoryCount).toBe(1);
    expect(output.summary.playbookCount).toBe(1);
    expect(output.playbooks[0]?.steps.length).toBeGreaterThan(0);
  });

  it("exposes target vulnerability history as an agent tool", async () => {
    const targetHistoryResponse = {
      vulnerabilities: [
        {
          cve: {
            ...NVD_RESPONSE.vulnerabilities[0]!.cve,
            descriptions: [{ lang: "en", value: "Path traversal in zipper archive extraction" }],
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.osv.dev/")) return json({ vulns: [] });
      if (url.startsWith("https://api.github.com/advisories")) return json([]);
      if (url.startsWith("https://services.nvd.nist.gov/")) return json(targetHistoryResponse);
      return json({ vulnerabilities: [] });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const ctx: ToolContext = {
      target: "https://github.com/org/zipper",
      scanId: "scan-1",
      findings: [],
      attackResults: [],
      targetInfo: {},
      role: "review",
      scopePath: cacheDir,
    };
    writeFileSync(join(cacheDir, "package.json"), JSON.stringify({
      name: "@org/zipper",
      repository: "https://github.com/org/zipper",
    }));
    const executor = new ToolExecutor(ctx, null);
    const result = await executor.execute({
      name: "intel",
      arguments: {
        action: "search_target_history",
        limit: 5,
      },
    });
    expect(result.success).toBe(true);
    const output = result.output as { summary: { advisoryCount: number; playbookCount: number }; playbooks: Array<{ steps: unknown[] }> };
    expect(output.summary.advisoryCount).toBe(1);
    expect(output.summary.playbookCount).toBe(1);
    expect(output.playbooks[0]?.steps.length).toBeGreaterThan(0);
  });
});
