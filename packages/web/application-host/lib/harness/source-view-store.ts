import { createHash, randomUUID } from "node:crypto";
import type { AgentInputContext } from "@varin/protocol";
import type { DocumentSurfaceWriteResult } from "@varin/protocol";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import type { SurfaceSnapshotCloneResult, SurfaceSnapshotInspectResult, SurfaceSnapshotOverlayResult, SurfaceSnapshotReadResult } from "../documents/surface-snapshot-store.js";
import type { AgentSurfaceWriteChange } from "../documents/surface-mutation.js";
import { applySurfaceEdits } from "../documents/surface-mutation.js";
import { detectLineEnding, normalizeEditorLineEndings, serializeEditorContent } from "../documents/line-ending.js";
import type { DirtyBufferPublication, FixedSourceMutationView } from "../documents/authority.js";
import type { KernelRecordContext } from "./retrieval-artifacts.js";

/** A private kernel storage partition. It is not a user project or a file-access root. */
export const SOURCE_VIEW_STORAGE_SCOPE = "varin-source-views";
const RECORD_TYPE = "agent.source-view";
const PREFIX = "source-view:";

interface ViewEntry {
  coordinationId: string;
  aliases: Array<{ workspaceId: string; resourceId: string }>;
  targetAlias?: { workspaceId: string; resourceId: string };
  slot: string;
  hash: string;
  byteLength: number;
  revision: string;
  encoding: string;
  bom: boolean;
  baseRevision: string | null;
  localEditRevision: number;
  bufferHash?: string;
  lineEnding?: "lf" | "crlf" | "cr";
  pending?: { operationId: string; sessionId: string; instanceId: string; workspaceId: string; resourceId: string; nextHash: string; nextByteLength: number; nextBufferHash: string; nextSlot: string };
}

interface ViewRecord {
  viewId: string;
  entries: ViewEntry[];
  unavailable: Array<{ workspaceId: string; resourceId: string }>;
  owners: Array<{ workspaceId: string; ownerId: string; generation: number }>;
}

const recordId = (viewId: string): string => `${RECORD_TYPE}:${viewId}`;
const aliasKey = (resource: { workspaceId: string; resourceId: string }): string =>
  `${resource.workspaceId}\0${resource.resourceId}`;

const parseRecord = (value: string): ViewRecord | null => {
  try {
    const record = JSON.parse(value) as ViewRecord;
    if (!record || typeof record.viewId !== "string" || !Array.isArray(record.entries)
      || !Array.isArray(record.unavailable)
      || (record.owners !== undefined && !Array.isArray(record.owners))
      || record.entries.some((entry) => typeof entry.coordinationId !== "string"
        || typeof entry.slot !== "string" || typeof entry.hash !== "string"
        || !Array.isArray(entry.aliases))) return null;
    // Views captured before editor-write support remain readable. They have no
    // captured owner, so a write must still fail rather than guessing one.
    return { ...record, owners: record.owners ?? [] };
  } catch {
    return null;
  }
};

export const sourceViewIdFromContext = (context: AgentInputContext): string | null =>
  context.source === "surface" && context.snapshot.status === "ready"
    && context.snapshot.ref.startsWith(PREFIX)
    ? context.snapshot.ref.slice(PREFIX.length)
    : null;

