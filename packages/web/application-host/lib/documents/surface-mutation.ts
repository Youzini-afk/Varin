import { createHash, randomUUID } from "node:crypto";
import type {
  AgentInputContext,
  DocumentSurfaceWriteChange,
  DocumentSurfaceWritePathResult,
  DocumentSurfaceWriteResult,
} from "@varin/protocol";
import type {
  DirtyBufferPublication,
  DocumentSurfaceOperationRequest,
  DocumentSurfaceOperationResult,
  MutationToken,
} from "./authority.js";
import type { SurfaceSnapshotInspectResult } from "./surface-snapshot-store.js";
import {
  detectLineEnding,
  normalizeEditorLineEndings,
  serializeEditorContent,
  type DocumentLineEnding,
} from "./line-ending.js";
import {
  beginAgentMutationOperationAsync,
  compensateAgentMutationDiskPath,
  finalizeAgentMutationOperation,
  markAgentMutationPathApplied,
  markAgentMutationPathNeedsAttention,
  markAgentMutationSurfaceCompensateIntent,
  markAgentMutationSurfaceDispatched,
  markAgentMutationSurfaceCompensated,
  markAgentMutationSurfaceNotApplied,
  type AgentMutationDiskIdentity,
  type AgentMutationSurfaceBinding,
  type PersistedAgentMutationData,
} from "./agent-mutation-operation.js";
import type { DurableFileOperationContext } from "../recovery/durable-file-operation.js";
import type { RecoveryState } from "../recovery/journal-files.js";

export interface AgentSurfaceWriteChange {
  resourceId: string;
  action: DocumentSurfaceWriteChange["action"];
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  expectedRevision?: string;
  expectedHash?: string;
}

export interface AgentMutationRecord {
  operationId: string;
  sessionId: string;
  workspaceId: string;
  targetKinds: Record<string, "surface" | "disk">;
  results: DocumentSurfaceWritePathResult[];
}

export interface SurfaceMutationDiskWriteResult {
  status: "written" | "conflict" | "missing";
  revision?: string;
  message?: string;
}

export interface SurfaceMutationDiskDeleteResult {
  status: "deleted" | "conflict" | "missing";
  message?: string;
}

export interface SurfaceMutationDiskRead {
  status: "ready" | "missing" | "binary" | "unsupported-encoding";
  content?: string;
  revision?: string;
  encoding?: string;
  bom?: boolean;
  candidates?: string[];
}

