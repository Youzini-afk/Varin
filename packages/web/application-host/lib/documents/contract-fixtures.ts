import { createHash } from 'node:crypto';
import { normalizeEditorLineEndings } from './line-ending.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentAuthorityOptions,
  type ResolveWorkspaceResult,
} from './authority.js';

interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

interface DocumentTokenOwner {
  kind: string;
  id: string;
}

interface DocumentToken {
  workspaceId: string;
  epoch: number;
  owner: DocumentTokenOwner;
}

export interface DocumentAuthorityHarnessOverrides {
  trusted?: boolean | undefined;
  allowedRoot?: string | undefined;
  hostId?: string | undefined;
  overflowLimit?: number | undefined;
  authority?: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> | undefined;
}

export interface DocumentAuthorityHarness {
  authority: DocumentAuthority;
  identity: ResolveWorkspaceResult;
  root: string;
  workspaceRoot: string;
  dataDir: string;
  setTrusted: (value: boolean) => void;
  resource: (resourceId: string) => DocumentResource;
  token: (epoch?: number, owner?: DocumentTokenOwner) => DocumentToken;
  cleanup: () => Promise<void>;
}

export const createDocumentAuthorityHarness = async (
  overrides: DocumentAuthorityHarnessOverrides = {},
): Promise<DocumentAuthorityHarness> => {
  // Runner temp directories can be junctions; use the same canonical paths as Documents.
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-documents-')));
  const workspaceRoot = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  let trusted: boolean = overrides.trusted ?? true;
  const allowedRootInput = overrides.allowedRoot ?? workspaceRoot;
  const allowedRoot = await fs.promises.realpath(allowedRootInput);
  const authority = createDocumentAuthority({
    hostId: overrides.hostId ?? '11111111-1111-4111-8111-111111111111',
    dataDir,
    isTrusted: async () => trusted,
    isAllowedRoot: async (candidate: string) => {
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      const allowed = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot;
      return normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`);
    },
    overflowLimit: overrides.overflowLimit ?? 256,
    ...(overrides.authority ?? {}),
  });
  const identity = await authority.resolveWorkspace({ path: workspaceRoot });
  return {
    authority,
    identity,
    root,
    workspaceRoot,
    dataDir,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    resource: (resourceId: string) => ({ workspaceId: identity.workspaceId, resourceId }),
    token: (
      epoch: number = identity.epoch,
      owner: DocumentTokenOwner = { kind: 'test', id: 'document-contract' },
    ) => ({
      workspaceId: identity.workspaceId,
      epoch,
      owner,
    }),
    async cleanup() {
      await authority.dispose();
      // Windows keeps a directory handle open until every child process that touched it has fully
      // exited, so removal races with process teardown and fails with EBUSY. `force` only ignores
      // a missing path, so ask for the retry backoff that covers a busy one.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
};

export const hashSurfaceText = (text: string): string => (
  `sha256-${createHash('sha256').update(normalizeEditorLineEndings(text), 'utf8').digest('hex')}`
);

export interface LiveSurfaceBuffer {
  baseRevision: string | null;
  bom: boolean;
  bufferHash: string;
  content: string;
  documentInstanceId: string;
  encoding: string;
  lineEnding: 'lf' | 'crlf' | 'cr';
  localEditRevision: number;
  previousContent?: string;
}

/**
 * Completes Host-directed surface operations the way Document Registry does:
 * CAS against the live buffer identity, then apply/undo. Failed CAS leaves the
 * live text untouched so later user edits cannot be rolled back.
 */
export const attachLiveSurfaceCompleter = (
  authority: DocumentAuthority,
  input: {
    generation: number;
    live: Map<string, LiveSurfaceBuffer>;
    ownerId: string;
    workspaceId: string;
  },
): { close: () => void } => {
  const undoGroups = new Map<string, {
    documents: Array<{ resourceId: string; before: LiveSurfaceBuffer }>;
    consumed: boolean;
  }>();
  return authority.registerDirtySurface({
  generation: input.generation,
  ownerId: input.ownerId,
  workspaceId: input.workspaceId,
}, (event) => {
  const requestId = event && typeof event === 'object' && 'requestId' in event
    ? String((event as { requestId?: unknown }).requestId ?? '')
    : '';
  if (!requestId) return;
  void (async () => {
    const pending = await authority.readSurfaceOperation({
      generation: input.generation,
      ownerId: input.ownerId,
      requestId,
      workspaceId: input.workspaceId,
    });
    const failed = (message: string) => pending.targets.map((target) => {
      const current = input.live.get(target.resource.resourceId);
      return {
        resource: target.resource,
        status: 'failed' as const,
        message,
        ...(current ? {
          documentInstanceId: current.documentInstanceId,
          afterLocalEditRevision: current.localEditRevision,
          afterHash: current.bufferHash,
        } : {}),
      };
    });
    let resources;
    if (pending.action === 'undo') {
      const group = undoGroups.get(pending.operationId);
      if (!group || group.consumed) {
        resources = failed('The surface undo baseline is unavailable');
      } else {
        const casFailed = pending.targets.some((target) => {
          const current = input.live.get(target.resource.resourceId);
          return !current
            || current.localEditRevision !== target.expectedAppliedRevision
            || current.bufferHash !== target.expectedAppliedHash;
        });
        if (casFailed) {
          resources = failed('Document surface binding changed after apply');
        } else {
          resources = group.documents.map((document) => {
            const current = input.live.get(document.resourceId)!;
            const restored = document.before;
            const next: LiveSurfaceBuffer = {
              ...restored,
              localEditRevision: current.localEditRevision + 1,
              bufferHash: hashSurfaceText(restored.content),
            };
            input.live.set(document.resourceId, next);
            return {
              resource: { workspaceId: input.workspaceId, resourceId: document.resourceId },
              status: 'undone' as const,
              documentInstanceId: next.documentInstanceId,
              content: normalizeEditorLineEndings(next.content),
              afterLocalEditRevision: next.localEditRevision,
              afterHash: next.bufferHash,
            };
          });
          group.consumed = true;
        }
      }
    } else {
      resources = pending.targets.map((target) => {
        const current = input.live.get(target.resource.resourceId);
        if (pending.action === 'apply') {
          if (!current
            || current.documentInstanceId !== target.documentInstanceId
            || current.localEditRevision !== target.localEditRevision
            || current.bufferHash !== target.bufferHash
            || current.baseRevision !== target.baseRevision) {
            return {
              resource: target.resource,
              status: 'failed' as const,
              message: 'Document surface binding changed',
              ...(current ? {
                documentInstanceId: current.documentInstanceId,
                afterLocalEditRevision: current.localEditRevision,
                afterHash: current.bufferHash,
              } : {}),
            };
          }
          const nextContent = normalizeEditorLineEndings(target.newText ?? current.content);
          const next: LiveSurfaceBuffer = {
            ...current,
            content: nextContent,
            previousContent: current.content,
            localEditRevision: current.localEditRevision + 1,
            bufferHash: hashSurfaceText(nextContent),
          };
          input.live.set(target.resource.resourceId, next);
          return {
            resource: target.resource,
            status: 'applied' as const,
            documentInstanceId: current.documentInstanceId,
            beforeLocalEditRevision: current.localEditRevision,
            beforeHash: current.bufferHash,
            afterLocalEditRevision: next.localEditRevision,
            afterHash: next.bufferHash,
          };
        }
        if (!current) {
          return { resource: target.resource, status: 'failed' as const, message: 'No live buffer' };
        }
        return {
          resource: target.resource,
          status: 'captured' as const,
          content: current.content,
          documentInstanceId: current.documentInstanceId,
          beforeLocalEditRevision: current.localEditRevision,
          beforeHash: current.bufferHash,
        };
      });
      if (pending.action === 'apply' && resources.every((resource) => resource.status === 'applied')) {
        undoGroups.set(pending.operationId, {
          consumed: false,
          documents: pending.targets.map((target) => ({
            resourceId: target.resource.resourceId,
            before: {
              ...input.live.get(target.resource.resourceId)!,
              content: input.live.get(target.resource.resourceId)!.previousContent
                ?? input.live.get(target.resource.resourceId)!.content,
              localEditRevision: target.localEditRevision,
              bufferHash: target.bufferHash,
            },
          })),
        });
      }
    }
    await authority.completeSurfaceOperation({
      generation: input.generation,
      operationId: pending.operationId,
      ownerId: input.ownerId,
      requestId,
      resources,
      workspaceId: input.workspaceId,
    });
  })().catch(() => undefined);
});
};
