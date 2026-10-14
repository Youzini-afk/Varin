import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MaterialsCollectionParams } from "@varin/protocol";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import type { MaterialCollectionContext } from "./material-collections.js";
import type { ThreadMaterialAuthority } from "./web-materials.js";
import { createMaterialCollections, MATERIAL_COLLECTION_RECORD_TYPE } from "./material-collections.js";
import { createWebMaterialStore } from "./web-materials.js";
import { createMaterialLifecycle } from "./material-lifecycle.js";

type TestRecord = {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  threadId?: string;
  recordRevision: number;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

const openStore = () => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, TestRecord>();
  const store = {
    async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      return { hash, byteLength: bytes.byteLength };
    },
    async getObject(hash: string): Promise<Buffer | null> {
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes) : null;
    },
  };
  const context = {
    records: {
      async get(recordId: string): Promise<TestRecord | null> {
        return records.get(recordId) ?? null;
      },
      async list(input: { recordType?: string }): Promise<TestRecord[]> {
        return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType);
      },
      async put(input: Omit<TestRecord, "recordRevision" | "workspaceId"> & { workspaceId?: string; operationId: string; expectedRecordRevision?: number }): Promise<TestRecord> {
        const existing = records.get(input.recordId);
        if (existing && input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== existing.recordRevision) {
          throw new Error("record revision conflict");
        }
        const record = { ...input, workspaceId: input.workspaceId ?? "ws", recordRevision: (existing?.recordRevision ?? 0) + 1, references: [...(input.references ?? [])] };
        records.set(record.recordId, record);
        return record;
      },
      async release(_operationId: string, recordId: string): Promise<Record<string, unknown>> {
        const released = records.delete(recordId);
        return { recordId, released };
      },
    },
  };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (_workspaceId, _purpose, operation) => operation(
      store as unknown as WorkingStateRootStore,
      context as unknown as WorkingStateRootContext,
    ),
  };
  return {
    records,
    objects,
    materials: createWebMaterialStore(workingStates),
    lifecycle: createMaterialLifecycle(workingStates),
    workingStates,
  };
};

const ctx = (threadId: string, extra: Partial<MaterialCollectionContext> = {}): MaterialCollectionContext => ({
  authority: { kind: "thread", owningWorkspaceId: "ws", threadId },
  threadsRelated: async () => true,
  ...extra,
});
const call = async (
  service: ReturnType<typeof createMaterialCollections>, params: MaterialsCollectionParams,
  threadId: string, extra?: Partial<MaterialCollectionContext>,
) => (await service.execute(params, ctx(threadId, extra))).result;

