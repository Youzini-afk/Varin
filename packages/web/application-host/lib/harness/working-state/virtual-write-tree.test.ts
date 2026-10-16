import { describe, expect, it } from "vitest";
import { assertVirtualWriteTree, VirtualWriteTreeError } from "./virtual-write-tree.js";

describe("virtual write tree invariants", () => {
  it("rejects a child path under a regular-file ancestor", () => {
    expect(() => assertVirtualWriteTree(
      { "kept.txt": { kind: "regular-file", objectHash: "h", byteLength: 1 } },
      { "kept.txt/child.ts": { kind: "regular-file", objectHash: "c", byteLength: 1 } },
    )).toThrow(VirtualWriteTreeError);
  });

  it("rejects a same-batch file/directory ancestor conflict", () => {
    expect(() => assertVirtualWriteTree({}, {
      "src": { kind: "regular-file", objectHash: "h", byteLength: 1 },
      "src/a.ts": { kind: "regular-file", objectHash: "c", byteLength: 1 },
    })).toThrow(/same batch/);
  });
});
