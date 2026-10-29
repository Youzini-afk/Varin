/** Collections and explicit shares over the original material record owner. */
import { createHash, randomUUID } from "node:crypto";
import type {
  MaterialCollection, MaterialCollectionMember, MaterialCollectionSearchHit, MaterialCollectionSummary,
  MaterialGrant, MaterialsCollectionParams, MaterialsCollectionResult, WebSnapshotRef,
} from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createWorkspaceOpSerializer, kernelContext, type KernelRecordContext } from "./kernel-records.js";
import type { WebMaterialStore, WebSnapshotReadAuthority } from "./web-materials.js";

export const MATERIAL_COLLECTION_RECORD_TYPE = "material.collection";
export const MATERIAL_GRANT_RECORD_TYPE = "material.grant";
type Record = NonNullable<Awaited<ReturnType<KernelRecordContext["records"]["get"]>>>;
interface MutationIdentity { origin: string; inputHash: string; memberId?: string; effect: "none" | "confirmed" }
interface CollectionPayload extends MaterialCollection { lastMutation?: MutationIdentity }
interface GrantPayload extends MaterialGrant { lastMutation?: MutationIdentity }
type FetchUrl = (params: { url: string }) => Promise<{ status: string; snapshot?: WebSnapshotRef; finalUrl?: string; title?: string }>;
export interface MaterialCollectionContext {
  authority: WebSnapshotReadAuthority;
  signal?: AbortSignal;
  /** Host-created original invocation identity, never a tool argument. */
  origin?: string;
  fetchUrl?: FetchUrl;
  threadsRelated?: (fromThreadId: string, toThreadId: string, workspaceId: string) => Promise<boolean>;
}
export interface MaterialCollectionReceipt { result: MaterialsCollectionResult; effect: "none" | "confirmed" }
export class MaterialCollectionMutationError extends Error {
  constructor(message: string, readonly effect: "none" | "unknown", options?: ErrorOptions) { super(message, options); }
}
export interface MaterialCollectionsDeps {
  materials?: WebMaterialStore;
  now?: () => number;
  serializer?: ReturnType<typeof createWorkspaceOpSerializer>;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
});
export const materialMutationOperationId = (origin: string): string => `material-mutation:${createHash("sha256").update(origin).digest("hex")}`;
const recordIdFor = (id: string): string => `material.collection:${id}`;
const sameIds = (left: readonly string[], right: readonly string[]) => canonical([...left].sort()) === canonical([...right].sort());
const parsePayload = (json: string): CollectionPayload | null => {
  try { const value = JSON.parse(json) as CollectionPayload;
    return value && typeof value.collectionId === "string" && Array.isArray(value.members) ? value : null;
  } catch { return null; }
};
const parseGrant = (record: Record): GrantPayload | null => {
  try { const value = JSON.parse(record.payloadJson) as GrantPayload;
    return value && typeof value.grantId === "string" && typeof value.toThreadId === "string"
      && value.fromThreadId === record.threadId && Array.isArray(value.snapshotIds) && Array.isArray(value.collectionIds) ? value : null;
  } catch { return null; }
};
const collection = ({ lastMutation: _mutation, ...value }: CollectionPayload): MaterialCollection => value;
const grant = ({ lastMutation: _mutation, ...value }: GrantPayload): MaterialGrant => value;
const writable = (record: Record, authority: WebSnapshotReadAuthority): boolean => record.threadId === authority.threadId;
const visible = (payload: CollectionPayload, record: Record, authority: WebSnapshotReadAuthority, grants: Set<string>): boolean => (
  payload.persisted || writable(record, authority) || authority.threadId !== undefined && grants.has(payload.collectionId)
);

