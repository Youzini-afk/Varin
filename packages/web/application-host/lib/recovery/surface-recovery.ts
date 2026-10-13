import { createHash } from 'node:crypto';
import type { DocumentSurfaceBinding, DocumentSurfaceOperationRequest, DocumentSurfaceOperationResult } from '../documents/authority.js';
import { inspectDocumentBytes, revisionFromBytes } from '../documents/inspect.js';
import { detectLineEnding, normalizeEditorLineEndings } from '../documents/line-ending.js';
import { RecoveryPrimitiveError } from './errors.js';
import { parseRecoveryState, type RecoveryFileStore, type RecoveryIdentity, type RecoveryState, type RegularFileState } from './journal-files.js';

export interface RecoverySurfaceOwner {
  ownerId: string;
  generation: number;
  registrationId: string;
  workspaceId: string;
}

interface SavedSurfaceText {
  content: RegularFileState;
  baseContent: RegularFileState;
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
}

export interface RecoverySurfaceTarget extends RecoverySurfaceOwner {
  binding: DocumentSurfaceBinding;
  text: SavedSurfaceText;
}

export interface RecoverySurfaceSafety extends RecoverySurfaceTarget {
  target: SavedSurfaceText;
  phase: 'captured' | 'apply-intent' | 'applied' | 'compensate-intent' | 'compensated';
  appliedBinding?: DocumentSurfaceBinding;
}

export type CombinedRecoverySafety = RecoveryState & { surfaces?: RecoverySurfaceSafety[] };
export type CombinedRecoveryTarget = RecoveryState & { surfaceTargets?: RecoverySurfaceTarget[] };

const regular = (value: unknown): RegularFileState => {
  const state = parseRecoveryState(value);
  if (state.kind !== 'regular-file') throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery content is malformed', { origin: 'storage' });
  return state;
};

const savedText = (value: SavedSurfaceText): SavedSurfaceText => {
  if (!value || (value.baseRevision !== null && typeof value.baseRevision !== 'string')
    || value.encoding !== 'utf-8' || typeof value.bom !== 'boolean'
    || !['lf', 'crlf', 'cr'].includes(value.lineEnding)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery base is malformed', { origin: 'storage' });
  }
  return { ...value, content: regular(value.content), baseContent: regular(value.baseContent) };
};

const surfaceTarget = (value: RecoverySurfaceTarget): RecoverySurfaceTarget => {
  const binding = value?.binding;
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.registrationId !== 'string' || !value.registrationId
    || typeof value.workspaceId !== 'string' || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !binding || binding.resource?.workspaceId !== value.workspaceId || typeof binding.resource.resourceId !== 'string'
    || typeof binding.documentInstanceId !== 'string' || !binding.documentInstanceId
    || !Number.isSafeInteger(binding.localEditRevision) || binding.localEditRevision < 0
    || !/^sha256-[0-9a-f]{64}$/u.test(binding.bufferHash)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery owner is malformed', { origin: 'storage' });
  }
  return { ...value, text: savedText(value.text) };
};

export const parseCombinedSafety = (value: unknown): CombinedRecoverySafety => {
  const state = parseRecoveryState(value);
  const surfaces = (value as CombinedRecoverySafety).surfaces;
  if (surfaces === undefined) return state;
  if (!Array.isArray(surfaces)) throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery safety is malformed', { origin: 'storage' });
  return { ...state, surfaces: surfaces.map(surface => {
    if (!['captured', 'apply-intent', 'applied', 'compensate-intent', 'compensated'].includes(surface.phase)) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery phase is malformed', { origin: 'storage' });
    }
    return { ...surfaceTarget(surface), target: savedText(surface.target), phase: surface.phase,
      ...(surface.appliedBinding ? { appliedBinding: surface.appliedBinding } : {}) };
  }) };
};

export const parseCombinedTarget = (value: unknown): CombinedRecoveryTarget => {
  const state = parseRecoveryState(value);
  const surfaceTargets = (value as CombinedRecoveryTarget).surfaceTargets;
  if (surfaceTargets === undefined) return state;
  if (!Array.isArray(surfaceTargets)) throw new RecoveryPrimitiveError('storage-malformed', 'Editor recovery targets are malformed', { origin: 'storage' });
  return { ...state, surfaceTargets: surfaceTargets.map(surfaceTarget) };
};

