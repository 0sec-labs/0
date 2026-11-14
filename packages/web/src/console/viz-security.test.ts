// Adversarial corpus for the console visualisation surface: Markdown, SVG sanitiser
// and the viz spec validators/renderers (src/console/viz).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareMarkdown, stripUnsafeText } from "./markdown-guard";
import ChartView from "./viz/chart-view";
import GraphView from "./viz/graph-view";
import TableView from "./viz/table-view";
import TimelineView from "./viz/timeline-view";
import { Visualization, VIZ_LIMITS, sanitizeSvg, validateViz } from "./viz";

const BIDI = "‮‭‪‫‬⁦⁧⁨⁩‎‏";
const ANSI = "\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007";

/** Markup that must never survive into rendered output as an active element/attribute. */
const ACTIVE =
  /<\s*(script|iframe|object|embed|foreignObject|link|meta|base|form|style)\b|\son[a-z]+\s*=|(href|src|xlink:href|action|formaction)\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/i;

export const markdownCorpus: Record<string, string> = {
  rawScript: "hello <script>window.__pwn=1</script> world",
  imgOnerror: '<img src=x onerror="window.__pwn=1">',
  svgOnload: '<svg onload="window.__pwn=1"><circle r=1 /></svg>',
  jsLink: "[click](javascript:window.__pwn=1)",
  jsLinkEncoded: "[click](&#106;avascript:alert(1))",
  jsLinkSpaces: "[click](   javascript:alert(1))",
  dataHtmlLink: "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  vbLink: "[x](vbscript:msgbox(1))",
  autolink: "<javascript:alert(1)>",
  refLink: "[x][r]\n\n[r]: javascript:alert(1)",
  imgJs: "![x](javascript:alert(1))",
  imgExternalHttp: "![x](http://evil.test/p.png)",
  imgDataSvg: "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  imgDataHtml: "![x](data:text/html,<script>alert(1)</script>)",
  htmlComment: "<!-- --><script>alert(1)</script>",
  details: "<details open ontoggle=alert(1)><summary>x</summary></details>",
  styleTag: "<style>@import url(https://evil.test/x.css)</style>",
  metaRefresh: '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  formPost: '<form action="https://evil.test"><input name=t></form>',
  mermaidScriptLabel: '```mermaid\ngraph TD\nA["<script>alert(1)</script>"] --> B\n```',
  mermaidClick: '```mermaid\ngraph TD\nA-->B\nclick A href "javascript:alert(1)"\n```',
  mermaidInit: '```mermaid\n%%{init: {"securityLevel":"loose"}}%%\ngraph TD\nA-->B\n```',
  codeFenceBreakout: "```js\nx\n```\n<script>alert(1)</script>\n```",
  htmlInFence: "```html\n<script>alert(1)</script>\n```",
  protoKeys: '```json\n{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}\n```',
  chartFenceProto: '```chart\n{"__proto__":{"polluted":1},"type":"bar","series":[]}\n```',
  bidi: `safe ${BIDI}txt.exe and [${BIDI}link](https://example.com)`,
  ansi: `${ANSI}`,
  huge: "a".repeat(2_000_000),
  deepNesting: "> ".repeat(2_000) + "x",
  manyEmphasis: "*".repeat(100_000) + "x" + "*".repeat(100_000),
  hugeTable: `| a | b |\n|---|---|\n${"| x | y |\n".repeat(5_000)}`,
};

