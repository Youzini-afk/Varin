import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from "./kernel-client.js";
import type { NativeProcessIdentity } from "./process-service.js";
import type { KernelComputeGrammarParams, KernelComputeObject } from "./protocol.generated.js";
import { runKernelCompute, type KernelComputeInput, type KernelComputeOptions, type KernelComputeResult } from "./compute-runner.js";

export interface KernelComputeText { path: string; revision: string; text?: string; missing?: boolean }
export interface KernelComputeServiceOptions {
  client: KernelClient;
  resolveIdentity(cwd: string): Promise<NativeProcessIdentity>;
}
export type DirectoryComputeInput = Omit<KernelComputeInput, "workspaceId" | "rootId" | "pinId" | "objects">;
export type TextComputeInput = Omit<KernelComputeInput, "workspaceId" | "rootId" | "pinId" | "objects">;
interface Context { client: KernelScopedClient; grant: KernelGrantHandle; workspaceId: string; rootId?: string; canonicalRoot?: string }
const relative = (value: string): string => {
  const raw = value.replaceAll("\\", "/");
  if (raw.startsWith("/") || raw.includes(":") || raw.includes("\0") || raw.split("/").includes("..")) throw new Error("Computation path escaped its admitted view");
  return raw.split("/").filter((part) => part && part !== ".").join("/");
};

