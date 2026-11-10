import type { VarinTextFormat } from "@varin/application-client";
import { createHash } from "node:crypto";
import { sameState, stateIdentity, type RecoveryState } from "../../recovery/journal-files.js";

export interface DirtyBufferInspectResource {
  baseFormat?: VarinTextFormat;
  normalizeLineEndings?: boolean;
  resourceId: string;
  baseRevision: string | null;
  localEditRevision: number;
  ownerId: string;
  generation: number;
  registrationId: string;
  documentInstanceId: string;
  bufferHash: string;
  encoding: string;
  bom: boolean;
  lineEnding: "lf" | "crlf" | "cr";
}

/** Matches Documents `DirtyBufferPublication` without importing authority. */
export interface DirtyBufferInspectPublication {
  ownerId: string;
  generation: number;
  registrationId?: string;
  resources: Array<{
    sourceFormat?: VarinTextFormat;
    baseFormat?: VarinTextFormat;
    normalizeLineEndings?: boolean;
    baseRevision: string | null;
    localEditRevision: number;
    resource: { resourceId: string };
    documentInstanceId?: string;
    bufferHash?: string;
    encoding?: string;
    bom?: boolean;
    lineEnding?: "lf" | "crlf" | "cr";
  }>;
}

export type IntegrationParentTarget = "disk" | "surface" | "unavailable";

export const dirtyResourceMap = (
  publications: readonly DirtyBufferInspectPublication[],
): Map<string, DirtyBufferInspectResource[]> => {
  const found = new Map<string, DirtyBufferInspectResource[]>();
  for (const publication of publications) {
    for (const resource of publication.resources) {
      const resourceId = resource.resource.resourceId;
      if (!publication.registrationId || !resource.documentInstanceId || !resource.bufferHash
        || !resource.encoding || typeof resource.bom !== "boolean" || !resource.lineEnding) continue;
      const owners = found.get(resourceId) ?? [];
      owners.push({
          resourceId,
          ...((resource.baseFormat ?? resource.sourceFormat) ? { baseFormat: resource.baseFormat ?? resource.sourceFormat } : {}),
          ...(resource.normalizeLineEndings === undefined ? {} : { normalizeLineEndings: resource.normalizeLineEndings }),
          baseRevision: resource.baseRevision,
          localEditRevision: resource.localEditRevision,
          ownerId: publication.ownerId,
          generation: publication.generation,
          registrationId: publication.registrationId,
          documentInstanceId: resource.documentInstanceId,
          bufferHash: resource.bufferHash,
          encoding: resource.encoding,
          bom: resource.bom,
          lineEnding: resource.lineEnding,
      });
      found.set(resourceId, owners);
    }
  }
  for (const owners of found.values()) owners.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  return found;
};

export const selectDirtyResource = (
  candidates: readonly DirtyBufferInspectResource[] | undefined,
  sourceOwner?: { ownerId: string; generation: number },
): { status: "selected"; resource: DirtyBufferInspectResource } | { status: "none" | "ambiguous" } => {
  if (!candidates?.length) return { status: "none" };
  if (sourceOwner) {
    const owned = candidates.filter((candidate) => (
      candidate.ownerId === sourceOwner.ownerId && candidate.generation === sourceOwner.generation
    ));
    return owned.length === 1 ? { status: "selected", resource: owned[0]! } : { status: "ambiguous" };
  }
  return candidates.length === 1
    ? { status: "selected", resource: candidates[0]! }
    : { status: "ambiguous" };
};

export const classifyIntegrationTarget = (input: {
  draftBasePath: boolean;
  dirty?: DirtyBufferInspectResource;
  inspectDirtyBuffers: boolean;
  parentState: RecoveryState;
  baseState: RecoveryState;
  childState: RecoveryState;
}): IntegrationParentTarget => {
  if (input.dirty) return "surface";
  if (input.inspectDirtyBuffers) {
    if (!input.draftBasePath) return "disk";
    if (sameState(input.parentState, input.baseState) || sameState(input.parentState, input.childState)) return "disk";
    return "unavailable";
  }
  if (
    input.draftBasePath
    && !sameState(input.parentState, input.baseState)
    && !sameState(input.parentState, input.childState)
  ) {
    return "surface";
  }
  return "disk";
};

export const parentRevisionOf = (state: RecoveryState, dirty?: DirtyBufferInspectResource): string => {
  if (dirty) return `surface:${dirty.ownerId}:${dirty.generation}:${dirty.registrationId}:${dirty.documentInstanceId}:${dirty.localEditRevision}:${dirty.baseRevision ?? "none"}:${dirty.bufferHash}:${dirty.encoding}:${dirty.bom ? 1 : 0}:${dirty.lineEnding}`;
  return `disk:${createHash("sha256").update(stateIdentity(state)).digest("hex")}`;
};