export const svgCorpus: Record<string, string> = {
  script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>',
  onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="alert(1)"/></svg>',
  foreignObject:
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject></svg>',
  useExternal:
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.test/x.svg#a"/><use href="https://evil.test/x.svg#a"/></svg>',
  useData: '<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>',
  imageExternal: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/p.png"/></svg>',
  anchorJs:
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a><a xlink:href="javascript:alert(1)"><text>y</text></a></svg>',
  animateHref:
    '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
  setHandler: '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onmouseover" to="alert(1)"/></svg>',
  styleImport:
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.test/x.css); rect{fill:url(https://evil.test/a)}</style></svg>',
  styleAttrUrl:
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.test/a);background:url(javascript:alert(1))"/></svg>',
  entityScript:
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&lt;script&gt;alert(1)&lt;/script&gt;</text><a href="&#106;avascript:alert(1)">x</a></svg>',
  cdata: '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<script>alert(1)</script>]]></svg>',
  mixedCase: '<svg xmlns="http://www.w3.org/2000/svg"><ScRiPt>alert(1)</ScRiPt><IMG SRC=x OnErRoR=alert(1)></svg>',
  htmlNamespaceBreakout: '<svg><p><style><a title="</style><img src onerror=alert(1)>"></style></p></svg>',
  huge: `<svg xmlns="http://www.w3.org/2000/svg">${"<g>".repeat(20_000)}</svg>`,
};

