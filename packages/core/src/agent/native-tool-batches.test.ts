import { describe, expect, it } from "vitest";
import { nativeToolBatches } from "./native-tool-batches.js";

const batches = (names: string[], enabled = true) =>
  [...nativeToolBatches(names.map(name => ({ name })), enabled)].map(batch => batch.map(call => call.name));

describe("native tool batches", () => {
  it("bounds local reads and preserves stateful barriers", () => {
    expect(batches(["read_file", "list_files", "search_files", "read_file", "read_file", "apply_patch", "read_file", "http_request", "read_file", "done"]))
      .toEqual([["read_file", "list_files", "search_files", "read_file"], ["read_file"], ["apply_patch"], ["read_file"], ["http_request"], ["read_file"], ["done"]]);
  });

  it("keeps unknown tools and authority-driven calls serial", () => {
    expect(batches(["custom_read", "browser", "query_findings"])).toEqual([["custom_read"], ["browser"], ["query_findings"]]);
    expect(batches(["read_file", "list_files"], false)).toEqual([["read_file"], ["list_files"]]);
    expect(batches([])).toEqual([]);
  });
});
