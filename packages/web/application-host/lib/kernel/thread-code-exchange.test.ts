import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createRecoveryJournalFixture } from "../recovery/journal-fixture.test-helper.js";
import {
  applyDurableFileOperation,
  finalizeDurableExternalOperation,
  markDurableExternalDispatched,
  type DurableFileOperationContext,
  type IntegrationOperationBinding,
} from "../recovery/durable-file-operation.js";
import {
  readExchangeJournal,
  createManagedCodeExchangeReader,
} from "./thread-code-exchange.js";

it("reads the versions retained by the original integration writer and keeps sender and operation scope on local and managed reads", async () => {
  const journal = createRecoveryJournalFixture();
  const objects = new Map<string, Buffer>();
  const state = (text: string) => {
    const bytes = Buffer.from(text);
    const objectHash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    objects.set(objectHash, bytes);
    return {
      kind: "regular-file" as const,
      objectHash,
      byteLength: bytes.length,
    };
  };
  const before = state("旧版本\nconst page = 1;\n"),
    after = state("新版本\nconst page = cursor;\n");
  const files = {
    readContent: vi.fn(
      async (_identity, content) => objects.get(content.objectHash)!,
    ),
  };
  const unexpectedPhysicalRead = async (): Promise<never> => {
    throw new Error("Historical exchange must not inspect current files");
  };
  const context: DurableFileOperationContext = {
    identity: {
      authorityId: "host",
      workspaceId: "workspace",
      canonicalRoot: "/original",
      filesystemProfile: "test",
    },
    root: "/objects",
    durableRecoveryStore: journal,
    resourceOperationGate: {
      run: async (_resources, operation) => operation(),
    },
    fileStore: {
      applyState: unexpectedPhysicalRead,
      captureState: unexpectedPhysicalRead,
      hashFile: unexpectedPhysicalRead,
      relativePathFor: () => {
        throw new Error("No live path read");
      },
      verifyObject: unexpectedPhysicalRead,
    },
  };
  const binding: IntegrationOperationBinding = {
    kind: "code_exchange",
    operationId: "exchange",
    parentRunId: "run",
    parentThreadId: "sender",
    parentBranchId: "sender-branch",
    childThreadId: "source",
    sourceRunId: "source-run",
    targetRunId: "target-run",
    targetThreadId: "target",
    callId: "call",
    origin: { kind: "model_step", request_id: "request" },
    result: {
      workspaceId: "workspace",
      branchId: "fixed",
      resultRevision: 2,
      root: "fixed-root",
      publicationId: "publication",
    },
    target: {
      mode: "live_root",
      resource_owner: { kind: "local" },
      workspace_id: "workspace",
      execution_workspace_id: "workspace",
      branch_id: null,
      revision: null,
      live_root: { hostId: "host", rootId: "root", canonicalRoot: "/original" },
    },
  };
  await applyDurableFileOperation(context, {
    id: "integration:exchange",
    workspaceId: "workspace",
    threadId: "source",
    resultRevision: 2,
    targets: {},
    externalTargets: { "search.ts": { expected: before, target: after } },
    operationBinding: binding,
    externalBindings: {
      "search.ts": {
        ownerId: "editor",
        ownerGeneration: 1,
        ownerRegistrationId: "registration",
        documentInstanceId: "document",
        baseRevision: "disk",
        beforeLocalEditRevision: 1,
        beforeHash: before.objectHash,
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
      },
    },
    conflictPaths: [],
    diffStats: { files: 1, insertions: 2, deletions: 2 },
  });
  await markDurableExternalDispatched(context, "integration:exchange", [
    "search.ts",
  ]);
  await finalizeDurableExternalOperation(context, {
    operationId: "integration:exchange",
    results: { "search.ts": "applied" },
    receipts: {
      "search.ts": { afterLocalEditRevision: 2, afterHash: after.objectHash },
    },
    executorStopped: true,
  });
  const input = {
    workspaceId: "workspace",
    operationId: "exchange",
    threadId: "sender",
    runId: "run",
  };
  const overview = await readExchangeJournal({ journal, files }, input);
  expect(overview.files).toEqual([
    { path: "search.ts", state: "applied", target: "surface" },
  ]);
  expect(files.readContent).not.toHaveBeenCalled();
  state("later work changed the file again");
  const versions = await readExchangeJournal(
    { journal, files },
    { ...input, path: "search.ts" },
  );
  expect(versions.file).toEqual({
    path: "search.ts",
    before: { kind: "text", text: "旧版本\nconst page = 1;\n" },
    after: { kind: "text", text: "新版本\nconst page = cursor;\n" },
  });
  await expect(
    readExchangeJournal({ journal, files }, { ...input, threadId: "another" }),
  ).rejects.toThrow("original sender");
  await expect(
    readExchangeJournal({ journal, files }, { ...input, path: "../another" }),
  ).rejects.toThrow("original file versions");
  const managed = createManagedCodeExchangeReader({ journal, files });
  const request = {
    coordinatorHostId: "coordinator",
    source: binding.target,
    threadId: "sender",
    runId: "run",
    operationId: "exchange",
    path: "search.ts",
  };
  expect(await managed(request)).toEqual(versions);
  await expect(managed({ ...request, threadId: "another" })).rejects.toThrow(
    "original sender",
  );
});