/** Graph/chart/table/timeline specs; every string field is attacker-controlled. */
const xss = "<img src=x onerror=alert(1)><script>alert(1)</script>";
function parse(json: string): unknown {
  return JSON.parse(json);
}
export const specCorpus: Array<{ name: string; kind: string; spec: unknown }> = [
  {
    name: "graph script labels",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: xss,
      nodes: [
        { id: "a", label: xss, type: "host" },
        { id: "b", label: "javascript:alert(1)", type: "vuln" },
      ],
      edges: [{ from: "a", to: "b", label: xss }],
    },
  },
  {
    name: "graph url ref",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [{ id: "a", label: "a", type: "host", ref: { url: "javascript:alert(1)", href: "https://evil.test" } }],
      edges: [],
    },
  },
  {
    name: "graph proto ids",
    kind: "graph",
    spec: parse(
      '{"kind":"graph","summary":"s","nodes":[{"id":"__proto__","label":"x","type":"host"},{"id":"constructor","label":"y","type":"host"},{"id":"toString","label":"z","type":"host"}],"edges":[{"from":"__proto__","to":"constructor"}]}',
    ),
  },
  {
    name: "graph proto spec keys",
    kind: "graph",
    spec: parse(
      '{"__proto__":{"polluted":1},"kind":"graph","summary":"s","nodes":[],"edges":[],"constructor":{"prototype":{"polluted":1}}}',
    ),
  },
  {
    name: "graph dangling edges",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [{ id: "a", label: "a", type: "host" }],
      edges: [
        { from: "a", to: "ghost" },
        { from: "ghost", to: "ghost" },
      ],
    },
  },
  {
    name: "graph self loop cycle",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [
        { id: "a", label: "a", type: "host" },
        { id: "b", label: "b", type: "host" },
      ],
      edges: [
        { from: "a", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    },
  },
  {
    name: "graph too many nodes",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: Array.from({ length: 50_000 }, (_, i) => ({ id: `n${i}`, label: "x", type: "host" })),
      edges: [],
    },
  },
  {
    name: "graph too many edges",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [{ id: "a", label: "a", type: "host" }],
      edges: Array.from({ length: 100_000 }, () => ({ from: "a", to: "a" })),
    },
  },
  {
    name: "graph huge label",
    kind: "graph",
    spec: { kind: "graph", summary: "s", nodes: [{ id: "a", label: "A".repeat(5_000_000), type: "host" }], edges: [] },
  },
  {
    name: "graph bidi ansi labels",
    kind: "graph",
    spec: { kind: "graph", summary: "s", nodes: [{ id: "a", label: `${BIDI}${ANSI}`, type: "host" }], edges: [] },
  },
  {
    name: "graph non-string ids",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [{ id: { toString: "x" }, label: 1, type: ["host"] }, null, 7, "x"],
      edges: [null, [], { from: {}, to: [] }],
    },
  },
  {
    name: "graph unknown severity type",
    kind: "graph",
    spec: {
      kind: "graph",
      summary: "s",
      nodes: [{ id: "a", label: "a", type: '"><script>', severity: 'x" onmouseover="alert(1)' }],
      edges: [],
    },
  },
  {
    name: "chart script series",
    kind: "chart",
    spec: { type: "bar", title: xss, unit: xss, x: xss, series: [{ name: xss, data: [["<script>", 1]] }] },
  },
  {
    name: "chart nan inf",
    kind: "chart",
    spec: {
      type: "line",
      title: "t",
      series: [
        {
          name: "s",
          data: [
            [0, Number.NaN],
            [1, Number.POSITIVE_INFINITY],
            [2, -1e308],
            [3, 1e308],
          ],
        },
      ],
    },
  },
  {
    name: "chart huge series",
    kind: "chart",
    spec: {
      type: "line",
      title: "t",
      series: Array.from({ length: 5_000 }, (_, i) => ({
        name: `s${i}`,
        data: Array.from({ length: 1_000 }, (_, j) => [j, j]),
      })),
    },
  },
  {
    name: "chart proto",
    kind: "chart",
    spec: parse(
      '{"__proto__":{"polluted":1},"type":"bar","title":"t","series":[{"__proto__":{"polluted":1},"name":"s","data":[[1,1]]}]}',
    ),
  },
  {
    name: "chart color injection",
    kind: "chart",
    spec: { type: "bar", title: "t", series: [{ name: "s", color: "red;} body{display:none} x{", data: [[1, 1]] }] },
  },
  {
    name: "table script cells",
    kind: "table",
    spec: {
      columns: [
        { key: "a", label: xss },
        { key: "__proto__", label: "p" },
      ],
      rows: [{ a: xss, __proto__: { polluted: 1 } }, parse('{"a":"x","__proto__":{"polluted":1}}')],
    },
  },
  {
    name: "table csv injection",
    kind: "table",
    spec: {
      columns: [{ key: "a", label: '=HYPERLINK("https://evil.test")' }],
      rows: [{ a: "=cmd|' /C calc'!A0" }, { a: "+1+1" }, { a: "@SUM(1)" }, { a: "-2+3" }],
    },
  },
  {
    name: "table huge rows",
    kind: "table",
    spec: { columns: [{ key: "a", label: "a" }], rows: Array.from({ length: 200_000 }, () => ({ a: "x" })) },
  },
  {
    name: "table ragged",
    kind: "table",
    spec: { columns: [{ key: "a", label: "a" }], rows: [null, 1, "x", [], { b: 1 }, { a: { toString: 1 } }] },
  },
  {
    name: "timeline script",
    kind: "timeline",
    spec: {
      events: [
        { t: xss, label: xss, kind: xss, severity: xss },
        { t: "not a date", label: "x" },
        { t: 8.64e15 + 1, label: "overflow" },
      ],
    },
  },
  { name: "unknown kind", kind: "__proto__", spec: {} },
  {
    name: "mermaid in spec",
    kind: "mermaid",
    spec: { source: 'graph TD\nA["<script>alert(1)</script>"]-->B\nclick A href "javascript:alert(1)"' },
  },
  {
    name: "vega url",
    kind: "vega-lite",
    spec: {
      data: { url: "https://evil.test/data.json" },
      mark: "bar",
      transform: [{ calculate: "constructor.constructor('alert(1)')()", as: "x" }],
    },
  },
];

function noPollution() {
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
}

describe("corpus sanity", () => {
  it("is non-trivial", () => {
    expect(Object.keys(markdownCorpus).length).toBeGreaterThan(25);
    expect(Object.keys(svgCorpus).length).toBeGreaterThan(12);
    expect(specCorpus.length).toBeGreaterThan(20);
  });
});

