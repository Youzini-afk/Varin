import { describe, expect, it } from "vitest";
import {
  isBinaryBuffer,
  lcsMatches,
  mergeText3Way,
  planThreeWayPath,
  buildThreeWayMergePlan,
} from "./three-way-merge.js";
import type { RecoveryState } from "./types.js";

describe("three-way-merge", () => {
  it("detects binary buffers containing null bytes", () => {
    expect(isBinaryBuffer(Buffer.from("hello world"))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from("text\0more"))).toBe(true);
    expect(isBinaryBuffer(Buffer.from([0x80, 0x41]))).toBe(true);
    expect(isBinaryBuffer(Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0])]))).toBe(true);
  });

  it("matches a ten-thousand-line file with two small edits without a quadratic matrix", () => {
    const base = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
    const changed = [...base];
    changed[123] = "changed-123";
    changed[9_876] = "changed-9876";
    const matches = lcsMatches(base, changed);
    expect(matches).toHaveLength(9_998);
    expect(matches[0]).toEqual([0, 0]);
    expect(matches.at(-1)).toEqual([9_999, 9_999]);
  });

  describe("mergeText3Way", () => {
    it("returns clean child when parent equals base", () => {
      const res = mergeText3Way("base", "base", "child");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("child");
    });

    it("returns clean parent when child equals base", () => {
      const res = mergeText3Way("base", "parent", "base");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("parent");
    });

    it("returns clean when parent and child make the same change", () => {
      const res = mergeText3Way("base", "modified", "modified");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("modified");
    });

    it("merges non-overlapping changes cleanly", () => {
      const base = "line1\nline2\nline3";
      const parent = "parent1\nline2\nline3";
      const child = "line1\nline2\nchild3";
      const res = mergeText3Way(base, parent, child);
      expect(res.clean).toBe(true);
      expect(res.text).toBe("parent1\nline2\nchild3");
    });

    it("preserves mixed line endings and a final line without a newline", () => {
      const base = "one\r\ntwo\nthree";
      const parent = "parent\r\ntwo\nthree";
      const child = "one\r\ntwo\nchild";
      const merged = mergeText3Way(base, parent, child);
      expect(merged).toEqual({ clean: true, text: "parent\r\ntwo\nchild" });
    });

    it("injects conflict markers for overlapping contradictory changes", () => {
      const base = "line1\nline2\nline3";
      const parent = "line1\nparent2\nline3";
      const child = "line1\nchild2\nline3";
      const res = mergeText3Way(base, parent, child);
      expect(res.clean).toBe(false);
      expect(res.text).toContain("<<<<<<< parent\nparent2\n=======\nchild2\n>>>>>>> child");
    });

    it("treats partially overlapping replacement ranges as a conflict", () => {
      const merged = mergeText3Way(
        "A\nB\nC\nD",
        "P1\nP2\nC\nD",
        "A\nC1\nC2\nD",
      );
      expect(merged.clean).toBe(false);
      expect(merged.text).toContain("<<<<<<< parent");
      expect(merged.text).toContain("P1\nP2\nC");
      expect(merged.text).toContain("A\nC1\nC2");
    });
  });

  describe("planThreeWayPath", () => {
    it('merges independent xattrs and a child binary change without reading bodies',async()=>{
      const native={uid:0,gid:0,created:null,modified:{seconds:1,nanos:0},backup:null,windowsAttributes:0,bsdFlags:0,security:null,reparseData:null,xattrs:{}};
      const base={kind:'regular-file' as const,objectHash:'base',byteLength:2,mode:0o644,native};
      const parent={...base,native:{...native,xattrs:{dXNlci5w:[1]}}};
      const child={...base,objectHash:'child',native:{...native,modified:{seconds:2,nanos:0},xattrs:{dXNlci5j:[2]}}};
      let reads=0;
      const plan=await planThreeWayPath({path:'binary',baseState:base,parentState:parent,childState:child,readContent:async()=>{reads++;return Buffer.from([0,1]);}});
      expect(plan.decision).toBe('merge-clean');expect(reads).toBe(0);
      expect(plan.mergedState).toEqual({...child,native:{...child.native,xattrs:{dXNlci5w:[1],dXNlci5j:[2]}}});
    });
    it('retains an attribute conflict even when both bodies are identical',async()=>{
      const native={uid:0,gid:0,created:null,modified:{seconds:1,nanos:0},backup:null,windowsAttributes:0,bsdFlags:0,security:null,reparseData:null,xattrs:{dXNlcg:[0]}};
      const base={kind:'directory' as const,mode:0o755,native};
      const parent={...base,native:{...native,xattrs:{dXNlcg:[1]}}};
      const child={...base,native:{...native,xattrs:{dXNlcg:[2]}}};
      const plan=await planThreeWayPath({path:'directory',baseState:base,parentState:parent,childState:child,readContent:async()=>null});
      expect(plan.decision).toBe('conflict');expect(plan.conflictReason).toContain('attributes');
    });
    const fileState = (hash: string, mode = 0o644): RecoveryState => ({
      kind: "regular-file",
      objectHash: hash,
      byteLength: 10,
      mode,
    });
    const missingState: RecoveryState = { kind: "missing" };

    it("marks identical when parent equals child", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-1"),
        childState: fileState("hash-1"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("identical");
    });

    it("applies child when parent is unchanged from base", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-base"),
        childState: fileState("hash-child"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("apply-child");
    });

    it("keeps parent when child is unchanged from base", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-parent"),
        childState: fileState("hash-base"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("keep-parent");
    });

    it("merges cleanly when text changes do not overlap", async () => {
      const base = "line1\nline2\nline3";
      const parent = "parent1\nline2\nline3";
      const child = "line1\nline2\nchild3";

      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("h-base"),
        parentState: fileState("h-parent"),
        childState: fileState("h-child"),
        readContent: async (s) => {
          if (s === missingState) return null;
          if (s.kind !== "regular-file") return null;
          if (s.objectHash === "h-base") return Buffer.from(base);
          if (s.objectHash === "h-parent") return Buffer.from(parent);
          if (s.objectHash === "h-child") return Buffer.from(child);
          return null;
        },
      });

      expect(plan.decision).toBe("merge-clean");
      expect(plan.mergedText).toBe("parent1\nline2\nchild3");
    });

    it("preserves a parent-only mode change while merging independent child text", async () => {
      const content = new Map([
        ["base", Buffer.from("one\ntwo\nthree")],
        ["parent", Buffer.from("parent\ntwo\nthree")],
        ["child", Buffer.from("one\ntwo\nchild")],
      ]);
      const plan = await planThreeWayPath({
        path: "script.sh",
        baseState: { kind: "regular-file", objectHash: "base", byteLength: 13, mode: 0o644 },
        parentState: { kind: "regular-file", objectHash: "parent", byteLength: 16, mode: 0o755 },
        childState: { kind: "regular-file", objectHash: "child", byteLength: 13, mode: 0o644 },
        readContent: async (state) => state.kind === "regular-file" ? content.get(state.objectHash) ?? null : null,
      });
      expect(plan.decision).toBe("merge-clean");
      expect(plan.mergedMode).toBe(0o755);
    });

    it("flags conflict for binary files modified on both sides", async () => {
      const bin1 = Buffer.from([0x00, 0x01, 0x02]);
      const bin2 = Buffer.from([0x00, 0x01, 0x03]);

      const plan = await planThreeWayPath({
        path: "a.bin",
        baseState: fileState("h-base"),
        parentState: fileState("h-parent"),
        childState: fileState("h-child"),
        readContent: async (s) => {
          if (s.kind !== "regular-file") return null;
          if (s.objectHash === "h-base") return Buffer.from([0x00, 0x00]);
          if (s.objectHash === "h-parent") return bin1;
          return bin2;
        },
      });

      expect(plan.decision).toBe("conflict");
      expect(plan.conflictReason).toContain("Binary");
    });

    it("flags structural conflict when deleted on one side and modified on the other", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("h-base"),
        parentState: missingState,
        childState: fileState("h-child"),
        readContent: async () => Buffer.from("child content"),
      });

      expect(plan.decision).toBe("conflict");
      expect(plan.conflictReason).toContain("deleted");
    });
  });

  describe("buildThreeWayMergePlan", () => {
    it("aggregates applied and conflict paths", async () => {
      const plan = await buildThreeWayMergePlan({
        operationId: "op-1",
        workspaceId: "ws-1",
        threadId: "th-1",
        resultRevision: 1,
        allPaths: ["clean.txt", "conflict.txt"],
        baseState: {
          "clean.txt": { kind: "regular-file", objectHash: "b-clean", byteLength: 4 },
          "conflict.txt": { kind: "regular-file", objectHash: "b-conf", byteLength: 4 },
        },
        parentState: {
          "clean.txt": { kind: "regular-file", objectHash: "b-clean", byteLength: 4 },
          "conflict.txt": { kind: "regular-file", objectHash: "p-conf", byteLength: 6 },
        },
        childState: {
          "clean.txt": { kind: "regular-file", objectHash: "c-clean", byteLength: 7 },
          "conflict.txt": { kind: "missing" },
        },
        readContent: async () => Buffer.from("test"),
      });

      expect(plan.clean).toBe(false);
      expect(plan.appliedPaths).toEqual(["clean.txt"]);
      expect(plan.conflictPaths).toEqual(["conflict.txt"]);
      expect(plan.diffStats.files).toBe(2);
    });
  });
});
