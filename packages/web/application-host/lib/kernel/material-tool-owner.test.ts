import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApplicationExtensionRuntime, type HostCapabilityHandler, type HostInvocationScope } from "@varin/extension-host";
import { parseVarinExtensionManifest, type JsonValue } from "@varin/extension-contract";
import { createMaterialStoreFixture } from "../harness/web-materials.test-helper.js";
import { createMaterialCollections } from "../harness/material-collections.js";
import { createMaterialToolOwner, MATERIAL_SNAPSHOT_CAPABILITY, type MaterialSnapshotReadResult } from "./material-tool-owner.js";
import { withToolInvocation, type ToolInvocationAuthority } from "./tool-invocation.js";

const owner = { extensionId: "example.materials", extensionVersion: "1.0.0", entrypointId: "host", generation: 1 };
const authority = (policy = false): ToolInvocationAuthority => ({
  invocationId: "invocation",
  toolName: "material_snapshot_read",
  operation: "read",
  arguments: {},
  runId: "run",
  threadId: "thread",
  operationId: policy ? "action:node:node" : "request:tool:call",
  origin: policy ? { kind: "policy_action", action_id: "action", node_id: "node" } : { kind: "model_step", request_id: "request" },
  source: { workspace_id: "ws", execution_workspace_id: "execution-other", branch_id: "branch", revision: 1,
    mode: "fixed_branch", live_root: null },
});

// These are explicit Host fixture scopes. They exercise the shared opaque-scope
// boundary but do not claim that a real kernel Run admitted this call.
const invoke = (handler: HostCapabilityHandler, input: JsonValue, options: {
  authority?: ToolInvocationAuthority;
  signal?: AbortSignal;
} = {}): Promise<MaterialSnapshotReadResult> => {
  const signal = options.signal ?? new AbortController().signal;
  return withToolInvocation({ authority: options.authority ?? authority(), owner, signal }, async invocation => (
    await handler("read", input, { owner, signal, invocation }) as MaterialSnapshotReadResult
  ));
};

const put = (opened: ReturnType<typeof createMaterialStoreFixture>, body: string | Buffer) => opened.materials.put("ws", {
  sourceUrl: "https://example.com/material", finalUrl: "https://example.com/material", representation: "raw-text",
}, Buffer.from(body), { owningWorkspaceId: "ws", sessionId: "pi-source", threadId: "thread", runId: "old-run" });

