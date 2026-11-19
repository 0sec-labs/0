import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { PageHeader, PageShell, RoutedPageShell } from "../src/components/page-shell";
import { PAGE_ROUTES, PAGE_WIDTHS, pageVariantFor, type PageVariant } from "../src/lib/workspace-navigation";

const SRC = join(__dirname, "..", "src");
const render = (path: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
  createElement(Routes, null, createElement(Route, { element: createElement(RoutedPageShell) }, createElement(Route, { path: "*", element: createElement(PageHeader, { title: "Title" }) })))));
const variantOf = (html: string) => /data-page-shell="(\w+)"/.exec(html)?.[1];

describe("page shell", () => {
  test("every concrete route renders inside the shell with the variant its route table row declares", () => {
    const samples: Record<string, string> = { "/chats/saved/:savedId": "/chats/saved/a", "/chats/:sessionId": "/chats/a", "/sentinels/:sentinelId": "/sentinels/a", "/skills/catalog/:id": "/skills/catalog/a", "/findings/:fingerprint": "/findings/a" };
    for (const route of PAGE_ROUTES) {
      const path = samples[route.path] ?? route.path;
      expect(variantOf(render(path)), path).toBe(route.variant);
      expect(pageVariantFor(path), path).toBe(route.variant);
    }
  });
  test("the variants the owner named", () => {
    const expected: Record<string, PageVariant> = { "/sentinels": "list", "/skills": "list", "/memory": "list", "/computers": "list", "/extensions": "list", "/findings": "full", "/doctor": "list", "/tools": "list", "/project": "list", "/settings": "form", "/chats/x": "full", "/agents/x": "list", "/nowhere": "list" };
    for (const [path, variant] of Object.entries(expected)) expect(variantOf(render(path)), path).toBe(variant);
  });
  test("variants set the width through the shared CSS variables, never a literal", () => {
    expect(renderToStaticMarkup(createElement(PageShell, { variant: "list" }))).toContain("max-w-(--page-width-list)");
    expect(renderToStaticMarkup(createElement(PageShell, { variant: "form" }))).toContain("max-w-(--page-width-form)");
    expect(renderToStaticMarkup(createElement(PageShell, { variant: "full" }))).not.toContain("max-w-");
  });
  test("the header is 22px/500 and the width constants match styles.css", () => {
    expect(renderToStaticMarkup(createElement(PageHeader, { title: "T" }))).toMatch(/text-\[22px\]\/7 font-medium/);
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toContain(`--page-width-list: ${PAGE_WIDTHS.list}px`);
    expect(css).toContain(`--page-width-form: ${PAGE_WIDTHS.form}px`);
  });
});