/** Shared Host admission and short-lived record projection, not a second parser. */
export function createKernelComputeService(options: KernelComputeServiceOptions) {
  const contexts = new Map<string, Promise<Context>>();
  const operations = new Set<Promise<unknown>>();
  const lifecycle = new AbortController();
  let disposed = false;
  const unregister = options.client.subscribeExit((error) => lifecycle.abort(error));
  const track = <T>(work: Promise<T>): Promise<T> => {
    operations.add(work);
    void work.then(() => operations.delete(work), () => operations.delete(work));
    return work;
  };
  const signalFor = (signal?: AbortSignal): AbortSignal => signal
    ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
  const context = (identity: NativeProcessIdentity | { workspaceId: string }, scopes: readonly string[] = [""]): Promise<Context> => {
    if (disposed || !options.client.isReady) return Promise.reject(new Error("Native computation authority is unavailable"));
    const key = JSON.stringify([identity, scopes]);
    const existing = contexts.get(key);
    if (existing) return existing;
    const creating = (async (): Promise<Context> => {
      const grant = await options.client.issueGrant({
        grantId: "compute-host:" + randomUUID(), owningWorkspace: identity.workspaceId,
        executionWorkspace: "executionWorkspaceId" in identity ? identity.executionWorkspaceId : identity.workspaceId,
        capabilities: ["storage.read", "storage.write"], pathScopes: scopes.map(relative),
      });
      const client = options.client.scoped(grant);
      if (!("canonicalRoot" in identity)) return { client, grant, workspaceId: identity.workspaceId };
      try {
        const registered = await client.fileRootRegister({ workspaceId: identity.workspaceId, executionWorkspaceId: identity.executionWorkspaceId, canonicalRoot: identity.canonicalRoot });
        if (typeof registered.rootId !== "string") throw new Error("Native computation root registration returned no identity");
        return { client, grant, workspaceId: identity.workspaceId, rootId: registered.rootId, canonicalRoot: identity.canonicalRoot };
      } catch (error) {
        await options.client.revokeGrant(grant.grantId);
        throw error;
      }
    })();
    contexts.set(key, creating);
    void creating.catch(() => { if (contexts.get(key) === creating) contexts.delete(key); });
    return creating;
  };
  const withText = async <T>(client: KernelScopedClient, inputs: readonly KernelComputeText[], signal: AbortSignal,
    run: (objects: KernelComputeObject[]) => Promise<T>): Promise<T> => {
    const owners: Array<{ ownerId: string; operationId: string }> = [];
    try {
      const objects: KernelComputeObject[] = [];
      for (const input of inputs) {
        signal.throwIfAborted();
        const sourcePath = relative(input.path);
        if (input.missing) { objects.push({ path: sourcePath, revision: input.revision, missing: true }); continue; }
        if (input.text === undefined) throw new Error("Fixed input has no captured text; disk fallback is not permitted");
        const operationId = "compute-text:" + randomUUID();
        const object = await client.putBlob(Buffer.from(input.text, "utf8"), operationId, signal);
        owners.push({ ownerId: object.ownerId, operationId });
        objects.push({ path: sourcePath, revision: input.revision, objectHash: object.hash, ownerId: object.ownerId });
      }
      return await run(objects);
    } finally {
      for (const owner of owners) {
        await client.releaseBlob(owner.ownerId);
        await client.releaseOperation(owner.operationId);
      }
    }
  };
  let grammarGrant: Promise<KernelGrantHandle> | undefined;
  const grammarRecipes = new Map<string, Promise<string>>();
  return {
    async registerGrammar(recipe: KernelComputeGrammarParams): Promise<string> {
      lifecycle.signal.throwIfAborted();
      // The digest and queries identify an immutable recipe for this kernel
      // lifetime. A repository scan must not reread the same wasm per file.
      const key = JSON.stringify(recipe);
      const existing = grammarRecipes.get(key);
      if (existing) return existing;
      const registering = track((async () => {
        grammarGrant ??= options.client.issueGrant({ grantId: "compute-grammar:" + randomUUID(), capabilities: ["compute.grammar"], pathScopes: [] });
        const registered = await options.client.scoped(await grammarGrant).computeGrammarRegister(recipe);
        if (typeof registered.recipeId !== "string") throw new Error("Native grammar registration returned no recipe identity");
        return registered.recipeId;
      })());
      grammarRecipes.set(key, registering);
      void registering.catch(() => { if (grammarRecipes.get(key) === registering) grammarRecipes.delete(key); });
      return registering;
    },
    directory(cwd: string, input: DirectoryComputeInput, runOptions: KernelComputeOptions = {}, overlays: readonly KernelComputeText[] = []): Promise<KernelComputeResult> {
      return track((async () => {
        const signal = signalFor(runOptions.signal);
        signal.throwIfAborted();
        const canonicalCwd = await canonicalizePathIdentity(cwd);
        const resolvedIdentity = await options.resolveIdentity(cwd);
        const identity = {
          ...resolvedIdentity,
          canonicalRoot: await canonicalizePathIdentity(resolvedIdentity.canonicalRoot),
        };
        // Admission and the selected directory may spell the same location
        // differently (Windows 8.3 names, junctions or symlinks). Compute the
        // granted relative scope from filesystem identities, as process launch
        // does, and reject an escaping alias before creating a context.
        const base = relative(path.relative(identity.canonicalRoot, canonicalCwd));
        signal.throwIfAborted();
        const admitted = await context(identity);
        const join = (value: string) => [base, relative(value)].filter(Boolean).join("/");
        const params: KernelComputeInput = {
          ...input, workspaceId: identity.workspaceId, rootId: admitted.rootId!,
          paths: (input.paths ?? [""]).map(join),
          ...(input.excludePaths ? { excludePaths: input.excludePaths.map(join) } : {}),
          ...(input.files ? { files: input.files.map((file) => ({ ...file, path: join(file.path) })) } : {}),
        };
        const rebase = (record: import("./protocol.generated.js").KernelComputeRecord) => ({
          ...record, path: base && record.path.startsWith(base + "/") ? record.path.slice(base.length + 1) : record.path === base ? "" : record.path,
        });
        const execute = (objects?: KernelComputeObject[]) => runKernelCompute(admitted.client,
          { ...params, ...(objects ? { objects } : {}) }, { ...runOptions, signal,
            ...(runOptions.onRecords ? { onRecords: (records) => runOptions.onRecords!(records.map(rebase)) } : {}),
          });
        const result = overlays.length
          ? await withText(admitted.client, overlays.map((entry) => ({ ...entry, path: join(entry.path) })), signal, execute)
          : await execute();
        return { ...result, records: result.records.map(rebase) };
      })());
    },
    text(workspaceId: string, inputs: readonly KernelComputeText[], input: TextComputeInput, runOptions: KernelComputeOptions = {}): Promise<KernelComputeResult> {
      return track((async () => {
        const signal = signalFor(runOptions.signal);
        const admitted = await context({ workspaceId });
        return withText(admitted.client, inputs, signal, (objects) => runKernelCompute(admitted.client,
          { ...input, workspaceId, objects }, { ...runOptions, signal }));
      })());
    },
    async dispose(): Promise<void> {
      disposed = true;
      lifecycle.abort(new DOMException("Native computation service disposed", "AbortError"));
      await Promise.allSettled([...operations]);
      grammarRecipes.clear();
      unregister();
      if (!options.client.isReady) return;
      await Promise.all([...contexts.values()].map(async (pending) => options.client.revokeGrant((await pending).grant.grantId)));
      if (grammarGrant) await options.client.revokeGrant((await grammarGrant).grantId);
      contexts.clear();
    },
  };
}
export type KernelComputeService = ReturnType<typeof createKernelComputeService>;