describe("material collections", () => {
  it("creates, adds members, lists, and keyword-searches within the collection scope", async () => {
    const opened = openStore();
    const authority: ThreadMaterialAuthority = { kind: "thread", owningWorkspaceId: "ws", threadId: "t1" };
    const snapA = await opened.materials.put("ws", {
      sourceUrl: "https://a.test/", finalUrl: "https://a.test/", representation: "raw-text",
    }, Buffer.from("alpha body\ncontains retrieval keyword\nmore alpha"), authority);
    const snapB = await opened.materials.put("ws", {
      sourceUrl: "https://b.test/", finalUrl: "https://b.test/", representation: "raw-text",
    }, Buffer.from("beta body without the term"), authority);

    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });

    const created = await call(service, { action: "create", name: "paper-set" }, "t1");
    expect(created.status).toBe("ok");
    const collectionId = created.collection!.collectionId;

    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: snapA.snapshotId } }, "t1");
    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: snapB.snapshotId } }, "t1");
    await call(service, { action: "add", collectionId, member: { kind: "paper", paper: { provider: "openalex", id: "W1", doi: "10.1/x" }, role: "main" } }, "t1");

    const listed = await call(service, { action: "list" }, "t1");
    expect(listed.collections).toEqual([
      expect.objectContaining({ collectionId, memberCount: 3, persisted: false }),
    ]);

    const searched = await call(service, { action: "search", collectionId, query: "retrieval" }, "t1");
    expect(searched.status).toBe("ok");
    // Scope applies before recall: only member bodies are scanned.
    expect(searched.hits).toEqual([
      expect.objectContaining({ snapshotId: snapA.snapshotId, line: 2 }),
    ]);
  });

  it("denies foreign-authority writes and reports unreadable members", async () => {
    const opened = openStore();
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });
    const created = await call(service, { action: "create" }, "t1");
    const collectionId = created.collection!.collectionId;

    // A different thread cannot mutate or search this collection.
    const denied = await call(service, {
      action: "add", collectionId, member: { kind: "paper", paper: { provider: "openalex", id: "W9" } },
    }, "t2");
    expect(denied.status).toBe("denied");
    const deniedSearch = await call(service, { action: "search", collectionId, query: "x" }, "t2");
    expect(deniedSearch.status).toBe("not-found");

    // A snapshot owned by another thread is not readable under this authority.
    const foreignSnap = await opened.materials.put("ws", {
      sourceUrl: "https://f.test/", finalUrl: "https://f.test/", representation: "raw-text",
    }, Buffer.from("foreign body"), { kind: "thread", owningWorkspaceId: "ws", threadId: "t2" });
    const addForeign = await call(service, {
      action: "add", collectionId, member: { kind: "snapshot", snapshotId: foreignSnap.snapshotId },
    }, "t1");
    expect(addForeign.status).toBe("denied");
  });

  it("fetches and pins url members through the wired fetch path", async () => {
    const opened = openStore();
    const fetched: string[] = [];
    const service = createMaterialCollections(opened.workingStates, { materials: opened.materials });
    const fetchUrl: MaterialCollectionContext["fetchUrl"] = async (params) => {
      fetched.push(params.url);
      const ref = await opened.materials.put("ws", {
        sourceUrl: params.url, finalUrl: params.url, representation: "raw-text",
      }, Buffer.from("fetched body"), ctx("t1").authority);
      return { status: "ok", snapshot: ref, finalUrl: params.url };
    };
    const created = await call(service, { action: "create" }, "t1");
    const collectionId = created.collection!.collectionId;
    const added = await call(service, {
      action: "add", collectionId, member: { kind: "url", url: "https://paper.test/full" },
    }, "t1", { fetchUrl });
    expect(added.status).toBe("ok");
    expect(fetched).toEqual(["https://paper.test/full"]);
    expect(added.member?.snapshotId).toBeDefined();
  });

  it("keeps persisted collections across thread release while temporary ones follow it", async () => {
    const opened = openStore();
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });
    const kept = await call(service, { action: "create", persist: true }, "t1");
    const temp = await call(service, { action: "create" }, "t1");

    await opened.lifecycle.releaseThreadMaterials("ws", "t1");

    const records = [...opened.records.values()].filter((r) => r.recordType === MATERIAL_COLLECTION_RECORD_TYPE);
    expect(records.map((r) => r.recordId)).toEqual([`material.collection:${kept.collection!.collectionId}`]);
    // Persisted collections are readable workspace-wide.
    const found = await call(service, { action: "list" }, "other-thread");
    expect(found.collections).toEqual([
      expect.objectContaining({ collectionId: kept.collection!.collectionId, persisted: true }),
    ]);
    expect(temp.collection).toBeDefined();
  });

  it("lets another thread read persisted collection members while the collection retains them", async () => {
    const opened = openStore();
    const snap = await opened.materials.put("ws", {
      sourceUrl: "https://persisted.test/", finalUrl: "https://persisted.test/", representation: "raw-text",
    }, Buffer.from("persisted body"), { kind: "thread", owningWorkspaceId: "ws", threadId: "t1" });
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });
    const created = await call(service, { action: "create", persist: true }, "t1");
    await call(service, {
      action: "add", collectionId: created.collection!.collectionId,
      member: { kind: "snapshot", snapshotId: snap.snapshotId },
    }, "t1");
    const read = await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t2",
    });
    expect(read?.body.toString()).toBe("persisted body");
    expect((await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "native-reader",
    }))?.body.toString()).toBe("persisted body");
    const searched = await call(service, { action: "search", collectionId: created.collection!.collectionId, query: "persisted" }, "t2");
    expect(searched.hits).toHaveLength(1);
  });

  it("keeps member snapshot bodies alive through collection references", async () => {
    const opened = openStore();
    const authority: ThreadMaterialAuthority = { kind: "thread", owningWorkspaceId: "ws", threadId: "t1" };
    const snap = await opened.materials.put("ws", {
      sourceUrl: "https://a.test/", finalUrl: "https://a.test/", representation: "raw-text",
    }, Buffer.from("kept body"), authority);
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });
    const created = await call(service, { action: "create" }, "t1");
    await call(service, {
      action: "add", collectionId: created.collection!.collectionId,
      member: { kind: "snapshot", snapshotId: snap.snapshotId },
    }, "t1");
    const record = opened.records.get(`material.collection:${created.collection!.collectionId}`);
    expect(record?.references.some((reference) => reference.objectHash === snap.contentHash)).toBe(true);
  });
});


