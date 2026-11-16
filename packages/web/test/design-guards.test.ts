import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(__dirname, "..", "src");

/** Files (relative to src) that may use rounded-lg/xl/2xl. Each entry needs a reason; the default radius is rounded-md (see DESIGN.md). */
const ROUNDED_ALLOWED: Record<string, string> = {
  "components/appearance/theme-gallery.tsx": "Theme preview tiles are miniature app windows and keep the panel radius.",
  "components/sentinels/sentinel-avatar.tsx": "Large agent avatar tile is a deliberate squircle, like other avatars.",
  "components/skills/cells.tsx": "Catalog logo tiles are avatars and scale their radius with size.",
  "ui/components/toast.tsx": "Toast is a popover surface and uses the 8px menu radius from DESIGN.md.",
};

/** Files (relative to src) that may use style={{ }}. Everything here sets a runtime value that Tailwind cannot express statically. */
const STYLE_ALLOWED: Record<string, string> = {
  "ui/components/loader.tsx": "Animation delay per cell is computed from its grid position.",
  "ui/components/sidebar.tsx": "Publishes the dragged sidebar width as a CSS variable.",
  "ui/components/dither-backdrop.tsx": "Builds a CSS mask from a computed image.",
  "components/command-palette.tsx": "Positions the palette dialog relative to the viewport.",
  "components/findings/finding-detail.tsx": "Skeleton row widths are computed per row.",
  "components/findings/findings-list.tsx": "Virtualised list height is computed from row layout.",
  "components/console-control/connections-control.tsx": "Drag-and-drop transform and progress bar width are runtime values.",
  "components/appearance/theme-gallery.tsx": "Preview tiles paint the colors of the theme being previewed.",
  "components/sentinels/sentinel-views.tsx": "Meter fill width is a runtime percentage.",
  "components/console-control/extra-settings-pages.tsx": "Meter fill width is a runtime percentage.",
  "console/viz/chart-view.tsx": "Series colors come from the chart palette per datum.",
  "console/viz/graph-view.tsx": "Node and edge colors come from severity per datum.",
  "console/viz/timeline-view.tsx": "Marker color comes from severity per datum.",
  "pages/findings-page.tsx": "Workspace height and panel width are measured at runtime.",
  "console/loading-state.tsx": "Skeleton widths vary per row.",
  "ui/backdrops/aurora.tsx": "Each blob has its own position, size and drift time.",
  "ui/backdrops/index.tsx": "Layer opacity is computed per theme from the contrast guard; the mask is a runtime gradient.",
  "console/context-popover.tsx": "Meter fill width is a runtime percentage.",
  "console/panel/cost-popover.tsx": "Cost share bars and swatches are runtime values.",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = files(SRC).map(path => ({ path: relative(SRC, path), lines: readFileSync(path, "utf8").split("\n") }));
const offenders = (pattern: RegExp, allowed: Record<string, string>) =>
  sources.filter(file => !(file.path in allowed)).flatMap(file => file.lines.flatMap((line, index) => pattern.test(line) ? [`${file.path}:${index + 1}`] : []));
const ROUNDED = /\brounded(-[a-z]{1,2})?-(lg|xl|2xl|3xl)\b/;
const STYLE = /style=\{\{/;

describe("design guards", () => {
  test("surfaces use rounded-md, not rounded-lg/xl/2xl, outside the allowlist", () => {
    expect(offenders(ROUNDED, ROUNDED_ALLOWED)).toEqual([]);
  });
  test("inline style={{ }} stays inside the allowlist; use Tailwind classes or design-system components", () => {
    expect(offenders(STYLE, STYLE_ALLOWED)).toEqual([]);
  });
  test("every allowlist entry is still needed", () => {
    const stale = (pattern: RegExp, allowed: Record<string, string>) => Object.keys(allowed).filter(path => !sources.find(file => file.path === path)?.lines.some(line => pattern.test(line)));
    expect([...stale(ROUNDED, ROUNDED_ALLOWED), ...stale(STYLE, STYLE_ALLOWED)]).toEqual([]);
  });
  test("pages get their width and padding from PageShell: no max-w-*, mx-auto or PageContent in page files", () => {
    // Dialogs, sheets and the fixed findings panel size themselves; everything else in pages/ must not set a column.
    const OWN = /\bmx-auto\b|\bmax-w-(?:sm|md|lg|xl|[2-7]xl|prose|screen|\[\d|\(--)|\bPageContent\b/;
    const found = sources.filter(file => file.path.startsWith("pages/")).flatMap(file => file.lines.flatMap((line, index) => OWN.test(line) && !/Dialog|Sheet|fixed /.test(line) ? [`${file.path}:${index + 1}`] : []));
    expect(found).toEqual([]);
  });
  test("every page route is wrapped by RoutedPageShell and declared in PAGE_ROUTES", () => {
    const app = readFileSync(join(SRC, "pages", "operations-app.tsx"), "utf8");
    expect(app).toContain("<Route element={<RoutedPageShell />}>");
    const inside = app.slice(app.indexOf("<Route element={<RoutedPageShell />}>"));
    const nav = readFileSync(join(SRC, "lib", "workspace-navigation.ts"), "utf8");
    const paths = [...inside.matchAll(/<Route path="(\/[^"]+)"/g)].map(match => match[1]!);
    expect(paths.length).toBeGreaterThan(8);
    for (const path of paths) expect(nav, path).toContain(`path: "${path}"`);
    for (const name of ["connections", "models", "settings", "doctor", "tools", "project", "fix"]) expect(nav).toContain(`path: "/${name}"`);
  });
});
