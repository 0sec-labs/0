import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageToolbar } from "../src/console/message-toolbar";

const html = (props: Partial<Parameters<typeof MessageToolbar>[0]> = {}) =>
  renderToStaticMarkup(createElement(MessageToolbar, { iso: "2026-03-03T12:16:00Z", text: "Hello", onReply: () => {}, link: "https://x/#m", ...props }));

describe("MessageToolbar", () => {
  it("is out of flow and hidden until the rail is hovered or focused, and visible on touch", () => {
    const out = html();
    expect(out).toContain("absolute top-0");
    expect(out).toContain("opacity-0");
    expect(out).toContain("group-hover/rail:opacity-100");
    expect(out).toContain("group-focus-within/rail:opacity-100");
    expect(out).toContain("[@media(hover:none)]:opacity-100");
    expect(out).toContain("motion-reduce:transition-none");
  });
  it("uses ghost icon buttons with accessible names and no native title tooltips", () => {
    const out = html();
    for (const name of ["Reply", "Copy message", "More"]) expect(out).toContain(`aria-label="${name}"`);
    expect(out).toContain('data-variant="ghost"');
    expect(out).not.toContain("title=");
  });
  it("omits Reply when the reader cannot write", () => {
    expect(html({ onReply: undefined })).not.toContain('aria-label="Reply"');
  });
});
