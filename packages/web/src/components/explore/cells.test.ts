import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Tile } from "./cells";

const png = "data:image/png;base64,iVBORw0KGgo=";
const svg = "data:image/svg+xml;base64,PHN2Zy8+";
const render = (props: Parameters<typeof Tile>[0]) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Tile, props)));

describe("Tile", () => {
  it("is a 48 px rounded-lg tile that clips its logo", () => {
    const html = render({ logo: svg, fallback: "fallback" });
    expect(html).toContain("size-12"); expect(html).toContain("rounded-lg"); expect(html).toContain("overflow-hidden");
    expect(html).toContain(`src="${svg}"`);
  });
  it("shows the owner avatar from a same-origin data URI and a verified badge only when asked", () => {
    expect(render({ avatar: png, name: "Matt Pocock" })).not.toContain('role="img"');
    const html = render({ avatar: png, name: "Matt Pocock", verified: true, verifiedLabel: "Verified by 0" });
    expect(html).toContain(`src="${png}"`); expect(html).toContain('aria-label="Verified by 0"');
  });
  it("falls back to the owner initials when there is no avatar, and never loads a remote image", () => {
    const html = render({ avatar: "https://avatars.githubusercontent.com/u/1?s=88", name: "Matt Pocock" });
    expect(html).toContain(">MP<"); expect(html).not.toContain("<img"); expect(html).not.toContain("githubusercontent");
    expect(render({ avatar: "", name: "Semgrep" })).toContain(">SE<");
  });
  it("drops a remote logo and renders the fallback instead", () => {
    const html = render({ logo: "https://cdn.example/logo.png", fallback: "FALLBACK" });
    expect(html).toContain("FALLBACK"); expect(html).not.toContain("<img");
  });
});