describe("markdown renderer is inert", () => {
  let Markdown: (typeof import("./markdown"))["Markdown"];
  let imageSource: (typeof import("./inline-image"))["imageSource"];
  beforeAll(async () => {
    // The renderer reads window.location; provide the minimum for node SSR.
    (globalThis as { window?: unknown }).window ??= {
      location: { origin: "http://127.0.0.1:3000", href: "http://127.0.0.1:3000/" },
    };
    ({ Markdown } = await import("./markdown"));
    ({ imageSource } = await import("./inline-image"));
  });

  for (const [name, text] of Object.entries(markdownCorpus)) {
    it(`renders ${name} without active content`, () => {
      const started = Date.now();
      const html = renderToStaticMarkup(createElement(Markdown, { text }));
      expect(html).not.toMatch(ACTIVE);
      // No remote or non-raster image may be fetched automatically.
      expect(html).not.toMatch(/<img[^>]+src=["']?(https?:|data:image\/svg|data:text|javascript)/i);
      expect(Date.now() - started).toBeLessThan(15_000);
      noPollution();
    });
  }

  it("keeps hostile link targets out of href", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: "[a](javascript:alert(1)) [b](vbscript:x) [c](data:text/html,x) [d](https://example.com)",
      }),
    );
    expect(html).not.toMatch(/href=["']?(javascript|vbscript|data):/i);
    expect(html).toContain("https://example.com");
  });

  it("imageSource accepts only raster data, https and same-origin", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,AAAA",
      'data:image/png;base64,AAAA"onerror="x',
      "http://evil.test/p.png",
      "https://user:pw@evil.test/p.png",
      "file:///etc/passwd",
      "//evil.test/p.png\\@x",
      "vbscript:x",
      "",
    ]) {
      const out = imageSource(bad);
      expect(out === undefined || /^https:\/\/(?!user)/.test(out) || out.startsWith("http://127.0.0.1:3000/")).toBe(
        true,
      );
      expect(out ?? "").not.toMatch(
        /^(javascript|data:(?!image\/(png|jpeg|webp|gif);base64,)|file|vbscript|http:\/\/evil)/i,
      );
    }
    expect(imageSource("data:image/png;base64,iVBORw0KGgo=")).toBeTruthy();
  });

  it("survives 2000-deep blockquote nesting without throwing", () => {
    expect(() => renderToStaticMarkup(createElement(Markdown, { text: "> ".repeat(2_000) + "x" }))).not.toThrow();
    expect(prepareMarkdown("> ".repeat(2_000) + "x").plain).toBe(true);
    expect(prepareMarkdown("> quoted\n> - item\n>   more").plain).toBe(false);
  });

  it("renders a 100k-delimiter emphasis run in bounded time", () => {
    const started = Date.now();
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: "*".repeat(100_000) + "x" + "*".repeat(100_000) }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(html).toContain("x");
    const interleaved = renderToStaticMarkup(createElement(Markdown, { text: "*_".repeat(50_000) + "x" }));
    expect(interleaved).toContain("x");
  });

  it("strips bidi override and ANSI control characters from rendered text", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: `safe ${BIDI}txt.exe ${ANSI} [${BIDI}link](https://example.com) \u0000\u0007` }),
    );
    expect(html).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(html).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(html).toContain("txt.exe");
    expect(stripUnsafeText("a\u001b[31mb\u001b[0m\u001b]8;;https://x\u0007c")).toBe("abc");
  });

  it("keeps ordinary documents untouched", () => {
    const text = "# Title\n\n- a\n  - b\n\n> q\n\n**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(prepareMarkdown(text)).toEqual({ text, plain: false });
  });
});

// ---- Contract suite for ./viz ------------------------------------------------------
const MUST_REJECT = new Set([
  "graph too many nodes",
  "graph too many edges",
  "graph non-string ids",
  "chart huge series",
  "table huge rows",
  "unknown kind",
  "vega url",
  "graph proto spec keys",
]);