export const surfaceOwnerKey = (owner: Pick<RecoverySurfaceTarget, 'ownerId' | 'binding'>): string => `${owner.ownerId}\0${owner.binding.documentInstanceId}`;
const hashText = (text: string): string => `sha256-${createHash('sha256').update(normalizeEditorLineEndings(text), 'utf8').digest('hex')}`;

export const createSurfaceRecovery = (fileStore: RecoveryFileStore, requestSurfaceOperation?: (
  request: DocumentSurfaceOperationRequest,
) => Promise<DocumentSurfaceOperationResult[]>) => {
  const requireStore = () => {
    if (!fileStore.readContent || !fileStore.storeContent || !requestSurfaceOperation) {
      throw new RecoveryPrimitiveError('dirty-state-unavailable', 'Editor recovery content or owner is unavailable', { origin: 'conflict', retryable: true });
    }
    return { read: fileStore.readContent.bind(fileStore), store: fileStore.storeContent.bind(fileStore), request: requestSurfaceOperation };
  };
  const read = async (identity: RecoveryIdentity, state: RegularFileState) => {
    const bytes = await requireStore().read(identity, state);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const capture = async (operationId: string, barrierId: string, owner: RecoverySurfaceOwner, binding: DocumentSurfaceBinding) => {
    let result: DocumentSurfaceOperationResult | undefined;
    try {
      [result] = await requireStore().request({ ownerId: owner.ownerId, generation: owner.generation,
        registrationId: owner.registrationId, workspaceId: owner.workspaceId,
        operationId, barrierId, action: 'capture', targets: [binding] });
    } catch (error) {
      if ((error as { code?: string })?.code === 'stale-completion') {
        throw new RecoveryPrimitiveError('stale-plan', 'Editor changed after recovery was confirmed', { cause: error, origin: 'conflict', retryable: true });
      }
      throw error;
    }
    if (result?.status !== 'captured' || result.documentInstanceId !== binding.documentInstanceId
      || result.beforeLocalEditRevision !== binding.localEditRevision || result.beforeHash !== binding.bufferHash
      || typeof result.content !== 'string' || hashText(result.content) !== binding.bufferHash
      || typeof result.baseContent !== 'string') {
      throw new RecoveryPrimitiveError('stale-plan', result?.message ?? 'Editor changed after recovery was confirmed', { origin: 'conflict', retryable: true });
    }
    return result as DocumentSurfaceOperationResult & { content: string; baseContent: string };
  };
  const diskText = async (identity: RecoveryIdentity, state: RecoveryState, store: (bytes: Buffer) => Promise<RegularFileState>): Promise<SavedSurfaceText> => {
    let content = '';
    let baseRevision: string | null = null;
    let bom = false;
    if (state.kind === 'regular-file') {
      const bytes = await requireStore().read(identity, state);
      const inspected = inspectDocumentBytes(bytes);
      if (inspected.kind !== 'text') throw new RecoveryPrimitiveError('unsupported-metadata', 'This recovery target cannot be represented in a text editor', { origin: 'conflict' });
      content = inspected.content;
      baseRevision = revisionFromBytes(bytes);
      bom = inspected.bom;
    } else if (state.kind !== 'missing') {
      throw new RecoveryPrimitiveError('unsupported-metadata', 'This recovery target is not an editable file', { origin: 'conflict' });
    }
    const stored = await store(Buffer.from(normalizeEditorLineEndings(content), 'utf8'));
    return { content: stored, baseContent: stored, baseRevision, encoding: 'utf-8', bom, lineEnding: detectLineEnding(content) };
  };
  const expectedApplied = (surface: RecoverySurfaceSafety): DocumentSurfaceBinding => ({ ...surface.binding,
    baseRevision: surface.target.baseRevision, encoding: surface.target.encoding, bom: surface.target.bom, lineEnding: surface.target.lineEnding,
    localEditRevision: surface.binding.localEditRevision + 1, bufferHash: surface.target.content.objectHash,
  });
  const expectedCompensated = (surface: RecoverySurfaceSafety): DocumentSurfaceBinding => ({ ...surface.binding,
    localEditRevision: (surface.appliedBinding ?? expectedApplied(surface)).localEditRevision + 1,
  });
  const observe = async (operationId: string, barrierId: string, surface: RecoverySurfaceSafety): Promise<void> => {
    if (surface.phase !== 'apply-intent' && surface.phase !== 'compensate-intent') return;
    const candidates = surface.phase === 'apply-intent'
      ? [{ binding: expectedApplied(surface), phase: 'applied' as const }, { binding: surface.binding, phase: 'captured' as const }]
      : [{ binding: expectedCompensated(surface), phase: 'compensated' as const }, { binding: surface.appliedBinding ?? expectedApplied(surface), phase: 'applied' as const }];
    for (const candidate of candidates) {
      try {
        await capture(operationId, barrierId, surface, candidate.binding);
        surface.phase = candidate.phase;
        if (candidate.phase === 'applied') surface.appliedBinding = candidate.binding;
        return;
      } catch (error) {
        if (!(error instanceof RecoveryPrimitiveError && error.code === 'stale-plan')) throw error;
      }
    }
    throw new RecoveryPrimitiveError('needs-attention', 'The editor no longer matches either recorded recovery state', { origin: 'conflict' });
  };
  const replace = async (identity: RecoveryIdentity, operationId: string, barrierId: string, surface: RecoverySurfaceSafety,
    direction: 'apply' | 'compensate', save: () => Promise<void>) => {
    await observe(operationId, barrierId, surface);
    if (direction === 'apply' && surface.phase === 'applied') return;
    if (direction === 'compensate' && (surface.phase === 'captured' || surface.phase === 'compensated')) return;
    const binding = direction === 'apply' ? surface.binding : surface.appliedBinding!;
    const text = direction === 'apply' ? surface.target : surface.text;
    const newText = await read(identity, text.content);
    const baseContent = await read(identity, text.baseContent);
    surface.phase = direction === 'apply' ? 'apply-intent' : 'compensate-intent';
    await save();
    const [result] = await requireStore().request({ ownerId: surface.ownerId, generation: surface.generation,
      registrationId: surface.registrationId, workspaceId: surface.workspaceId,
      operationId, barrierId, action: 'restore', targets: [{ ...binding,
      newText, restoreState: { baseContent, baseRevision: text.baseRevision, encoding: text.encoding, bom: text.bom, lineEnding: text.lineEnding },
    }] });
    if (result?.status !== 'restored') {
      // Only an exact unchanged receipt closes a dispatched intent. Transport
      // failure leaves it pending for observation rather than replaying input.
      if (result?.status === 'failed' && result.documentInstanceId === binding.documentInstanceId
        && result.afterLocalEditRevision === binding.localEditRevision && result.afterHash === binding.bufferHash) {
        surface.phase = direction === 'apply' ? 'captured' : 'applied';
        await save();
      }
      throw new RecoveryPrimitiveError('stale-plan', result?.message ?? 'Editor recovery was not confirmed', { origin: 'conflict', retryable: true });
    }
    if (result.documentInstanceId !== binding.documentInstanceId || result.beforeHash !== binding.bufferHash
      || result.beforeLocalEditRevision !== binding.localEditRevision || result.afterLocalEditRevision !== binding.localEditRevision + 1
      || result.afterHash !== hashText(newText)) {
      throw new RecoveryPrimitiveError('needs-attention', 'Editor recovery receipt changed its binding', { origin: 'conflict' });
    }
    if (direction === 'apply') surface.appliedBinding = expectedApplied(surface);
    surface.phase = direction === 'apply' ? 'applied' : 'compensated';
    await save();
  };
  return {
    async prepare(identity: RecoveryIdentity, operationId: string, barrierId: string, owner: RecoverySurfaceOwner,
      binding: DocumentSurfaceBinding, diskTarget: RecoveryState, textTarget?: SavedSurfaceText): Promise<{ safety: RecoverySurfaceSafety; release(): Promise<void> }> {
      const captured = await capture(operationId, barrierId, owner, binding);
      const leases: Array<{ release(): Promise<void> }> = [];
      const release = async () => {
        const results = await Promise.allSettled(leases.map(lease => lease.release()));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      };
      const store = async (bytes: Buffer) => {
        const lease = await requireStore().store(identity, bytes);
        leases.push(lease);
        return lease.state;
      };
      try {
        const target = textTarget ?? await diskText(identity, diskTarget, store);
        const content = await store(Buffer.from(normalizeEditorLineEndings(captured.content), 'utf8'));
        const baseContent = await store(Buffer.from(normalizeEditorLineEndings(captured.baseContent), 'utf8'));
        return { safety: { ...owner, binding, text: { content, baseContent, baseRevision: binding.baseRevision,
          encoding: binding.encoding, bom: binding.bom, lineEnding: binding.lineEnding }, target, phase: 'captured' }, release };
      } catch (error) {
        await release();
        throw error;
      }
    },
    observe,
    replace,
  };
};