export const createSourceViewStore = (workingStates: WorkspaceWorkingStateRootAccess) => {
  const instanceId = randomUUID();
  const requireContext = (value: unknown): KernelRecordContext => {
    const context = value as KernelRecordContext | undefined;
    if (!context?.records) throw new Error("Kernel source-view record storage is unavailable");
    return context;
  };
  const load = async (viewId: string): Promise<ViewRecord | null> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-read-record",
    async (_store, context) => {
      const record = await requireContext(context).records.get(recordId(viewId));
      return record?.recordType === RECORD_TYPE && record.state !== "released"
        ? parseRecord(record.payloadJson)
        : null;
    },
    "shared",
  );
  const contextFor = async (viewId: string): Promise<AgentInputContext | null> => {
    const record = await load(viewId);
    if (!record) return null;
    const roots = new Map<string, Set<string>>();
    const add = (alias: { workspaceId: string; resourceId: string }) => {
      const paths = roots.get(alias.workspaceId) ?? new Set<string>();
      paths.add(alias.resourceId);
      roots.set(alias.workspaceId, paths);
    };
    for (const entry of record.entries) for (const alias of entry.aliases) add(alias);
    for (const alias of record.unavailable) add(alias);
    return {
      source: "surface",
      roots: [...roots].map(([workspaceId, paths]) => ({ workspaceId, dirtyPaths: [...paths].sort() })),
      snapshot: { status: "ready", ref: `${PREFIX}${viewId}` },
    };
  };

  const capture = async (
    cloned: Extract<SurfaceSnapshotCloneResult, { status: "ready" }>,
    excludedWorkspaceId: string,
    unavailable: Array<{ workspaceId: string; resourceId: string }> = [],
    owners: Array<{ workspaceId: string; ownerId: string; generation: number }> = [],
  ): Promise<{ viewId: string; context: AgentInputContext } | null> => {
    const byIdentity = new Map<string, { entry: (typeof cloned.resources)[number]; aliases: Map<string, { workspaceId: string; resourceId: string }> }>();
    for (const entry of cloned.resources) {
      if (!entry.coordinationId) {
        if ((entry.aliases ?? [entry.resource]).some((alias) => alias.workspaceId !== excludedWorkspaceId)) {
          throw new Error("External draft has no confirmed physical resource identity");
        }
        continue;
      }
      const previous = byIdentity.get(entry.coordinationId);
      if (previous && (previous.entry.content !== entry.content || previous.entry.revision !== entry.revision)) {
        throw new Error("Aliases of one external draft disagree on their fixed content");
      }
      const aliases = previous?.aliases ?? new Map<string, { workspaceId: string; resourceId: string }>();
      for (const alias of (entry.aliases ?? [entry.resource])) aliases.set(aliasKey(alias), alias);
      byIdentity.set(entry.coordinationId, { entry: previous?.entry ?? entry, aliases });
    }
    for (const [identity, group] of byIdentity) {
      if (![...group.aliases.values()].some((alias) => alias.workspaceId !== excludedWorkspaceId)) byIdentity.delete(identity);
    }
    const pending = unavailable.filter((entry) => entry.workspaceId !== excludedWorkspaceId);
    if (byIdentity.size === 0 && pending.length === 0) return null;

    const viewId = randomUUID();
    const roots = new Map<string, Set<string>>();
    const addAlias = (alias: { workspaceId: string; resourceId: string }) => {
      const paths = roots.get(alias.workspaceId) ?? new Set<string>();
      paths.add(alias.resourceId);
      roots.set(alias.workspaceId, paths);
    };
    for (const group of byIdentity.values()) {
      for (const alias of group.aliases.values()) {
        if (alias.workspaceId !== excludedWorkspaceId) addAlias(alias);
      }
    }
    for (const alias of pending) addAlias(alias);

    await workingStates.withBranchStore(SOURCE_VIEW_STORAGE_SCOPE, "source-view-capture", async (store, context) => {
      const records = requireContext(context).records;
      const entries: ViewEntry[] = [];
      const ownerIds: string[] = [];
      for (const [coordinationId, group] of byIdentity) {
        const { entry } = group;
        const bytes = Buffer.from(entry.content, "utf8");
        const object = await store.putObject(bytes);
        const ownerId = store.ownerIdForObject?.(object.hash);
        if (ownerId) ownerIds.push(ownerId);
        entries.push({
          coordinationId,
          aliases: [...group.aliases.values()].filter((alias) => alias.workspaceId !== excludedWorkspaceId),
          ...([...group.aliases.values()].find((alias) => alias.workspaceId === excludedWorkspaceId)
            ? { targetAlias: [...group.aliases.values()].find((alias) => alias.workspaceId === excludedWorkspaceId)! }
            : {}),
          slot: `entry:${entries.length}`,
          hash: object.hash,
          byteLength: object.byteLength,
          revision: entry.revision,
          encoding: entry.encoding,
          bom: entry.bom,
          baseRevision: entry.baseRevision,
          localEditRevision: entry.localEditRevision,
          bufferHash: entry.bufferHash ?? `sha256-${createHash("sha256").update(normalizeEditorLineEndings(entry.content), "utf8").digest("hex")}`,
          ...(entry.lineEnding ? { lineEnding: entry.lineEnding } : {}),
        });
      }
      const value: ViewRecord = { viewId, entries, unavailable: pending, owners };
      await records.put({
        operationId: `source-view-capture:${viewId}`,
        recordId: recordId(viewId),
        recordType: RECORD_TYPE,
        state: "temporary",
        payloadJson: JSON.stringify(value),
        ownerIds,
        references: entries.map((entry) => ({ slot: entry.slot, objectHash: entry.hash })),
      });
    });
    return {
      viewId,
      context: {
        source: "surface",
        roots: [...roots].map(([workspaceId, paths]) => ({ workspaceId, dirtyPaths: [...paths].sort() })),
        snapshot: { status: "ready", ref: `${PREFIX}${viewId}` },
      },
    };
  };

  const read = async (
    viewId: string,
    workspaceId: string,
    resourceId: string,
    coordinationId: string | null,
  ): Promise<SurfaceSnapshotReadResult> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-read",
    async (store, context) => {
      const storage = requireContext(context);
      const record = await storage.records.get(recordId(viewId));
      const value = record?.recordType === RECORD_TYPE && record.state !== "released"
        ? parseRecord(record.payloadJson)
        : null;
      if (!record || !value) return { status: "unavailable", message: "The fixed source view is no longer available" };
      const key = aliasKey({ workspaceId, resourceId });
      if (value.unavailable.some((alias) => aliasKey(alias) === key)) {
        return { status: "unavailable", message: "This external editor draft was unavailable at dispatch" };
      }
      const entry = value.entries.find((item) => item.aliases.some((alias) => aliasKey(alias) === key));
      if (!entry) return { status: "disk" };
      if (entry.pending) return { status: "unavailable", message: "The external editor write has not been confirmed" };
      if (!coordinationId || coordinationId !== entry.coordinationId) {
        return { status: "unavailable", message: "The external file identity changed after dispatch" };
      }
      const reference = record.references.find((item) => item.slot === entry.slot && item.objectHash === entry.hash);
      if (!reference) return { status: "unavailable", message: "The fixed source object reference is missing" };
      const bytes = storage.client
        ? Buffer.from((await storage.client.getBlob(entry.hash, { recordId: record.recordId, slot: entry.slot })).bytesBase64, "base64")
        : await store.getObject(entry.hash);
      if (!bytes || bytes.byteLength !== entry.byteLength) {
        return { status: "unavailable", message: "The fixed source object is unavailable" };
      }
      return {
        status: "ready", source: "surface-draft", content: bytes.toString("utf8"),
        revision: entry.revision, encoding: entry.encoding, bom: entry.bom,
      };
    },
    "shared",
  );

  const prepareMutation = async (
    viewId: string,
    sessionId: string,
    workspaceId: string,
    changes: readonly AgentSurfaceWriteChange[],
  ): Promise<{ fixedView: FixedSourceMutationView; fixedPaths: string[] } | null> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-write-prepare",
    async (store, context) => {
      const storage = requireContext(context);
      const record = await storage.records.get(recordId(viewId));
      const value = record?.recordType === RECORD_TYPE && record.state !== "released"
        ? parseRecord(record.payloadJson) : null;
      if (!record || !value) throw new Error("The fixed source view is no longer available");
      const selected = changes.flatMap((change) => {
        const key = aliasKey({ workspaceId, resourceId: change.resourceId });
        const entry = value.entries.find((item) => item.aliases.some((alias) => aliasKey(alias) === key));
        return entry ? [{ change, entry }] : [];
      });
      if (selected.length === 0) return null;
      if (new Set(selected.map(({ entry }) => entry.coordinationId)).size !== selected.length) {
        throw new Error("One editor draft appears more than once in this write; no file was changed");
      }
      const owner = value.owners.find((item) => item.workspaceId === workspaceId);
      if (!owner) throw new Error(`The external editor for ${workspaceId} has no captured owner`);
      const operationId = randomUUID();
      const inspections = new Map<string, SurfaceSnapshotInspectResult>();
      const ownerIds: string[] = [];
      for (const { change, entry } of selected) {
        if (entry.targetAlias) throw new Error(`${change.resourceId} belongs to the child's own branch, not the external editor`);
        if (entry.pending) throw new Error(`${change.resourceId} has an unconfirmed editor write`);
        if (!Number.isSafeInteger(entry.localEditRevision) || entry.localEditRevision < 0) {
          throw new Error(`${change.resourceId} has no captured editor version; reopen the child source view before writing`);
        }
        if (change.action === "delete") throw new Error(`${change.resourceId} is an editor buffer and cannot be deleted by a text tool`);
        const bytes = storage.client
          ? Buffer.from((await storage.client.getBlob(entry.hash, { recordId: record.recordId, slot: entry.slot })).bytesBase64, "base64")
          : await store.getObject(entry.hash);
        if (!bytes || bytes.byteLength !== entry.byteLength) throw new Error(`${change.resourceId} fixed draft bytes are unavailable`);
        const content = bytes.toString("utf8");
        const lineEnding = entry.lineEnding ?? detectLineEnding(content);
        if (change.action === "write" && typeof change.content !== "string") {
          throw new Error("write requires text content");
        }
        if (change.action === "edit" && !change.edits?.length) {
          throw new Error("edit requires at least one replacement");
        }
        const next = change.action === "write"
          ? serializeEditorContent(change.content!, lineEnding)
          : applySurfaceEdits(content, change.edits!, lineEnding);
        if (next.includes("\0")) throw new Error(`${change.resourceId} is not a text file`);
        const nextObject = await store.putObject(Buffer.from(next, "utf8"));
        const nextOwnerId = store.ownerIdForObject?.(nextObject.hash);
        if (nextOwnerId) ownerIds.push(nextOwnerId);
        const nextSlot = `pending:${randomUUID()}`;
        const bufferHash = entry.bufferHash ?? `sha256-${createHash("sha256").update(normalizeEditorLineEndings(content), "utf8").digest("hex")}`;
        inspections.set(change.resourceId, {
          status: "ready", source: "surface-draft", content, revision: entry.revision,
          resource: { workspaceId, resourceId: change.resourceId },
          baseRevision: entry.baseRevision, localEditRevision: entry.localEditRevision,
          encoding: entry.encoding, bom: entry.bom, bufferHash, lineEnding,
        });
        entry.pending = {
          operationId, sessionId, instanceId, workspaceId, resourceId: change.resourceId,
          nextHash: nextObject.hash, nextByteLength: nextObject.byteLength,
          nextBufferHash: `sha256-${createHash("sha256").update(normalizeEditorLineEndings(next), "utf8").digest("hex")}`,
          nextSlot,
        };
      }
      const references = value.entries.flatMap((entry) => [
        { slot: entry.slot, objectHash: entry.hash },
        ...(entry.pending ? [{ slot: entry.pending.nextSlot, objectHash: entry.pending.nextHash }] : []),
      ]);
      await storage.records.put({
        operationId: `source-view-write-prepare:${operationId}`, recordId: record.recordId,
        recordType: RECORD_TYPE, state: record.state, payloadJson: JSON.stringify(value),
        ownerIds, references, expectedRecordRevision: record.recordRevision,
      });
      return {
        fixedPaths: [...inspections.keys()],
        fixedView: {
          operationId,
          inspect: (resourceId, targetWorkspaceId) => {
            if (targetWorkspaceId !== workspaceId) return { status: "disk" };
            const fixed = inspections.get(resourceId);
            if (fixed) return fixed;
            return value.unavailable.some((alias) => alias.workspaceId === workspaceId && alias.resourceId === resourceId)
              ? { status: "unavailable", message: "The external editor draft was unavailable at dispatch" }
              : { status: "disk" };
          },
          owner: (targetWorkspaceId) => targetWorkspaceId === workspaceId ? owner : null,
        },
      };
    },
  );

  const pendingOperation = async (viewId: string, workspaceId: string, resourceId: string) => {
    const record = await load(viewId);
    const key = aliasKey({ workspaceId, resourceId });
    return record?.entries.find((entry) => entry.aliases.some((alias) => aliasKey(alias) === key))?.pending ?? null;
  };

  const clearUnstartedMutation = async (
    viewId: string, operationId: string, livePublications: readonly DirtyBufferPublication[],
  ): Promise<boolean> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE, "source-view-clear-unstarted", async (_store, context) => {
      const records = requireContext(context).records;
      const record = await records.get(recordId(viewId));
      const value = record?.recordType === RECORD_TYPE && record.state !== "released"
        ? parseRecord(record.payloadJson) : null;
      if (!record || !value) return false;
      const pending = value.entries.filter((entry) => entry.pending?.operationId === operationId);
      if (!pending.length || pending.some((entry) => entry.pending!.instanceId === instanceId)) return false;
      // A missing durable operation alone is insufficient if old journal rows
      // were collected. Require the same editor owner, hash and local revision.
      for (const entry of pending) {
        const marker = entry.pending!;
        const owner = value.owners.find((candidate) => candidate.workspaceId === marker.workspaceId);
        const live = owner && livePublications.find((publication) => publication.workspaceId === marker.workspaceId
          && publication.ownerId === owner.ownerId && publication.generation === owner.generation)
          ?.resources.find((resource) => resource.resource.resourceId === marker.resourceId);
        if (!live || live.localEditRevision !== entry.localEditRevision || live.bufferHash !== entry.bufferHash) return false;
      }
      for (const entry of pending) delete entry.pending;
      await records.put({
        operationId: `source-view-clear-unstarted:${operationId}`, recordId: record.recordId,
        recordType: RECORD_TYPE, state: record.state, payloadJson: JSON.stringify(value),
        references: value.entries.flatMap((entry) => [
          { slot: entry.slot, objectHash: entry.hash },
          ...(entry.pending ? [{ slot: entry.pending.nextSlot, objectHash: entry.pending.nextHash }] : []),
        ]), expectedRecordRevision: record.recordRevision,
      });
      return true;
    },
  );

  const finishMutation = async (
    viewId: string, operationId: string, result: DocumentSurfaceWriteResult, livePublications: readonly DirtyBufferPublication[] = [],
  ): Promise<void> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-write-finish",
    async (_store, context) => {
      const records = requireContext(context).records;
      const record = await records.get(recordId(viewId));
      const value = record?.recordType === RECORD_TYPE && record.state !== "released"
        ? parseRecord(record.payloadJson) : null;
      if (!record || !value) throw new Error("The fixed source view disappeared before write confirmation");
      const outcomes = result.status === "disk" ? [] : result.results;
      let changed = false;
      for (const entry of value.entries) {
        const pending = entry.pending;
        if (pending?.operationId !== operationId) continue;
        const outcome = outcomes.find((item) => item.path === pending.resourceId);
        if (outcome?.status === "applied" && outcome.revision) {
          const revision = Number(outcome.revision.slice(outcome.revision.lastIndexOf(":") + 1));
          if (!Number.isSafeInteger(revision) || revision <= entry.localEditRevision) continue;
          entry.hash = pending.nextHash;
          entry.byteLength = pending.nextByteLength;
          entry.slot = pending.nextSlot;
          entry.bufferHash = pending.nextBufferHash;
          entry.localEditRevision = revision;
          entry.revision = outcome.revision;
          delete entry.pending;
          changed = true;
        } else if (outcome?.status === "compensated") {
          const owner = value.owners.find((item) => item.workspaceId === pending.workspaceId);
          if (!owner) continue;
          const live = livePublications.find((item) => item.workspaceId === pending.workspaceId
            && item.ownerId === owner.ownerId && item.generation === owner.generation)
            ?.resources.find((item) => item.resource.resourceId === pending.resourceId);
          if (!live || live.bufferHash !== entry.bufferHash || !Number.isSafeInteger(live.localEditRevision)) continue;
          entry.localEditRevision = live.localEditRevision;
          entry.revision = `surface-draft:source-view:${viewId}:${live.localEditRevision}`;
          delete entry.pending;
          changed = true;
        } else if (outcome && outcome.status !== "needs-attention") {
          // The completed Documents transaction confirms no editor change for
          // this path. An uncertain or compensated mutation keeps the marker.
          delete entry.pending;
          changed = true;
        }
      }
      if (!changed) return;
      await records.put({
        operationId: `source-view-write-finish:${operationId}`, recordId: record.recordId,
        recordType: RECORD_TYPE, state: record.state, payloadJson: JSON.stringify(value),
        references: value.entries.flatMap((entry) => [
          { slot: entry.slot, objectHash: entry.hash },
          ...(entry.pending ? [{ slot: entry.pending.nextSlot, objectHash: entry.pending.nextHash }] : []),
        ]),
        expectedRecordRevision: record.recordRevision,
      });
    },
  );

  const targetAlias = async (
    viewId: string,
    workspaceId: string,
    resourceId: string,
    coordinationId: string | null,
  ): Promise<{ workspaceId: string; resourceId: string } | null> => {
    const record = await load(viewId);
    const key = aliasKey({ workspaceId, resourceId });
    const entry = record?.entries.find((item) => item.aliases.some((alias) => aliasKey(alias) === key));
    if (!entry?.targetAlias) return null;
    if (!coordinationId || coordinationId !== entry.coordinationId) {
      throw new Error("The external file identity changed after dispatch");
    }
    return entry.targetAlias;
  };

  const overlay = async (
    viewId: string,
    workspaceId: string,
    root: string,
    resolveAliasedSource?: (alias: { workspaceId: string; resourceId: string }) => Promise<
      | { status: "ready"; revision: string }
      | { status: "missing" }
      | { status: "unavailable"; message: string }
    >,
  ): Promise<SurfaceSnapshotOverlayResult> => {
    const record = await load(viewId);
    if (!record) return { status: "unavailable", message: "The fixed source view is no longer available" };
    const normalizedRoot = root.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    const within = (value: string): boolean => !normalizedRoot || value === normalizedRoot || value.startsWith(`${normalizedRoot}/`);
    if (record.unavailable.some((alias) => alias.workspaceId === workspaceId && within(alias.resourceId))) {
      return { status: "unavailable", message: "An external editor draft was unavailable at dispatch" };
    }
    const files: Array<{ path: string; kind: "file"; revision: string }> = [];
    const removedPaths: string[] = [];
    let sawRelevantAlias = false;
    for (const entry of record.entries) for (const alias of entry.aliases) {
      if (alias.workspaceId !== workspaceId || !within(alias.resourceId)) continue;
      if (entry.pending) return { status: "unavailable", message: "The external editor write has not been confirmed" };
      sawRelevantAlias = true;
      let revision = entry.revision;
      if (entry.targetAlias && resolveAliasedSource) {
        const current = await resolveAliasedSource(alias);
        if (current.status === "unavailable") return current;
        if (current.status === "missing") {
          removedPaths.push(normalizedRoot ? alias.resourceId.slice(normalizedRoot.length).replace(/^\//, "") || "." : alias.resourceId);
          continue;
        }
        revision = current.revision;
      }
      files.push({
        path: normalizedRoot ? alias.resourceId.slice(normalizedRoot.length).replace(/^\//, "") || "." : alias.resourceId,
        kind: "file", revision,
      });
    }
    if (!sawRelevantAlias) return { status: "disk" };
    const directories = new Map<string, { path: string; kind: "directory" }>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const path = parts.slice(0, index).join("/");
        directories.set(path, { path, kind: "directory" });
      }
    }
    return {
      status: "ready",
      entries: [...directories.values(), ...files].sort((a, b) => a.path.localeCompare(b.path)),
      ...(removedPaths.length ? { removedPaths } : {}),
    };
  };

  const release = async (viewId: string): Promise<void> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-release",
    async (_store, context) => {
      await requireContext(context).records.release(`source-view-release:${viewId}`, recordId(viewId));
    },
  );

  /** A crash between capture and Thread catalog creation can leave an unowned record. */
  const reconcile = async (retainedViewIds: ReadonlySet<string>): Promise<void> => workingStates.withBranchStore(
    SOURCE_VIEW_STORAGE_SCOPE,
    "source-view-reconcile",
    async (_store, context) => {
      const records = requireContext(context).records;
      for (const record of await records.list({ recordType: RECORD_TYPE })) {
        if (!record.recordId.startsWith(`${RECORD_TYPE}:`)) continue;
        const viewId = record.recordId.slice(RECORD_TYPE.length + 1);
        if (!retainedViewIds.has(viewId) && record.state !== "released") {
          await records.release(`source-view-orphan-release:${viewId}`, record.recordId);
        }
      }
    },
  );

  return { capture, contextFor, read, targetAlias, overlay, prepareMutation, pendingOperation, clearUnstartedMutation, finishMutation, release, reconcile };
};