function renderVisualToString(kind: string, spec: unknown): string {
  const result = validateViz(kind, spec);
  if (!result.ok) return "";
  const { spec: valid } = result;
  // Views are lazy inside Visualization (SSR shows a skeleton), so render them directly too.
  const body =
    valid.kind === "graph"
      ? createElement(GraphView, { spec: valid })
      : valid.kind === "chart"
        ? createElement(ChartView, { spec: valid })
        : valid.kind === "timeline"
          ? createElement(TimelineView, { spec: valid })
          : valid.kind === "table"
            ? createElement(TableView, { spec: valid })
            : undefined;
  return renderToStaticMarkup(createElement(Visualization, { spec: valid })) + (body ? renderToStaticMarkup(body) : "");
}

/** Escaped text may legitimately contain "onerror=" as words; only real tags and attributes matter. */
const markupOnly = (html: string) =>
  html
    .replace(/<style data-precedence="base-ui[^"]*"[^>]*>[^<]*<\/style>/g, "") // base-ui's own scrollbar rule
    .replace(/\s(?!href|src|xlink:href|action|formaction)([\w:-]+)="[^"]*"/g, ' $1=""')
    .replace(/>[^<]*</g, "><");

describe("sanitizeSvg", () => {
  for (const [name, svg] of Object.entries(svgCorpus)) {
    it(`neutralises ${name}`, () => {
      const out = sanitizeSvg(svg);
      expect(out).not.toMatch(ACTIVE);
      expect(out).not.toMatch(
        /foreignObject|<\s*(image|a)\b|<\s*use\b[^>]*href\s*=\s*["'](?!#)|@import|url\(\s*["']?(https?:|javascript:)/i,
      );
      expect(out).not.toMatch(/<\s*(animate|set)\b/i);
    });
  }

  it("keeps benign diagrams, local references and local styles", () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 10 10" width="10"><defs><marker id="m"><path d="M0 0L1 1"/></marker><linearGradient id="g"><stop offset="0"/></linearGradient></defs><style>#d .x{fill:red}</style><rect id="r" style="fill:url(#g);stroke:red" marker-end="url(#m)"/><use href="#r"/><text>hi &amp; bye</text></svg>',
    );
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain("<linearGradient");
    expect(out).toContain("<style>#d .x{fill:red}</style>");
    expect(out).toContain('marker-end="url(#m)"');
    expect(out).toContain('<use href="#r"/>');
    expect(out).toContain("hi &amp; bye");
  });

  it("strips url() and event handlers from style attributes", () => {
    const out = sanitizeSvg('<svg><rect onclick="x()" style="fill:url(https://evil.test/a);stroke:blue"/></svg>');
    expect(out).toContain("stroke:blue");
    expect(out).not.toMatch(/evil|onclick/);
  });
});

describe("viz validation and rendering are inert", () => {
  for (const { name, kind, spec } of specCorpus) {
    it(`handles ${name}`, () => {
      const result = validateViz(kind, spec);
      if (MUST_REJECT.has(name)) expect(result.ok).toBe(false);
      if (name === "graph huge label" && result.ok && result.spec.kind === "graph") {
        expect(result.spec.nodes[0]!.label.length).toBeLessThanOrEqual(VIZ_LIMITS.nodeLabel);
      }
      const html = renderVisualToString(kind, spec);
      expect(markupOnly(html)).not.toMatch(ACTIVE);
      expect(html).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
      expect(html).not.toContain("\u001b");
      expect(html).not.toMatch(/(href|src|action)="[^"]*evil\.test/); // visible text may mention it; nothing may load it
      noPollution();
    });
  }

  it("never leaks bidi or ANSI characters into validated labels", () => {
    const result = validateViz("graph", { nodes: [{ id: "a", label: `${BIDI}${ANSI}` }] });
    expect(result.ok).toBe(true);
    if (result.ok && result.spec.kind === "graph")
      expect(result.spec.nodes[0]!.label).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u001b]/);
  });
});