export const createMaterialCollections = (workingStates: WorkspaceWorkingStateRootAccess, deps: MaterialCollectionsDeps = {}) => {
  const now = deps.now ?? Date.now;
  const serializer = deps.serializer ?? createWorkspaceOpSerializer();
  const inScope = <T>(ctx: MaterialCollectionContext, purpose: string, work: (context: KernelRecordContext) => Promise<T>): Promise<T> => {
    const { authority } = ctx;
    if (!authority || authority.kind !== "thread" || !authority.threadId || !authority.owningWorkspaceId) throw new HarnessServiceError("forbidden", "Material collections require an admitted Thread authority");
    const access: WorkspaceWorkingStateRootAccess = { withBranchStore: (workspace, use, consume, mode) => {
        if (workspace !== authority.owningWorkspaceId) throw new Error("Material authority changed its scope");
        return workingStates.withBranchStore(workspace, use, consume, mode, { threadId: authority.threadId });
      } };
    return kernelContext(access, authority.owningWorkspaceId, purpose, (_store, context) => work(context));
  };
  const grantsFor = async (context: KernelRecordContext, authority: WebSnapshotReadAuthority): Promise<Set<string>> => {
    const ids = new Set<string>();
    if (!authority.threadId) return ids;
    for (const record of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
      if (record.state === "released") continue;
      const value = parseGrant(record);
      if (value?.toThreadId === authority.threadId) for (const id of value.collectionIds) ids.add(id);
    }
    return ids;
  };
  const load = async (context: KernelRecordContext, id: string) => {
    const record = await context.records.get(recordIdFor(id));
    if (!record || record.recordType !== MATERIAL_COLLECTION_RECORD_TYPE || record.state === "released") return null;
    const payload = parsePayload(record.payloadJson);
    return payload ? { record, payload } : null;
  };
  const hashInput = (params: MaterialsCollectionParams, ctx: MaterialCollectionContext) => createHash("sha256")
    .update(canonical({ params, authority: ctx.authority })).digest("hex");
  const readReceipt = async (params: MaterialsCollectionParams, ctx: MaterialCollectionContext, context: KernelRecordContext): Promise<MaterialCollectionReceipt | null> => {
    if (!ctx.origin) return null;
    if (!context.client?.getOperation) throw new Error("Original material mutation receipts are unavailable");
    const operation = await context.client.getOperation(materialMutationOperationId(ctx.origin));
    if (!operation) return null;
    if (operation.kind !== "storage.record.put") throw new MaterialCollectionMutationError("Material mutation identity belongs to another operation", "unknown");
    if (operation.state === "failed") throw new MaterialCollectionMutationError("Material mutation was rejected; use a new invocation after checking the current collection", "none");
    if (operation.state !== "committed") throw new MaterialCollectionMutationError("Material mutation outcome is not confirmed", "unknown");
    const record = operation.result as Record;
    if (!record || record.workspaceId !== ctx.authority.owningWorkspaceId || !writable(record, ctx.authority)) {
      throw new MaterialCollectionMutationError("Material mutation receipt belongs to another authority", "unknown");
    }
    const value = params.action === "share" ? parseGrant(record) : parsePayload(record.payloadJson);
    const identity = value?.lastMutation;
    if (!value || identity?.origin !== ctx.origin || identity.inputHash !== hashInput(params, ctx)
      || !["none", "confirmed"].includes(identity.effect)
      || record.recordType !== (params.action === "share" ? MATERIAL_GRANT_RECORD_TYPE : MATERIAL_COLLECTION_RECORD_TYPE)) {
      throw new MaterialCollectionMutationError("Material mutation receipt differs from its original invocation", "unknown");
    }
    if (params.action === "share") return { effect: identity.effect, result: { status: "ok", grant: grant(value as GrantPayload) } };
    const saved = collection(value as CollectionPayload);
    if (params.action !== "create" && saved.collectionId !== params.collectionId?.trim()) {
      throw new MaterialCollectionMutationError("Material mutation receipt names another collection", "unknown");
    }
    const member = params.action === "add" ? saved.members.find(item => item.memberId === identity.memberId) : undefined;
    if (params.action === "add" && !member) throw new MaterialCollectionMutationError("Material addition receipt is incomplete", "unknown");
    return { effect: identity.effect, result: { status: "ok", collection: saved, ...(member ? { member } : {}) } };
  };
  const receipt = (params: MaterialsCollectionParams, ctx: MaterialCollectionContext) => inScope(ctx, "material-collections-read", context => readReceipt(params, ctx, context));
  const readRef = async (id: string, ctx: MaterialCollectionContext) => {
    const found = await deps.materials?.read(ctx.authority.owningWorkspaceId, id, ctx.authority, {
      byteRange: { offset: 0, length: 0 }, ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return found?.ref ?? null;
  };
  const refs = (member: MaterialCollectionMember, ref: WebSnapshotRef) => [
    { slot: `member:${member.memberId}:body`, objectHash: ref.contentHash },
    ...(ref.document?.source ? [{ slot: `member:${member.memberId}:source`, objectHash: ref.document.source.contentHash }] : []),
  ];
  const commit = async (params: MaterialsCollectionParams, ctx: MaterialCollectionContext,
    value: CollectionPayload | GrantPayload, previous: Record | undefined, references: Record["references"], memberId?: string,
    effect: MaterialCollectionReceipt["effect"] = "confirmed"): Promise<MaterialCollectionReceipt> => serializer.runSerialized(ctx.authority.owningWorkspaceId,
    () => inScope(ctx, "material-collections-write", async context => {
      const prior = await readReceipt(params, ctx, context);
      if (prior) return prior;
      ctx.signal?.throwIfAborted();
      const sharing = params.action === "share";
      if (sharing && !previous) {
        const proposed = value as GrantPayload;
        for (const record of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
          const current = record.state === "released" ? null : parseGrant(record);
          if (current?.fromThreadId === proposed.fromThreadId && current.toThreadId === proposed.toThreadId
            && sameIds(current.snapshotIds, proposed.snapshotIds) && sameIds(current.collectionIds, proposed.collectionIds)) {
            if (!ctx.origin) return { result: { status: "ok", grant: grant(current) }, effect: "none" };
            value = current; previous = record; effect = "none"; break;
          }
        }
      }
      const id = sharing ? `material.grant:${(value as GrantPayload).grantId}` : recordIdFor((value as CollectionPayload).collectionId);
      if (previous) {
        const current = await context.records.get(id);
        if (!current || current.state === "released" || current.recordRevision !== previous.recordRevision || !writable(current, ctx.authority)) {
          throw new HarnessServiceError("failed", "Material collection changed; read its current contents before trying again");
        }
      }
      const origin = ctx.origin ?? `material:${randomUUID()}`;
      value.lastMutation = { origin, inputHash: hashInput(params, ctx), ...(memberId ? { memberId } : {}), effect };
      ctx.signal?.throwIfAborted();
      let stored: Record;
      try {
        // Do not pass observer cancellation into an admitted atomic write. Its original
        // promise and operation receipt, not an abort race, establish the effect.
        stored = await context.records.put({ operationId: materialMutationOperationId(origin), recordId: id,
          recordType: sharing ? MATERIAL_GRANT_RECORD_TYPE : MATERIAL_COLLECTION_RECORD_TYPE, state: "temporary",
          threadId: ctx.authority.threadId,
          payloadJson: JSON.stringify(value), references,
          ...(previous ? { expectedRecordRevision: previous.recordRevision } : {}),
        });
      } catch (error) {
        if (!ctx.origin) throw error;
        try { const known = await readReceipt(params, ctx, context); if (known) return known; }
        catch (readError) { if (readError instanceof MaterialCollectionMutationError) throw readError;
          throw new MaterialCollectionMutationError("Material mutation outcome is unavailable", "unknown", { cause: readError }); }
        throw new MaterialCollectionMutationError("Material mutation has no confirmed receipt", "unknown", { cause: error });
      }
      if (ctx.origin) {
        // The actual returned immutable record proves commit even if cancellation arrived.
        if (stored.recordId !== id) throw new MaterialCollectionMutationError("Material mutation returned another record", "unknown");
      }
      return { effect, result: sharing ? { status: "ok", grant: grant(value as GrantPayload) }
        : { status: "ok", collection: collection(value as CollectionPayload),
          ...(memberId ? { member: (value as CollectionPayload).members.find(item => item.memberId === memberId)! } : {}) } };
    }));
  const execute = async (params: MaterialsCollectionParams, ctx: MaterialCollectionContext): Promise<MaterialCollectionReceipt> => {
    ctx.signal?.throwIfAborted();
    const result = (value: MaterialsCollectionResult): MaterialCollectionReceipt => ({ result: value, effect: "none" });
    if (!["list", "search"].includes(params.action) && ctx.origin) {
      const existing = await receipt(params, ctx); if (existing) return existing;
      ctx.signal?.throwIfAborted();
    }
    if (params.action === "create") {
      const at = now();
      return commit(params, ctx, { collectionId: `coll-${randomUUID()}`, ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        persisted: params.persist === true, createdAt: at, updatedAt: at, members: [] }, undefined, []);
    }
    if (params.action === "list") return inScope(ctx, "material-collections-read", async context => {
      const grants = await grantsFor(context, ctx.authority);
      const collections: MaterialCollectionSummary[] = [];
      for (const record of await context.records.list({ recordType: MATERIAL_COLLECTION_RECORD_TYPE })) {
        ctx.signal?.throwIfAborted();
        if (record.state === "released") continue;
        const payload = parsePayload(record.payloadJson);
        if (!payload || !visible(payload, record, ctx.authority, grants)) continue;
        collections.push({ collectionId: payload.collectionId, ...(payload.name ? { name: payload.name } : {}),
          persisted: payload.persisted, memberCount: payload.members.length, updatedAt: payload.updatedAt });
      }
      ctx.signal?.throwIfAborted();
      return result({ status: "ok", collections });
    });
    if (params.action === "share") {
      const fromThreadId = ctx.authority.threadId, toThreadId = params.targetThreadId?.trim();
      if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) throw new HarnessServiceError("invalid-params", "share requires another related Thread and a Thread-bound caller");
      const snapshotIds: string[] = [], collectionIds: string[] = [];
      if (params.collectionId?.trim()) {
        const selected = await inScope(ctx, "material-collections-read", async context => {
          const found = await load(context, params.collectionId!.trim());
          return found && visible(found.payload, found.record, ctx.authority, await grantsFor(context, ctx.authority)) ? found : null;
        });
        if (!selected) return result({ status: "not-found", message: "Collection is missing or not readable" });
        collectionIds.push(selected.payload.collectionId);
        for (const member of selected.payload.members) if (member.snapshotId && !snapshotIds.includes(member.snapshotId)) snapshotIds.push(member.snapshotId);
      } else if (params.snapshotId?.trim()) snapshotIds.push(params.snapshotId.trim());
      else throw new HarnessServiceError("invalid-params", "share requires collectionId or snapshotId");
      const references: Record["references"] = [];
      for (const id of snapshotIds) {
        const ref = await readRef(id, ctx);
        if (!ref) return result({ status: "denied", message: "Snapshot is not readable under this authority" });
        references.push({ slot: `snapshot:${id}:body`, objectHash: ref.contentHash });
        if (ref.document?.source) references.push({ slot: `snapshot:${id}:source`, objectHash: ref.document.source.contentHash });
      }
      if (!await ctx.threadsRelated?.(fromThreadId, toThreadId, ctx.authority.owningWorkspaceId)) return result({ status: "denied", message: "Target Thread is outside this task family" });
      ctx.signal?.throwIfAborted();
      const previous = await inScope(ctx, "material-collections-read", async context => {
        for (const record of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
          const value = record.state === "released" ? null : parseGrant(record);
          if (value?.fromThreadId === fromThreadId && value.toThreadId === toThreadId
            && sameIds(value.snapshotIds, snapshotIds) && sameIds(value.collectionIds, collectionIds)) return { record, value };
        }
        return null;
      });
      if (previous && !ctx.origin) return result({ status: "ok", grant: grant(previous.value) });
      return commit(params, ctx, previous?.value ?? { grantId: `grant-${randomUUID()}`, fromThreadId, toThreadId,
        snapshotIds, collectionIds, createdAt: now() }, previous?.record, references, undefined, previous ? "none" : "confirmed");
    }
    const id = params.collectionId?.trim();
    if (!id) throw new HarnessServiceError("invalid-params", "Choose a collectionId");
    const selected = await inScope(ctx, "material-collections-read", async context => {
      const found = await load(context, id);
      if (params.action === "search" && found && !visible(found.payload, found.record, ctx.authority, await grantsFor(context, ctx.authority))) return null;
      return found;
    });
    if (!selected) return result({ status: "not-found", message: `Collection not found: ${id}` });
    if (params.action === "search") {
      const query = params.query?.trim();
      if (!query || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) throw new HarnessServiceError("invalid-params", "Search requires a query and, if supplied, a positive integer limit");
      const hits: MaterialCollectionSearchHit[] = [], unreadable: string[] = [];
      const needle = query.toLowerCase();
      const full = () => params.limit !== undefined && hits.length >= params.limit;
      for (const member of selected.payload.members) {
        ctx.signal?.throwIfAborted();
        const found = member.snapshotId && deps.materials
          ? await deps.materials.read(ctx.authority.owningWorkspaceId, member.snapshotId, ctx.authority, ctx.signal ? { signal: ctx.signal } : {}) : null;
        if (member.snapshotId && !found) unreadable.push(member.memberId);
        // Member metadata belongs to the already-authorized collection. Snapshot
        // metadata/body are used only after their independent read authorization.
        const fields = [
          ["title", member.title], ["title", member.paper?.title], ["title", found?.ref.title],
          ["source", member.url], ["source", member.paper?.doi], ["source", member.paper?.id],
          ["source", found?.ref.sourceUrl], ["source", found?.ref.finalUrl],
        ] as const;
        const seen = new Set<string>();
        for (const [field, text] of fields) {
          if (!text || !text.toLowerCase().includes(needle) || seen.has(text)) continue;
          seen.add(text);
          const start = Math.max(0, text.toLowerCase().indexOf(needle) - 80);
          hits.push({ memberId: member.memberId, ...(found ? { snapshotId: found.ref.snapshotId } : {}),
            field, excerpt: text.slice(start, start + Math.max(240, query.length)) });
          if (full()) break;
        }
        if (full()) break;
        if (!found) continue;
        const lines = found.body.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const match = lines[index]!.toLowerCase().indexOf(needle);
          if (match < 0) continue;
          const start = Math.max(0, match - 80);
          hits.push({ memberId: member.memberId, snapshotId: found.ref.snapshotId, field: "body", line: index + 1,
            excerpt: lines[index]!.slice(start, start + Math.max(240, query.length)) });
          if (full()) break;
        }
        if (full()) break;
      }
      ctx.signal?.throwIfAborted();
      return result({ status: "ok", hits, ...(unreadable.length ? { unreadable } : {}) });
    }
    if (!writable(selected.record, ctx.authority)) return result({ status: "denied", message: "Collection is owned by another Thread" });
    const payload = structuredClone(selected.payload);
    if (params.action === "remove") {
      const memberId = params.memberId?.trim();
      if (!memberId) throw new HarnessServiceError("invalid-params", "remove requires memberId");
      const index = payload.members.findIndex(member => member.memberId === memberId);
      if (index < 0) return result({ status: "not-found", message: `Member not found: ${memberId}` });
      payload.members.splice(index, 1); payload.updatedAt = now();
      return commit(params, ctx, payload, selected.record, selected.record.references.filter(ref => ref.slot !== `member:${memberId}` && !ref.slot.startsWith(`member:${memberId}:`)));
    }
    if (params.action !== "add" || !params.member) throw new HarnessServiceError("invalid-params", "add requires a member");
    const input = params.member;
    const member: MaterialCollectionMember = { ...input, memberId: `mem-${randomUUID()}`, addedAt: now() };
    let ref: WebSnapshotRef | null = null;
    if (input.kind === "snapshot") {
      if (!input.snapshotId?.trim()) throw new HarnessServiceError("invalid-params", "snapshot member requires snapshotId");
      member.snapshotId = input.snapshotId.trim();
      ref = await readRef(member.snapshotId, ctx);
      if (!ref) return result({ status: "denied", message: "Snapshot is not readable under this authority" });
    } else if (input.kind === "url") {
      if (!input.url?.trim()) throw new HarnessServiceError("invalid-params", "url member requires url");
      if (!ctx.fetchUrl) return result({ status: "unavailable", message: "URL fetching is unavailable" });
      const fetched = await ctx.fetchUrl({ url: input.url.trim() });
      ctx.signal?.throwIfAborted();
      if (fetched.status !== "ok" || !fetched.snapshot) return result({ status: "failed", message: `URL could not be pinned (${fetched.status})` });
      member.snapshotId = fetched.snapshot.snapshotId; member.url = fetched.finalUrl ?? input.url.trim();
      const title = member.title ?? fetched.title ?? fetched.snapshot.title; if (title) member.title = title;
      ref = await readRef(member.snapshotId, ctx);
      if (!ref) return result({ status: "denied", message: "Fetched snapshot is not readable under this authority" });
    } else if (input.kind === "paper") {
      if (!input.paper?.provider.trim() || !input.paper.id.trim()) throw new HarnessServiceError("invalid-params", "paper member requires provider and id");
    } else throw new HarnessServiceError("invalid-params", "Unknown member kind");
    // Every retained snapshot edge needs the same original read proof, including
    // a paper identity with an attached snapshot. Persistence cannot launder a
    // guessed foreign snapshotId into a new read grant.
    if (member.snapshotId && !ref) {
      member.snapshotId = member.snapshotId.trim();
      ref = await readRef(member.snapshotId, ctx);
      if (!ref) return result({ status: "denied", message: "Snapshot is not readable under this authority" });
    }
    ctx.signal?.throwIfAborted();
    payload.members.push(member); payload.updatedAt = now();
    return commit(params, ctx, payload, selected.record, [...selected.record.references, ...(ref ? refs(member, ref) : [])], member.memberId);
  };
  const inspect = async (id: string, ctx: MaterialCollectionContext): Promise<MaterialsCollectionResult> => {
    ctx.signal?.throwIfAborted();
    return inScope(ctx, "material-collections-read", async context => {
      const found = await load(context, id);
      if (!found || !visible(found.payload, found.record, ctx.authority, await grantsFor(context, ctx.authority)))
        return { status: "not-found", message: "Collection is missing or not readable" };
      return { status: "ok", collection: collection(found.payload) };
    });
  };
  return { execute, receipt, inspect };
};