describe("material grants (L4)", () => {
  const serviceFor = (opened: ReturnType<typeof openStore>) =>
    createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
    });

  const snapFor = (opened: ReturnType<typeof openStore>, threadId = "t1") =>
    opened.materials.put("ws", {
      sourceUrl: "https://a.test/", finalUrl: "https://a.test/", representation: "raw-text",
    }, Buffer.from("grant body"), { kind: "thread", owningWorkspaceId: "ws", threadId });

  it("grants a related thread read access under its own authority", async () => {
    const opened = openStore();
    const service = serviceFor(opened);
    const snap = await snapFor(opened);

    const shared = await call(service, { action: "share", snapshotId: snap.snapshotId, targetThreadId: "t2" }, "t1");
    expect(shared.status).toBe("ok");
    expect(shared.grant).toMatchObject({ fromThreadId: "t1", toThreadId: "t2", snapshotIds: [snap.snapshotId] });

    // Receiver reads the same body under its own authority — no receipt transfer.
    const read = await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t2",
    });
    expect(read?.body.toString()).toBe("grant body");
    expect((await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t2",
    }))?.body.toString()).toBe("grant body");
    // A thread outside the grant still cannot read it.
    expect(await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t3",
    })).toBeNull();
  });

  it("denies grants to unrelated threads and over unreadable snapshots", async () => {
    const opened = openStore();
    const unrelated = serviceFor(opened);
    const snap = await snapFor(opened);
    const denied = await call(unrelated, { action: "share", snapshotId: snap.snapshotId, targetThreadId: "t2" }, "t1", { threadsRelated: async () => false });
    expect(denied.status).toBe("denied");

    // Sender cannot read the snapshot itself → no grant.
    const foreignSnap = await opened.materials.put("ws", {
      sourceUrl: "https://f.test/", finalUrl: "https://f.test/", representation: "raw-text",
    }, Buffer.from("foreign"), { kind: "thread", owningWorkspaceId: "ws", threadId: "t2" });
    const service = serviceFor(opened);
    const noRead = await call(service, { action: "share", snapshotId: foreignSnap.snapshotId, targetThreadId: "t2" }, "t1");
    expect(noRead.status).toBe("denied");
  });

  it("share is idempotent and the grant dies with the granting thread", async () => {
    const opened = openStore();
    const service = serviceFor(opened);
    const snap = await snapFor(opened);

    const first = await call(service, { action: "share", snapshotId: snap.snapshotId, targetThreadId: "t2" }, "t1");
    const second = await call(service, { action: "share", snapshotId: snap.snapshotId, targetThreadId: "t2" }, "t1");
    expect(second.grant?.grantId).toBe(first.grant?.grantId);
    expect([...opened.records.values()].filter((r) => r.recordType === "material.grant")).toHaveLength(1);

    await opened.lifecycle.releaseThreadMaterials("ws", "t1");
    expect(await opened.materials.read("ws", snap.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t2",
    })).toBeNull();
  });

  it("shares a whole collection so the receiver can list and search it", async () => {
    const opened = openStore();
    const service = serviceFor(opened);
    const snap = await snapFor(opened);
    const created = await call(service, { action: "create", name: "shared-set" }, "t1");
    const collectionId = created.collection!.collectionId;
    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: snap.snapshotId } }, "t1");

    const shared = await call(service, { action: "share", collectionId, targetThreadId: "t2" }, "t1");
    expect(shared.status).toBe("ok");

    const listed = await call(service, { action: "list" }, "t2");
    expect(listed.collections).toEqual([expect.objectContaining({ collectionId })]);
    const searched = await call(service, { action: "search", collectionId, query: "grant" }, "t2");
    expect(searched.status).toBe("ok");
    expect(searched.hits?.length).toBe(1);
    // The receiver still cannot mutate the sender's collection.
    const deniedWrite = await call(service, {
      action: "add", collectionId, member: { kind: "paper", paper: { provider: "openalex", id: "W1" } },
    }, "t2");
    expect(deniedWrite.status).toBe("denied");
  });

  it("keeps a live collection grant in sync with later member additions", async () => {
    const opened = openStore();
    const service = serviceFor(opened);
    const first = await snapFor(opened);
    const second = await opened.materials.put("ws", {
      sourceUrl: "https://b.test/", finalUrl: "https://b.test/", representation: "raw-text",
    }, Buffer.from("second member"), { kind: "thread", owningWorkspaceId: "ws", threadId: "t1" });
    const created = await call(service, { action: "create", name: "live-set" }, "t1");
    const collectionId = created.collection!.collectionId;
    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: first.snapshotId } }, "t1");
    await call(service, { action: "share", collectionId, targetThreadId: "t2" }, "t1");
    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: second.snapshotId } }, "t1");
    const read = await opened.materials.read("ws", second.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "t2",
    });
    expect(read?.body.toString()).toBe("second member");
  });
});
