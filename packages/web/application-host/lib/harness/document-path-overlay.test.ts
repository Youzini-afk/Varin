import { describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext } from "@varin/protocol";
import { createSurfaceSnapshotStore } from "../documents/surface-snapshot-store.js";
import { createDocumentPathOverlayService } from "./harness-services.js";

const actor: HarnessActorContext = {
  authorityInstanceId: "host",
  sessionId: "session",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace",
  grantedCapabilities: ["read.document"],
};

const contextFor = (store: ReturnType<typeof createSurfaceSnapshotStore>): AgentInputContext => store.capture({
  ownerId: "surface",
  sessionId: actor.sessionId,
  resources: [
    {
      baseRevision: null,
      bom: false,
      content: "new",
      encoding: "utf-8",
      localEditRevision: 2,
      resource: { workspaceId: actor.workspaceId!, resourceId: "new.ts" },
    },
    {
      baseRevision: null,
      bom: false,
      content: "nested",
      encoding: "utf-8",
      localEditRevision: 3,
      resource: { workspaceId: actor.workspaceId!, resourceId: "src/deep/new.ts" },
    },
    {
      baseRevision: null,
      bom: false,
      content: "other",
      encoding: "utf-8",
      localEditRevision: 4,
      resource: { workspaceId: actor.workspaceId!, resourceId: "src/deep/readme.md" },
    },
    {
      baseRevision: null,
      bom: false,
      content: "spaced",
      encoding: "utf-8",
      localEditRevision: 5,
      resource: { workspaceId: actor.workspaceId!, resourceId: "src/ spaced .space" },
    },
  ],
});

describe("fixed surface path overlay", () => {
  it("returns dirty files, revisions, and virtual directory ancestors", () => {
    const store = createSurfaceSnapshotStore();
    const context = contextFor(store);
    const result = store.overlay(actor.sessionId, context, "", actor.workspaceId!);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready overlay");
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "new.ts", kind: "file", revision: expect.stringMatching(/^surface-draft:/) }),
      expect.objectContaining({ path: "src", kind: "directory" }),
      expect.objectContaining({ path: "src/deep", kind: "directory" }),
    ]));
    const nestedRoot = store.overlay(actor.sessionId, context, "src", actor.workspaceId!);
    expect(nestedRoot).toEqual(expect.objectContaining({ status: "ready" }));
    if (nestedRoot.status !== "ready") throw new Error("expected nested root overlay");
    expect(nestedRoot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".", kind: "directory" }),
      expect.objectContaining({ path: "deep/new.ts", kind: "file" }),
    ]));
    store.dispose();
  });

  it("treats an expired related snapshot as unavailable while unrelated paths stay disk backed", () => {
    const store = createSurfaceSnapshotStore();
    const context = contextFor(store);
    expect(store.overlay(actor.sessionId, context, "unrelated", actor.workspaceId!)).toEqual({ status: "disk" });
    store.dropSession(actor.sessionId);
    expect(store.overlay(actor.sessionId, context, "src", actor.workspaceId!)).toMatchObject({ status: "unavailable" });
    expect(store.overlay(actor.sessionId, context, "unrelated", actor.workspaceId!)).toEqual({ status: "disk" });
    store.dispose();
  });

  it("uses the shared basename and path-containing glob semantics", async () => {
    const store = createSurfaceSnapshotStore();
    const context = contextFor(store);
    const host = { documentPathOverlay: (sessionId: string, input: AgentInputContext, root: string, workspaceId: string) => store.overlay(sessionId, input, root, workspaceId) };
    const service = createDocumentPathOverlayService(host);
    const base = {
      actor,
      authorizedPaths: [{ authorityId: "host", workspaceId: "workspace", canonicalResourceId: ".", inputPath: ".", resourceId: "" }],
      sessionId: actor.sessionId,
      workspaceId: actor.workspaceId,
      signal: new AbortController().signal,
      inputContext: context,
    };
    const basename = await service.handle({ path: ".", pattern: "*.ts" }, base);
    if (basename.status !== "ready") throw new Error("expected basename overlay");
    expect(basename.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(expect.arrayContaining(["new.ts", "src/deep/new.ts"]));
    const contained = await service.handle({ path: ".", pattern: "src/**/*.ts" }, base);
    if (contained.status !== "ready") throw new Error("expected contained overlay");
    expect(contained.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(["src/deep/new.ts"]);
    const nestedContained = await service.handle({ path: "src", pattern: "src/**/*.ts" }, {
      ...base,
      authorizedPaths: [{ ...base.authorizedPaths[0]!, resourceId: "src" }],
    });
    if (nestedContained.status !== "ready") throw new Error("expected nested contained overlay");
    expect(nestedContained.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual(["deep/new.ts"]);
    const literalSpaces = await service.handle({ path: "src", pattern: " spaced .space" }, {
      ...base,
      authorizedPaths: [{ ...base.authorizedPaths[0]!, resourceId: "src" }],
    });
    if (literalSpaces.status !== "ready") throw new Error("expected spaced path overlay");
    expect(literalSpaces.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual([" spaced .space"]);
    store.dispose();
  });
});