describe("material snapshot capability", () => {
  it("installs the real SDK example and reads owned or granted material through its exact broker pin", async () => {
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-material-sdk-"));
    let runtime: ApplicationExtensionRuntime | undefined;
    try {
      const exampleSource = path.join(repository, "examples/extensions/material-snapshot-tool");
      const example = path.join(root, "example");
      await fs.mkdir(example);
      for (const file of ["package.json", "varin.extension.json"]) await fs.copyFile(path.join(exampleSource, file), path.join(example, file));
      const manifest = parseVarinExtensionManifest(JSON.parse(await fs.readFile(path.join(example, "varin.extension.json"), "utf8")));
      const descriptor = manifest.provides!.services![0]!;
      const { build } = createRequire(path.join(repository, "packages/extension-builtins/package.json"))("esbuild");
      await build({ entryPoints: [path.join(exampleSource, "host.ts")], bundle: true, platform: "node", format: "cjs",
        outfile: path.join(example, "host.cjs"), alias: { "@varin/extension-sdk": path.join(repository, "packages/extension-sdk/dist/index.js") } });
      const opened = createMaterialStoreFixture();
      const ref = await put(opened, "Aé🙂中B");
      const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
      runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, "extensions"), varinVersion: buildVersion,
        brokerScript: path.join(repository, "packages/extension-host/broker/broker-child.mjs") });
      runtime.capabilities.register(MATERIAL_SNAPSHOT_CAPABILITY, createMaterialToolOwner(opened.materials));
      await runtime.start();
      await runtime.installOrStage({ source: { kind: "local", display: manifest.displayName!, specifier: example },
        expectedRevision: (await runtime.catalog.snapshot()).revision });
      await runtime.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await runtime.catalog.snapshot()).revision,
        decisions: [{ capability: MATERIAL_SNAPSHOT_CAPABILITY, realm: "host", granted: true }] });
      await runtime.setEnabled(manifest.id, true, (await runtime.catalog.snapshot()).revision);
      const binding = await runtime.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: "execute", args: [],
        routing: { sessionId: "thread" } });
      const provider = runtime.services.getSnapshot().providers.find(value => value.providerId === binding.providerId);
      if (!provider) throw new Error("The installed material example did not publish its provider");
      const pin = binding.pin();
      try {
        expect(binding.descriptor).toEqual(descriptor);
        expect(await pin.invoke("inspect", [])).toEqual(descriptor);
        const call = (threadId: string, policy = false, offset = 0) => {
          const signal = new AbortController().signal;
          // The original pin promise owns this scope until the real SDK callback
          // completes. A reader-cancellation race must not retire it early.
          return withToolInvocation({ owner: provider, signal,
            authority: { ...authority(policy), threadId, runId: `run:${threadId}` } }, invocation => pin.invoke("execute", [{
              snapshotId: ref.snapshotId, offset, maxBytes: 4, expectedContentHash: ref.contentHash,
            }], signal, invocation));
        };
        expect(await call("thread")).toMatchObject({ status: "ok", text: "Aé", nextOffset: 3, contentHash: ref.contentHash });
        expect(await call("receiver", true)).toMatchObject({ status: "unavailable" });
        const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials,
          resolveThreadId: async sessionId => sessionId === "pi-source" ? "thread" : undefined,
          threadsRelated: async (from, to) => from === "thread" && to === "receiver" });
        const shared = await collections.handle({ action: "share", snapshotId: ref.snapshotId, targetThreadId: "receiver" }, {
          sessionId: "pi-source", workspaceId: "ws", authorizedPaths: [], signal: new AbortController().signal,
          actor: { authorityInstanceId: "material-test", workerId: "worker", workerGeneration: 1,
            sessionId: "pi-source", workspaceId: "ws", grantedCapabilities: ["read.web"] },
        });
        expect(shared.status).toBe("ok");
        expect(await call("receiver", true, 3)).toMatchObject({ status: "ok", text: "🙂", nextOffset: 7, contentHash: ref.contentHash });
        await expect(pin.invoke("execute", [{ snapshotId: ref.snapshotId, offset: 0, maxBytes: 4 }])).rejects.toThrow("tool_invocation_unavailable");
      } finally { pin.release(); }
    } finally {
      try { await runtime?.stop(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  });

  it("reads the same fixed snapshot for model and policy calls with lossless UTF-8 byte cursors", async () => {
    const opened = createMaterialStoreFixture();
    const text = "Aé🙂中B";
    const ref = await put(opened, text);
    const handler = createMaterialToolOwner(opened.materials);
    for (const policy of [false, true]) {
      const pages: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await invoke(handler, { snapshotId: ref.snapshotId, offset, maxBytes: 4, expectedContentHash: ref.contentHash }, { authority: authority(policy) });
        if (page.status !== "ok") throw new Error(`Unexpected page: ${JSON.stringify(page)}`);
        expect(page).toMatchObject({ snapshotId: ref.snapshotId, revision: ref.contentHash, contentHash: ref.contentHash,
          totalBytes: Buffer.byteLength(text), range: { offset, byteLength: Buffer.byteLength(page.text) } });
        expect(page.range.byteLength).toBeLessThanOrEqual(4);
        pages.push(page.text);
        if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(pages).toEqual(["Aé", "🙂", "中B"]);
      expect(pages.join("")).toBe(text);
    }
    const bom = await put(opened, "\uFEFFx");
    expect(await invoke(handler, { snapshotId: bom.snapshotId, offset: 0, maxBytes: 4 })).toMatchObject({ text: "\uFEFFx", range: { byteLength: 4 } });
  });

  it("distinguishes unavailable, revision conflict, invalid ranges, empty material and corrupt bytes", async () => {
    const opened = createMaterialStoreFixture();
    const ref = await put(opened, "a🙂b");
    const handler = createMaterialToolOwner(opened.materials);
    const input = { snapshotId: ref.snapshotId, offset: 0, maxBytes: 6 };
    const foreign = await invoke(handler, input, { authority: { ...authority(), threadId: "foreign" } });
    const missing = await invoke(handler, { ...input, snapshotId: "missing" });
    expect(foreign).toMatchObject({ status: "unavailable", message: "Snapshot is missing, released, or not authorized for this Thread" });
    expect(missing).toMatchObject({ status: "unavailable", message: foreign.status === "unavailable" ? foreign.message : "" });
    expect(await invoke(handler, { ...input, expectedContentHash: `sha256-${"0".repeat(64)}` })).toMatchObject({ status: "conflict" });
    for (const range of [{ offset: 7, maxBytes: 1 }, { offset: 2, maxBytes: 4 }, { offset: 1, maxBytes: 1 }]) {
      expect(await invoke(handler, { ...input, ...range })).toMatchObject({ status: "invalid-range" });
    }
    expect(await invoke(handler, { ...input, offset: 6 })).toMatchObject({ status: "ok", text: "", nextOffset: null, range: { offset: 6, byteLength: 0 } });
    const empty = await put(opened, "");
    expect(await invoke(handler, { ...input, snapshotId: empty.snapshotId })).toMatchObject({ status: "empty", totalBytes: 0, text: "", nextOffset: null });
    const malformed = await put(opened, Buffer.from([0xff]));
    expect(await invoke(handler, { ...input, snapshotId: malformed.snapshotId })).toMatchObject({ status: "corrupt" });
    opened.objects.set(ref.contentHash, Buffer.from("abcdef"));
    expect(await invoke(handler, input)).toMatchObject({ status: "corrupt" });
    const record = opened.records.get(`web.snapshot:${empty.snapshotId}`)!;
    record.payloadJson = "{}";
    expect(await invoke(handler, { ...input, snapshotId: empty.snapshotId })).toMatchObject({ status: "corrupt" });
  });

  it("requires an active Host scope and source, and cannot take authority from tool parameters", async () => {
    const opened = createMaterialStoreFixture();
    const ref = await put(opened, "private content");
    const handler = createMaterialToolOwner(opened.materials);
    const input = { snapshotId: ref.snapshotId, offset: 0, maxBytes: 100 };
    const signal = new AbortController().signal;
    await expect(handler("read", input, { owner, signal })).rejects.toThrow("tool_invocation_unavailable");
    await expect(invoke(handler, input, { authority: { ...authority(), source: null } })).rejects.toThrow("source workspace");
    await expect(invoke(handler, { ...input, threadId: "thread" })).rejects.toThrow("Unknown material snapshot read field");
    await expect(invoke(handler, { ...input, maxBytes: 0 })).rejects.toThrow("positive safe integer");
    let stale: HostInvocationScope | undefined;
    await withToolInvocation({ authority: authority(), owner, signal }, async invocation => {
      stale = invocation;
      await expect(handler("read", input, { owner: { ...owner, generation: 2 }, signal, invocation })).rejects.toThrow("tool_invocation_unavailable");
    });
    await expect(handler("read", input, { owner, signal, invocation: stale! })).rejects.toThrow("tool_invocation_unavailable");
  });

  it("rejects cancelled or failed reads without publishing late content or a successful empty result", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const opened = createMaterialStoreFixture({ beforeObjectRead: async () => { started(); await blocked; } });
    const ref = await put(opened, "late content");
    const handler = createMaterialToolOwner(opened.materials);
    const input = { snapshotId: ref.snapshotId, offset: 0, maxBytes: 100 };
    const controller = new AbortController();
    const pending = invoke(handler, input, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("reader cancelled");
    await reading;
    controller.abort(new Error("reader cancelled"));
    release();
    await rejected;
    await expect(invoke(handler, input, { signal: controller.signal })).rejects.toThrow("reader cancelled");

    const failed = createMaterialStoreFixture({ client: { getBlob: async () => { throw new Error("kernel connection lost"); } } });
    const failedRef = await put(failed, "stored content");
    await expect(invoke(createMaterialToolOwner(failed.materials), { ...input, snapshotId: failedRef.snapshotId })).rejects.toThrow("kernel connection lost");
  });

  it("cannot return delayed bytes after a caller finishes without awaiting its capability", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const opened = createMaterialStoreFixture({ beforeObjectRead: async () => { started(); await blocked; } });
    const ref = await put(opened, "retired invocation content");
    const handler = createMaterialToolOwner(opened.materials);
    const signal = new AbortController().signal;
    let pending!: Promise<JsonValue>;
    await withToolInvocation({ authority: authority(), owner, signal }, async invocation => {
      pending = Promise.resolve(handler("read", { snapshotId: ref.snapshotId, offset: 0, maxBytes: 100 }, { owner, signal, invocation }));
      await reading;
      // Return deliberately without awaiting the nested material read.
    });
    const rejected = expect(pending).rejects.toThrow("tool_invocation_unavailable");
    release();
    await rejected;
  });
});