export interface SurfaceMutationDependencies {
  inspectSnapshot: (
    sessionId: string,
    context: AgentInputContext,
    resourceId: string,
    workspaceId: string,
  ) => SurfaceSnapshotInspectResult;
  surfaceOwner: (
    sessionId: string,
    context: AgentInputContext,
    workspaceId: string,
  ) => { ownerId: string; generation: number; workspaceId: string } | null;
  inspectDirtyBuffers: (workspaceId: string) => Promise<DirtyBufferPublication[]>;
  requestSurfaceOperation: (
    request: DocumentSurfaceOperationRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<DocumentSurfaceOperationResult[]>;
  inspectWorkspace: (workspaceId: string) => Promise<{ epoch: number }>;
  readDisk: (workspaceId: string, resourceId: string) => Promise<SurfaceMutationDiskRead>;
  writeDisk: (input: {
    workspaceId: string;
    resourceId: string;
    content: string;
    encoding: string;
    bom: boolean;
    expectedRevision: string | null;
    token: MutationToken;
    operationId: string;
  }) => Promise<SurfaceMutationDiskWriteResult>;
  deleteDisk: (input: {
    workspaceId: string;
    resourceId: string;
    expectedRevision: string;
    token: MutationToken;
    operationId: string;
  }) => Promise<SurfaceMutationDiskDeleteResult>;
  durable?: DurableFileOperationContext;
  workspaceRoot?: string;
}

type PlannedClass = "surface" | "disk" | "conflict" | "unavailable";

interface PlannedPath {
  change: AgentSurfaceWriteChange;
  class: PlannedClass;
  inspect?: Extract<SurfaceSnapshotInspectResult, { status: "ready" }>;
  newText?: string;
  editorText?: string;
  lineEnding?: DocumentLineEnding;
  binding?: NonNullable<DirtyBufferPublication["resources"][number]>;
  publication?: DirtyBufferPublication;
  result?: DocumentSurfaceWritePathResult;
  diskBefore?: {
    content: string;
    revision: string | null;
    encoding: string;
    bom: boolean;
    existed: boolean;
    state?: RecoveryState;
  };
  diskAfter?: RecoveryState;
}

const contentHash = (content: string): string => (
  `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`
);

const editorBufferHash = (content: string): string => contentHash(normalizeEditorLineEndings(content));

const diskIdentityHash = (content: string): string => contentHash(content);

const sameResource = (left: string, right: string): boolean => (
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
);

export const applyTextEdits = (
  text: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): string => {
  let next = text;
  for (const edit of edits) {
    if (!edit.oldText) throw new Error("Edit oldText must not be empty");
    const index = next.indexOf(edit.oldText);
    if (index < 0) throw new Error("Could not find the exact text to replace");
    if (next.indexOf(edit.oldText, index + edit.oldText.length) >= 0) {
      throw new Error("Edit oldText matched more than once; make the text unique");
    }
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
};

export const applySurfaceEdits = (
  serialized: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
  lineEnding: DocumentLineEnding,
): string => {
  try {
    return applyTextEdits(serialized, edits);
  } catch (serializedError) {
    try {
      const normalized = applyTextEdits(
        normalizeEditorLineEndings(serialized),
        edits.map((edit) => ({
          oldText: normalizeEditorLineEndings(edit.oldText),
          newText: normalizeEditorLineEndings(edit.newText),
        })),
      );
      return serializeEditorContent(normalized, lineEnding);
    } catch {
      throw serializedError;
    }
  }
};

const isBinaryText = (content: string): boolean => content.includes("\0");

const findPublished = (
  publication: DirtyBufferPublication | undefined,
  resourceId: string,
): DirtyBufferPublication["resources"][number] | undefined => (
  publication?.resources.find((resource) => sameResource(resource.resource.resourceId, resourceId))
);

const snapshotBufferHash = (
  inspect: Extract<SurfaceSnapshotInspectResult, { status: "ready" }>,
): string => inspect.bufferHash ?? editorBufferHash(inspect.content);

const liveMismatch = (
  inspect: Extract<SurfaceSnapshotInspectResult, { status: "ready" }>,
  binding: DirtyBufferPublication["resources"][number] | undefined,
  publication: DirtyBufferPublication | undefined,
): string | null => {
  if (!publication?.registrationId) {
    return `${inspect.resource.resourceId} has unsaved editor changes but its surface owner is no longer connected. Nothing was written.`;
  }
  if (!binding || !binding.documentInstanceId || !binding.bufferHash) {
    return `${inspect.resource.resourceId} has unsaved editor changes but its live buffer identity is incomplete. Nothing was written.`;
  }
  if (binding.baseRevision !== inspect.baseRevision
    || binding.localEditRevision !== inspect.localEditRevision
    || binding.bufferHash !== snapshotBufferHash(inspect)
    || binding.documentInstanceId.length === 0) {
    return `${inspect.resource.resourceId} changed in the editor after this turn fixed its draft. `
      + "The live buffer was left untouched and nothing was written to disk.";
  }
  return null;
};

const pathResult = (
  base: Omit<DocumentSurfaceWritePathResult, "revision" | "message"> & {
    revision?: string | undefined;
    message?: string | undefined;
  },
): DocumentSurfaceWritePathResult => ({
  path: base.path,
  target: base.target,
  status: base.status,
  ...(base.revision === undefined ? {} : { revision: base.revision }),
  ...(base.message === undefined ? {} : { message: base.message }),
});

const summarize = (
  planned: PlannedPath[],
  operationId: string,
): DocumentSurfaceWriteResult => {
  const results = planned.map((item) => {
    if (item.result) return item.result;
    const fallbackMessage = item.class === "conflict" || item.class === "unavailable"
      ? "The planned mutation could not be applied."
      : undefined;
    return pathResult({
      path: item.change.resourceId,
      target: item.class === "disk" ? "disk" : "surface",
      status: item.class === "disk" ? "disk"
        : item.class === "unavailable" ? "unavailable"
          : "conflict",
      ...(item.inspect && item.class !== "unavailable" ? { revision: item.inspect.revision } : {}),
      ...(fallbackMessage === undefined ? {} : { message: fallbackMessage }),
    });
  });
  const written = results.some((result) => result.status === "applied");
  const blocked = results.filter((result) => (
    result.status === "conflict" || result.status === "unavailable"
      || result.status === "needs-attention" || result.status === "compensated"
  ));
  const allBlocked = !written && blocked.length === results.length;
  const allUnavailable = allBlocked && blocked.every((result) => result.status === "unavailable");
  const status = written && blocked.length === 0 ? "applied"
    : written ? "partial"
      : allUnavailable ? "unavailable"
        : "conflict";
  const message = status === "applied"
    ? undefined
    : results.map((result) => (
      `${result.status} ${result.path} (${result.target})${result.message ? `: ${result.message}` : ""}`
    )).join("\n");
  return {
    status,
    results,
    operationId,
    ...(message ? { message } : {}),
  };
};

const diskToken = async (
  deps: SurfaceMutationDependencies,
  workspaceId: string,
): Promise<MutationToken> => {
  const state = await deps.inspectWorkspace(workspaceId);
  return {
    workspaceId,
    epoch: state.epoch,
    owner: { kind: "harness", id: "agent-surface-write" },
  };
};

const captureDiskState = async (
  deps: SurfaceMutationDependencies,
  resourceId: string,
): Promise<RecoveryState | undefined> => {
  if (!deps.durable) return undefined;
  return (await deps.durable.fileStore.captureState(
    deps.durable.identity,
    deps.durable.root,
    resourceId,
    { store: true },
  )).state;
};

export async function applyAgentSurfaceMutation(
  deps: SurfaceMutationDependencies,
  input: {
    sessionId: string;
    context: AgentInputContext;
    workspaceId: string;
    changes: readonly AgentSurfaceWriteChange[];
    signal?: AbortSignal;
    operationId?: string;
  },
): Promise<{ result: DocumentSurfaceWriteResult; record: AgentMutationRecord | null }> {
  if (input.changes.length === 0) {
    return { result: { status: "disk" }, record: null };
  }

  const workspaceId = input.workspaceId;
  const planned: PlannedPath[] = [];
  for (const change of input.changes) {
    const inspect = deps.inspectSnapshot(input.sessionId, input.context, change.resourceId, workspaceId);
    if (inspect.status === "unavailable") {
      planned.push({
        change,
        class: "unavailable",
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          message: `${change.resourceId} has unsaved editor changes but its fixed draft is unavailable (${inspect.message}). Nothing was written.`,
        },
      });
      continue;
    }
    if (inspect.status === "disk") {
      planned.push({ change, class: "disk" });
      continue;
    }
    if (change.expectedRevision && change.expectedRevision !== inspect.revision) {
      planned.push({
        change,
        class: "conflict",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "conflict",
          revision: inspect.revision,
          message: `${change.resourceId} no longer matches the surface revision the patch was computed from.`,
        },
      });
      continue;
    }
    if (change.expectedHash && change.expectedHash !== snapshotBufferHash(inspect)) {
      planned.push({
        change,
        class: "conflict",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "conflict",
          revision: inspect.revision,
          message: `${change.resourceId} no longer matches the surface hash the patch was computed from.`,
        },
      });
      continue;
    }
    if (change.action === "delete") {
      planned.push({
        change,
        class: "unavailable",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          revision: inspect.revision,
          message: `${change.resourceId} is an editor buffer and cannot be deleted, have its mode changed, or be treated as a symlink. Nothing was written.`,
        },
      });
      continue;
    }
    const lineEnding = inspect.lineEnding ?? detectLineEnding(inspect.content);
    let newText: string;
    try {
      if (change.action === "write") {
        if (typeof change.content !== "string") throw new Error("write requires text content");
        newText = serializeEditorContent(change.content, lineEnding);
      } else {
        const edits = change.edits ?? [];
        if (edits.length === 0) throw new Error("edit requires at least one replacement");
        newText = applySurfaceEdits(inspect.content, edits, lineEnding);
      }
    } catch (error) {
      planned.push({
        change,
        class: "conflict",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "conflict",
          revision: inspect.revision,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }
    if (isBinaryText(newText)) {
      planned.push({
        change,
        class: "unavailable",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          revision: inspect.revision,
          message: `${change.resourceId} is not a text file. Nothing was written.`,
        },
      });
      continue;
    }
    planned.push({
      change,
      class: "surface",
      inspect,
      newText,
      editorText: normalizeEditorLineEndings(newText),
      lineEnding,
    });
  }

  if (planned.every((item) => item.class === "disk") && !deps.durable) {
    return { result: { status: "disk" }, record: null };
  }

  const snapshotOwner = deps.surfaceOwner(input.sessionId, input.context, workspaceId);
  const owner = snapshotOwner?.workspaceId === workspaceId ? snapshotOwner : null;
  const surfaceItems = planned.filter((item) => item.class === "surface");
  if (surfaceItems.length > 0 && !owner) {
    for (const item of surfaceItems) {
      item.class = "unavailable";
      item.result = {
        path: item.change.resourceId,
        target: "surface",
        status: "unavailable",
        message: `${item.change.resourceId} has unsaved editor changes but its fixed draft expired. Nothing was written.`,
      };
    }
  }

  const publications = owner ? await deps.inspectDirtyBuffers(owner.workspaceId) : [];
  const publication = owner
    ? publications.find((entry) => entry.ownerId === owner.ownerId && entry.generation === owner.generation)
    : undefined;

  for (const item of planned.filter((entry) => entry.class === "surface")) {
    const binding = findPublished(publication, item.change.resourceId);
    const mismatch = liveMismatch(item.inspect!, binding, publication);
    if (mismatch || !binding || !publication) {
      item.class = "conflict";
      item.result = pathResult({
        path: item.change.resourceId,
        target: "surface",
        status: "conflict",
        revision: item.inspect!.revision,
        message: mismatch ?? "The planned mutation could not be applied.",
      });
      continue;
    }
    item.binding = binding;
    item.publication = publication;
  }

  const toApplySurface = planned.filter((item) => item.class === "surface");
  const toApplyDisk = planned.filter((item) => item.class === "disk");
  const operationId = input.operationId ?? randomUUID();
  const applied: Array<
    | { kind: "surface"; item: PlannedPath; receipt: DocumentSurfaceOperationResult }
    | { kind: "disk"; item: PlannedPath; before: NonNullable<PlannedPath["diskBefore"]> }
  > = [];
  let durable: PersistedAgentMutationData | null = null;
  let surfaceDispatched = false;
  let preparationError: string | null = null;

  const persistIntent = async (): Promise<PersistedAgentMutationData | null> => {
    if (!deps.durable) return durable;
    if (durable) return durable;
    const surfaceBindings: Record<string, AgentMutationSurfaceBinding> = {};
    const diskIdentities: Record<string, AgentMutationDiskIdentity> = {};
    const targets: Record<string, { expected: RecoveryState; target: RecoveryState }> = {};
    const safety: Record<string, RecoveryState> = {};
    const targetKinds: Record<string, "surface" | "disk"> = {};
    for (const item of [...toApplySurface, ...toApplyDisk.filter((entry) => entry.class === "disk")]) {
      targetKinds[item.change.resourceId] = item.class === "disk" ? "disk" : "surface";
    }
    for (const item of toApplySurface) {
      const binding = item.binding!;
      const inspect = item.inspect!;
      surfaceBindings[item.change.resourceId] = {
        ownerId: owner!.ownerId,
        ownerGeneration: owner!.generation,
        ownerRegistrationId: item.publication!.registrationId!,
        documentInstanceId: binding.documentInstanceId!,
        baseRevision: inspect.baseRevision,
        beforeLocalEditRevision: inspect.localEditRevision,
        beforeHash: binding.bufferHash!,
        encoding: binding.encoding ?? inspect.encoding,
        bom: binding.bom ?? inspect.bom,
        lineEnding: binding.lineEnding ?? item.lineEnding ?? "lf",
      };
      const placeholder: RecoveryState = { kind: "missing" };
      targets[item.change.resourceId] = { expected: placeholder, target: placeholder };
      safety[item.change.resourceId] = placeholder;
    }
    for (const item of toApplyDisk.filter((entry) => entry.class === "disk")) {
      const before = await captureDiskState(deps, item.change.resourceId);
      const current = await deps.readDisk(workspaceId, item.change.resourceId);
      const expectedRevision = item.change.expectedRevision;
      const expectedHash = item.change.expectedHash;
      const actualHash = current.status === "ready" && typeof current.content === "string"
        ? diskIdentityHash(current.content)
        : undefined;
      if ((expectedRevision !== undefined && expectedRevision !== (current.revision ?? null))
        || (expectedHash !== undefined && expectedHash !== actualHash)) {
        delete targetKinds[item.change.resourceId];
        item.class = "conflict";
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: "conflict",
          ...(current.revision === undefined ? {} : { revision: current.revision }),
          message: `${item.change.resourceId} changed after the patch source was read.`,
        };
        continue;
      }
      const state = before ?? { kind: current.status === "missing" ? "missing" : "unsupported" as const };
      item.diskBefore = {
        content: current.status === "ready" ? current.content ?? "" : "",
        revision: current.status === "ready" || current.status === "binary" || current.status === "unsupported-encoding"
          ? current.revision ?? null
          : null,
        encoding: current.status === "ready"
          ? current.encoding ?? "utf-8"
          : current.candidates?.[0] ?? (current.status === "unsupported-encoding" ? "unsupported" : current.encoding ?? "utf-8"),
        bom: current.status === "ready"
          ? current.bom ?? false
          : Boolean(current.candidates?.[0]?.startsWith("utf-16")),
        existed: current.status !== "missing",
        ...(before ? { state: before } : {}),
      };
      diskIdentities[item.change.resourceId] = {
        encoding: item.diskBefore.encoding,
        bom: item.diskBefore.bom,
        revision: item.diskBefore.revision,
        existed: item.diskBefore.existed,
      };
      targets[item.change.resourceId] = { expected: state, target: state };
      safety[item.change.resourceId] = state;
    }
    // A stale disk identity is a real conflict, so it must not be included in
    // the durable operation that will be dispatched for the remaining paths.
    if (Object.keys(targets).length === 0) return null;
    return beginAgentMutationOperationAsync(deps.durable, {
        operationId,
        sessionId: input.sessionId,
        workspaceId,
        targetKinds,
        surfaceBindings,
        diskIdentities,
        targets,
        safety,
      });
  };

  const compensate = async (): Promise<void> => {
    const compensateSignal = new AbortController().signal;
    const surfaceApplied = applied.filter((entry): entry is Extract<typeof applied[number], { kind: "surface" }> => (
      entry.kind === "surface"
    ));
    if (surfaceApplied.length > 0 && owner) {
      const registrationId = surfaceApplied[0]?.item.publication?.registrationId;
      if (!registrationId) {
        for (const entry of surfaceApplied) {
          entry.item.result = {
            path: entry.item.change.resourceId,
            target: "surface",
            status: "needs-attention",
            message: `${entry.item.change.resourceId} was written to the editor buffer but could not be compensated.`,
          };
          if (deps.durable && durable) {
            await markAgentMutationPathNeedsAttention(deps.durable, durable, entry.item.change.resourceId);
          }
        }
      } else {
        try {
          if (deps.durable && durable) {
            for (const entry of surfaceApplied) {
              await markAgentMutationSurfaceCompensateIntent(deps.durable, durable, entry.item.change.resourceId);
            }
          }
          const undone = await deps.requestSurfaceOperation({
            action: "undo",
            generation: owner.generation,
            operationId,
            ownerId: owner.ownerId,
            registrationId,
            workspaceId: owner.workspaceId,
            targets: surfaceApplied.map((entry) => {
              const binding = entry.item.binding!;
              const inspect = entry.item.inspect!;
              return {
                baseRevision: inspect.baseRevision,
                bufferHash: binding.bufferHash!,
                documentInstanceId: binding.documentInstanceId!,
                encoding: binding.encoding ?? inspect.encoding,
                bom: binding.bom ?? inspect.bom,
                lineEnding: binding.lineEnding ?? entry.item.lineEnding ?? "lf",
                localEditRevision: inspect.localEditRevision,
                expectedAppliedRevision: entry.receipt.afterLocalEditRevision!,
                expectedAppliedHash: entry.receipt.afterHash!,
                resource: { workspaceId: owner.workspaceId, resourceId: entry.item.change.resourceId },
              };
            }),
          }, { signal: compensateSignal });
          const byPath = new Map(undone.map((receipt) => [receipt.resource.resourceId, receipt]));
          for (const entry of surfaceApplied) {
            const receipt = [...byPath.entries()].find(([path]) => (
              sameResource(path, entry.item.change.resourceId)
            ))?.[1];
            const restored = receipt?.status === "undone"
              && receipt.afterHash === entry.item.binding!.bufferHash;
            if (restored) {
              entry.item.result = {
                path: entry.item.change.resourceId,
                target: "surface",
                status: "compensated",
                message: `${entry.item.change.resourceId} was restored to the editor buffer from before this mutation.`,
              };
              if (deps.durable && durable) {
                await markAgentMutationSurfaceCompensated(deps.durable, durable, entry.item.change.resourceId);
              }
            } else {
              entry.item.result = {
                path: entry.item.change.resourceId,
                target: "surface",
                status: "needs-attention",
                message: `${entry.item.change.resourceId} changed after it was written, so compensation left the live buffer untouched.`,
              };
              if (deps.durable && durable) {
                await markAgentMutationPathNeedsAttention(deps.durable, durable, entry.item.change.resourceId);
              }
            }
          }
        } catch {
          for (const entry of surfaceApplied) {
            if (entry.item.result?.status === "applied") {
              entry.item.result = {
                path: entry.item.change.resourceId,
                target: "surface",
                status: "needs-attention",
                message: `${entry.item.change.resourceId} changed after it was written, so compensation left the live buffer untouched.`,
              };
              if (deps.durable && durable) {
                await markAgentMutationPathNeedsAttention(deps.durable, durable, entry.item.change.resourceId);
              }
            }
          }
        }
      }
    }

    for (const entry of [...applied].reverse()) {
      if (entry.kind !== "disk") continue;
      if (deps.durable && durable && entry.before.state) {
        const outcome = await compensateAgentMutationDiskPath(deps.durable, durable, entry.item.change.resourceId, { gateHeld: true });
        entry.item.result = outcome === "compensated"
          ? {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "compensated",
              message: `${entry.item.change.resourceId} was restored on disk after a later path failed.`,
            }
          : {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "needs-attention",
              message: `${entry.item.change.resourceId} changed after it was written, so compensation left disk untouched.`,
            };
        continue;
      }
      if (!entry.before.existed) {
        const removed = await deps.deleteDisk({
          workspaceId,
          resourceId: entry.item.change.resourceId,
          expectedRevision: entry.item.result?.revision ?? "",
          token: await diskToken(deps, workspaceId),
          operationId: `${operationId}:compensate`,
        });
        entry.item.result = removed.status === "deleted"
          ? {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "compensated",
              message: `${entry.item.change.resourceId} was removed after a later path failed.`,
            }
          : {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "needs-attention",
              message: `${entry.item.change.resourceId} changed after it was written, so compensation left disk untouched.`,
            };
        continue;
      }
      const restored = await deps.writeDisk({
        workspaceId,
        resourceId: entry.item.change.resourceId,
        content: entry.before.content,
        encoding: entry.before.encoding,
        bom: entry.before.bom,
        expectedRevision: entry.item.result?.revision ?? null,
        token: await diskToken(deps, workspaceId),
        operationId: `${operationId}:compensate`,
      });
      entry.item.result = restored.status === "written"
        ? pathResult({
            path: entry.item.change.resourceId,
            target: "disk",
            status: "compensated",
            revision: restored.revision,
            message: `${entry.item.change.resourceId} was restored on disk after a later path failed.`,
          })
        : {
            path: entry.item.change.resourceId,
            target: "disk",
            status: "needs-attention",
            message: `${entry.item.change.resourceId} changed after it was written, so compensation left disk untouched.`,
          };
    }
    applied.length = 0;
  };

  const executeMutation = async (): Promise<{ result: DocumentSurfaceWriteResult; record: AgentMutationRecord | null }> => {
  let failed = false;
  try {
    if (toApplySurface.length > 0 || toApplyDisk.some((entry) => entry.class === "disk")) {
      durable = await persistIntent();
    }
    if (toApplyDisk.some((entry) => entry.class !== "disk" && entry.result)) {
      // A path that failed its source identity check is part of the same
      // mutation. Compensate any surface paths already applied instead of
      // reporting a durable operation as complete with a partial write.
      failed = true;
    }
    if (!failed && toApplySurface.length > 0 && owner && publication?.registrationId) {
      input.signal?.throwIfAborted();
      if (deps.durable && durable) {
        for (const item of toApplySurface) {
          await markAgentMutationSurfaceDispatched(deps.durable, durable, item.change.resourceId);
          surfaceDispatched = true;
        }
      }
      const receipts = await deps.requestSurfaceOperation({
        action: "apply",
        generation: owner.generation,
        operationId,
        ownerId: owner.ownerId,
        registrationId: publication.registrationId,
        workspaceId: owner.workspaceId,
        targets: toApplySurface.map((item) => {
          const binding = item.binding!;
          const inspect = item.inspect!;
          return {
            baseRevision: inspect.baseRevision,
            bufferHash: binding.bufferHash!,
            documentInstanceId: binding.documentInstanceId!,
            encoding: binding.encoding ?? inspect.encoding,
            bom: binding.bom ?? inspect.bom,
            lineEnding: binding.lineEnding ?? item.lineEnding ?? "lf",
            localEditRevision: inspect.localEditRevision,
            newText: item.editorText ?? normalizeEditorLineEndings(item.newText!),
            resource: { workspaceId: owner.workspaceId, resourceId: item.change.resourceId },
          };
        }),
      }, input.signal ? { signal: input.signal } : {});
      const byPath = new Map(receipts.map((receipt) => [receipt.resource.resourceId, receipt]));
      for (const item of toApplySurface) {
        const receipt = [...byPath.entries()].find(([path]) => sameResource(path, item.change.resourceId))?.[1];
        if (receipt?.status === "applied" && receipt.afterLocalEditRevision !== undefined) {
          item.result = {
            path: item.change.resourceId,
            target: "surface",
            status: "applied",
            revision: `surface-draft:${input.context.source === "surface" && input.context.snapshot.status === "ready"
              ? input.context.snapshot.ref
              : "applied"}:${receipt.afterLocalEditRevision}`,
        };
        applied.push({ kind: "surface", item, receipt });
          if (deps.durable && durable) {
            await markAgentMutationPathApplied(deps.durable, durable, item.change.resourceId, {
              afterLocalEditRevision: receipt.afterLocalEditRevision,
              ...(receipt.afterHash === undefined ? {} : { afterHash: receipt.afterHash }),
            });
          }
          continue;
        }
        item.result = pathResult({
          path: item.change.resourceId,
          target: "surface",
          status: "conflict",
          revision: item.inspect?.revision,
          message: receipt?.message
            ?? `${item.change.resourceId} could not be written to the editor buffer.`,
        });
        failed = true;
        if (deps.durable && durable) {
          if (receipt) {
            await markAgentMutationSurfaceNotApplied(deps.durable, durable, item.change.resourceId);
          } else {
            await markAgentMutationPathNeedsAttention(
              deps.durable,
              durable,
              item.change.resourceId,
              `${item.change.resourceId} surface receipt was not returned`,
            );
            item.result = { ...item.result, status: "needs-attention" };
          }
        }
      }
    }
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    preparationError = message;
    for (const item of toApplySurface) {
      if (!item.result) {
        item.result = pathResult({
          path: item.change.resourceId,
          target: "surface",
          status: "conflict",
          revision: item.inspect?.revision,
          message: /stale|changed|disconnected|binding|aborted/iu.test(message)
            ? `${item.change.resourceId} changed in the editor after this turn fixed its draft. `
              + "The live buffer was left untouched and nothing was written to disk."
            : message,
        });
      }
      if (deps.durable && durable && surfaceDispatched && !item.result?.status?.startsWith("applied")) {
        await markAgentMutationPathNeedsAttention(deps.durable, durable, item.change.resourceId, message);
        if (item.result) item.result = { ...item.result, status: "needs-attention" };
      }
    }
  }
  if (failed) await compensate();

  if (!failed && toApplyDisk.some((entry) => entry.class === "disk")) {
    const token = await diskToken(deps, workspaceId);
        for (const item of toApplyDisk.filter((entry) => entry.class === "disk")) {
      try {
        input.signal?.throwIfAborted();
        if (item.change.action === "delete") {
          const current = await deps.readDisk(workspaceId, item.change.resourceId);
          const expectedHash = item.change.expectedHash;
          const actualHash = current.status === "ready" && typeof current.content === "string"
            ? diskIdentityHash(current.content)
            : undefined;
          if ((item.change.expectedRevision !== undefined
            && item.change.expectedRevision !== (current.revision ?? null))
            || (expectedHash !== undefined && expectedHash !== actualHash)) {
            item.result = {
              path: item.change.resourceId,
              target: "disk",
              status: "conflict",
              ...(current.revision === undefined ? {} : { revision: current.revision }),
              message: `${item.change.resourceId} changed after the patch source was read.`,
            };
            failed = true;
            await compensate();
            break;
          }
          if (current.status !== "ready" || !current.revision) {
            item.result = {
              path: item.change.resourceId,
              target: "disk",
              status: current.status === "missing" ? "conflict" : "unavailable",
              message: `${item.change.resourceId} is not a writable text file on disk.`,
            };
            failed = true;
            await compensate();
            break;
          }
          const deleted = await deps.deleteDisk({
            workspaceId,
            resourceId: item.change.resourceId,
            expectedRevision: current.revision,
            token,
            operationId,
          });
          if (deleted.status !== "deleted") {
            item.result = {
              path: item.change.resourceId,
              target: "disk",
              status: deleted.status === "conflict" ? "conflict" : "unavailable",
              message: deleted.message ?? `${item.change.resourceId} could not be deleted on disk.`,
            };
            failed = true;
            await compensate();
            break;
          }
          const before = item.diskBefore ?? {
            content: current.content ?? "",
            revision: current.revision,
            encoding: current.encoding ?? "utf-8",
            bom: current.bom ?? false,
            existed: true,
            ...(await captureDiskState(deps, item.change.resourceId).then((state) => (
              state ? { state } : {}
            ))),
          };
          item.diskBefore = before;
          const after = deps.durable
            ? await captureDiskState(deps, item.change.resourceId)
            : undefined;
          item.result = { path: item.change.resourceId, target: "disk", status: "applied" };
          applied.push({ kind: "disk", item, before });
          if (deps.durable && durable) {
            await markAgentMutationPathApplied(deps.durable, durable, item.change.resourceId, {
              target: after ?? { kind: "missing" },
            });
          }
          continue;
        }
        let nextText = item.change.content;
        const current = await deps.readDisk(workspaceId, item.change.resourceId);
        const actualHash = current.status === "ready" && typeof current.content === "string"
          ? diskIdentityHash(current.content)
          : undefined;
        if ((item.change.expectedRevision !== undefined
          && item.change.expectedRevision !== (current.revision ?? null))
          || (item.change.expectedHash !== undefined && item.change.expectedHash !== actualHash)) {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "conflict",
            ...(current.revision === undefined ? {} : { revision: current.revision }),
            message: `${item.change.resourceId} changed after the patch source was read.`,
          };
          failed = true;
          await compensate();
          break;
        }
        if (item.change.action === "edit") {
          if (current.status !== "ready" || typeof current.content !== "string") {
            item.result = {
              path: item.change.resourceId,
              target: "disk",
              status: current.status === "unsupported-encoding" || current.status === "binary"
                ? "unavailable"
                : "conflict",
              message: `${item.change.resourceId} is not a writable text file on disk.`,
            };
            failed = true;
            await compensate();
            break;
          }
          try {
            nextText = applySurfaceEdits(
              current.content,
              item.change.edits ?? [],
              detectLineEnding(current.content),
            );
          } catch (error) {
            item.result = {
              path: item.change.resourceId,
              target: "disk",
              status: "conflict",
              message: error instanceof Error ? error.message : String(error),
            };
            failed = true;
            await compensate();
            break;
          }
        }
        if (typeof nextText !== "string") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "unavailable",
            message: "write requires text content",
          };
          failed = true;
          await compensate();
          break;
        }
        if (isBinaryText(nextText) || current.status === "binary") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "unavailable",
            message: `${item.change.resourceId} is not a text file.`,
          };
          failed = true;
          await compensate();
          break;
        }
        const encoding = current.status === "ready" ? current.encoding ?? "utf-8" : "utf-8";
        const bom = current.status === "ready" ? current.bom ?? false : false;
        if (current.status === "unsupported-encoding" && item.change.action === "edit") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "unavailable",
            message: `${item.change.resourceId} is not a writable text file on disk.`,
          };
          failed = true;
          await compensate();
          break;
        }
        const written = await deps.writeDisk({
          workspaceId,
          resourceId: item.change.resourceId,
          content: nextText,
          encoding: current.status === "unsupported-encoding" ? "utf-8" : encoding,
          bom: current.status === "unsupported-encoding" ? false : bom,
          expectedRevision: current.status === "ready" || current.status === "unsupported-encoding"
            ? current.revision ?? null
            : current.status === "missing" ? null : current.revision ?? null,
          token,
          operationId,
        });
        if (written.status !== "written") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: written.status === "conflict" ? "conflict" : "unavailable",
            message: written.message ?? `${item.change.resourceId} could not be written on disk.`,
          };
          failed = true;
          await compensate();
          break;
        }
        const after = await captureDiskState(deps, item.change.resourceId);
        const before = item.diskBefore ?? {
          content: current.status === "ready" ? current.content ?? "" : "",
          revision: current.status === "ready" || current.status === "unsupported-encoding"
            ? current.revision ?? null
            : null,
          encoding: current.encoding ?? "utf-8",
          bom: current.bom ?? false,
          existed: current.status !== "missing",
        };
        item.diskBefore = before;
        item.result = pathResult({
          path: item.change.resourceId,
          target: "disk",
          status: "applied",
          revision: written.revision,
        });
        applied.push({ kind: "disk", item, before });
        if (deps.durable && durable) {
          await markAgentMutationPathApplied(deps.durable, durable, item.change.resourceId, {
            ...(after ? { target: after } : {}),
          });
        }
      } catch (error) {
        failed = true;
        if (!item.result) {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "conflict",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        await compensate();
        break;
      }
    }
  } else if (failed) {
    for (const item of toApplyDisk) {
      if (!item.result) {
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: preparationError ? "unavailable" : "conflict",
          message: preparationError ?? `${item.change.resourceId} was not written because an earlier path in this mutation failed.`,
        };
      }
    }
  }

  const result = summarize(planned, operationId);
  if (deps.durable && durable) {
    await finalizeAgentMutationOperation(deps.durable, durable, result.status === "disk" ? [] : result.results);
  }
  const record: AgentMutationRecord = {
    operationId,
    sessionId: input.sessionId,
    workspaceId,
    targetKinds: Object.fromEntries(planned.map((item) => [
      item.change.resourceId,
      item.result?.target ?? (item.class === "disk" ? "disk" : "surface"),
    ])),
    results: result.status === "disk" ? [] : result.results,
  };
  return { result, record };
  };
  if (deps.durable && toApplyDisk.some((entry) => entry.class === "disk")) {
    return deps.durable.resourceOperationGate.run(
      // The nested Documents write/delete owns this path's subtree (type
      // replacement can remove children). Acquire the same directional scope
      // up front; an exact read lease cannot authorize that mutation.
      toApplyDisk.filter((entry) => entry.class === "disk").map((item) => ({ resourceId: item.change.resourceId, scope: "subtree" as const })),
      executeMutation,
    );
  }
  return executeMutation();
}
