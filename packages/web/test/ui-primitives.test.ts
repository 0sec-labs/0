import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/ui/components/button";
import { ConfirmDialog, FormDialog } from "../src/ui/components/confirm-dialog";
import { SheetPanel } from "../src/ui/components/sheet-panel";
import { StatusBadge } from "../src/ui/components/status-badge";
import { LogoTile } from "../src/ui/components/logo-tile";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("Button", () => {
  it("renders a button by default", () => {
    expect(html(createElement(Button, { variant: "outline" }, "Save"))).toMatch(/^<button[^>]*data-slot="button"[^>]*>Save<\/button>$/);
  });
  it("renders the element given as `render` with button styling and its own content", () => {
    const out = html(createElement(Button, { variant: "ghost", render: createElement("a", { href: "/x" }) }, "Open"));
    expect(out).toMatch(/^<a[^>]*href="\/x"[^>]*data-slot="button"[^>]*>Open<\/a>$/);
    expect(out).not.toContain("<button");
  });
});

describe("StatusBadge", () => {
  it("renders soft tones through the badge recipe", () => {
    const out = html(createElement(StatusBadge, { tone: "danger" }, "High"));
    expect(out).toContain('data-slot="badge"');
    expect(out).toContain('data-tone="danger"');
    expect(out).toContain("High");
  });
  it("renders the outline pill with an optional dot", () => {
    const out = html(createElement(StatusBadge, { tone: "success", appearance: "outline", dot: true }, "Connected"));
    expect(out).toContain('data-slot="status-badge"');
    expect(out).toContain("text-success");
    expect(out).toContain('data-slot="status-dot"');
  });
});

describe("LogoTile", () => {
  it("is decorative", () => {
    expect(html(createElement(LogoTile, null, "x"))).toContain('aria-hidden="true"');
  });
});

describe("dialog scaffolds", () => {
  it("render nothing while closed", () => {
    const noop = () => {};
    expect(html(createElement(ConfirmDialog, { open: false, onOpenChange: noop, title: "t", confirmLabel: "Go", onConfirm: noop }))).toBe("");
    expect(html(createElement(FormDialog, { open: false, onOpenChange: noop, title: "t", submitLabel: "Go", onSubmit: noop }))).toBe("");
    expect(html(createElement(SheetPanel, { open: false, onOpenChange: noop, title: "t" }, "body"))).toBe("");
  });
});
