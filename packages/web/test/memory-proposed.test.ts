import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MemoryProposed } from "../src/components/memory-proposed";
import type { MemoryNote } from "../src/memory-model";

const note = (over: Partial<MemoryNote>): MemoryNote => ({ id: "m_p1", text: "Deploys need the staging flag", scope: "global", source: "model", status: "proposed", created: "2026-01-01T00:00:00.000Z", tainted: true, ...over });
const html = (notes: MemoryNote[], readOnly = false) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MemoryProposed, { notes, readOnly, pending: false, onAccept: () => {}, onEdit: () => {}, onReject: () => {} })));

describe("Proposed section", () => {
  it("renders nothing when there are no proposals", () => expect(html([])).toBe(""));
  it("lists each proposal with accept, edit and reject, and says why it needs review", () => {
    const markup = html([note({}), note({ id: "m_p2", text: "Skip the flaky suite" })]);
    expect(markup).toContain("Proposed"); expect(markup).toContain("Deploys need the staging flag"); expect(markup).toContain("Skip the flaky suite");
    expect(markup.match(/>Accept</g)).toHaveLength(2); expect(markup).toContain(">Edit<"); expect(markup).toContain(">Reject<");
    expect(markup).toContain("This thread read web pages or other outside content before suggesting this note."); expect(markup).toContain("not used until you accept");
  });
  it("hides the actions for a read-only viewer", () => {
    const markup = html([note({})]);
    expect(html([note({})], true)).not.toContain(">Accept<"); expect(markup).toContain(">Accept<");
  });
});
