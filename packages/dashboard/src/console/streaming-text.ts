type TextNode = { type: string; value?: string; children?: TextNode[]; data?: Record<string, unknown> };

/** Stable word spans: existing words keep their DOM nodes as the stream grows. */
export function streamWordFade() {
  return (tree: TextNode) => {
    const visit = (node: TextNode) => {
      if (!node.children || ["code", "inlineCode", "html"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        return (child.value.match(/\S+\s*|\s+/gu) ?? []).map(value => ({
          type: "streamWord",
          data: { hName: "span", hProperties: { className: ["console-stream-word"] }, hChildren: [{ type: "text", value }] },
        }));
      });
    };
    visit(tree);
  };
}
