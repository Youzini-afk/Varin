import { readFixedSourceTextEncoding } from './source-provenance.js';
/** Closed source services execute against the target's real admitted Storage handle.
 * The coordinator's Run is attribution; no target Catalog Run or ToolCall is created. */
import { querySourceFiles } from './thread-source-files.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { attachmentMimeType } from '@varin/protocol';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope, ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';
import type { StructureSource } from '../structure/types.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { createLanguageSupervisor } from '../lsp/supervisor.js';
import { createLanguageOwner, type LanguageToolOwner } from './language-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { createSourceQueryOwner, type SourceQueryAccess, type SourceQueryOwner } from './source-query.js';
import { createThreadResourceScope, type ThreadResourceScope, type ThreadResourceScopeOwners } from './thread-resource-scope.js';
import { resourceThreadSource, resourceSource } from './thread-context.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import { readSourceDocument } from './document-sources.js';
import { writeManagedBinary } from './binary-file-owner.js';
import { captureExtensionSource, type ExtensionSourceCapture } from './extension-source.js';
import { resourceFailure } from '../agent-resources/source-reader.js';
import { ManagedSourceDrainedError } from '../harness/managed-source-drain.js';
import { waitWithSignal } from '../cancellation.js';
import { createManagedResearchSource } from './managed-research-source.js';
import { createManagedPackageSource } from './managed-package-source.js';
import { copyRangeContent } from './file-content-transfer.js';
import { restoreCapturedAttachment, type CapturedAttachmentFile } from './attachment-capture.js';

const stableIdentity = (value: unknown): unknown => Array.isArray(value) ? value.map(stableIdentity)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableIdentity(item)])) : value;

export interface SourceQueryServiceOptions {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'admitWorkspaceRegistration'>;
  validateLiveSource: LiveSourceResolver;
  storage: Pick<KernelStorageAdapter, 'contextFromBranchGrant' | 'contextFromSourceGrant'>;
  resourceOwners: Omit<ThreadResourceScopeOwners, 'remote' | 'targetAuthority'>;
  structureSource?(): StructureSource;
  languageSupervisor?: ReturnType<typeof createLanguageSupervisor>;
  captureAbsoluteAttachment?(input: { threadId: string; operationId: string; ref: string; selectedPath: string; captureScope?: string }, signal?: AbortSignal): Promise<CapturedAttachmentFile>;
  onError?(error: Error): void;
}
export type SourceQueryService = ManagedSourceServiceHandler & {
  release(scope: Pick<ManagedSourceLocalScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>): Promise<void>;
  cleanup(scope: ManagedSourceCleanupScope): Promise<void>;
  dispose(): Promise<void>;
};

export function createSourceQueryService(options: SourceQueryServiceOptions): SourceQueryService {
  type Services = { scope: ManagedSourceLocalScope; sources: SourceQueryOwner; resources: ThreadResourceScope; language?: LanguageToolOwner;
    packages: Map<string, Promise<ExtensionSourceCapture>>; controller: AbortController; pending: Set<Promise<unknown>>;
    languageController: AbortController; languagePending: Set<Promise<unknown>>; languageClosing?: Promise<void>; closing?: Promise<void> };
  // These are live service handles only. Native Storage retains authority/effect facts.
  const services = new Map<string, Services>();
  const research = createManagedResearchSource(options.kernel);
  const packages = createManagedPackageSource(options.kernel);
  const keyOf = (scope: ManagedSourceLocalScope) => JSON.stringify([scope.authorityId, scope.resourceEpoch, scope.grant.grantId]);
  const queryOf = (scope: ManagedSourceLocalScope): SourceQueryAccess => ({ source: scope.source, physicalRoot: scope.physicalRoot,
    ...(scope.textEncoding ? { textEncoding: scope.textEncoding } : {}),
    threadId: scope.scope.threadId, ...(scope.scope.kind === 'run' ? { runId: scope.scope.runId, grantId: scope.grant.grantId } : {}) });
  const verifyIdentity = (scope: ManagedSourceLocalScope, identity: ThreadIdentity) => {
    if (identity.runtime !== 'agent' || identity.threadId !== scope.scope.threadId
      || scope.scope.kind === 'source_read' && identity.branchId !== scope.scope.branchId) throw new Error('Resource identity differs from its original source authority');
  };
  const get = (scope: ManagedSourceLocalScope): Services => {
    const key = keyOf(scope);
    const prior = services.get(key);
    if (prior) {
      if (!isDeepStrictEqual(prior.scope.source, scope.source) || !isDeepStrictEqual(prior.scope.scope, scope.scope)) throw new Error('Managed source authority changed');
      if (prior.scope.physicalRoot && !isDeepStrictEqual(prior.scope.physicalRoot, scope.physicalRoot)) throw new Error('Managed source execution view changed');
      // Native admission only promotes the original deferred environment. Keep
      // every retained query/resource reader on that same newly available view.
      if (!prior.scope.physicalRoot && scope.physicalRoot) prior.scope.physicalRoot = scope.physicalRoot;
      if (prior.controller.signal.aborted) throw new Error('The original source service is retiring');
      return prior;
    }
    const assert = (query: SourceQueryAccess) => {
      if (!isDeepStrictEqual(query.source, scope.source) || !isDeepStrictEqual(query.physicalRoot, scope.physicalRoot)
        || query.threadId !== scope.scope.threadId || scope.scope.kind === 'run' && query.runId !== scope.scope.runId) throw new Error('Source query differs from its admitted resource authority');
      return options.kernel.assertGrantForScope(scope.grant);
    };
    const sources = createSourceQueryOwner({ kernel: options.kernel, documents: options.documents,
      validateLiveSource: options.validateLiveSource, targetAuthority: { grant: assert } });
    const source = resourceThreadSource(scope.source)!;
    const assertResources = async (selected: ThreadSource, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(resourceSource(selected), resourceSource(source))) throw new Error('Resource source differs from its original selection');
      const grant = assert(queryOf(scope));
      if (!grant.pathScopes.includes('')) throw new Error('Project resource discovery requires whole-source read authority');
      await options.documents.admitWorkspaceRegistration(scope.source.workspace_id, signal);
      if (source.mode === 'live_root') await options.validateLiveSource(source, signal);
    };
    const resources = createThreadResourceScope({ ...options.resourceOwners, targetAuthority: { assert: assertResources,
      async withLiveSourceRead(selected, consume, signal) {
        await assertResources(selected, signal);
        if (!scope.physicalRoot || !['live_root','native_workspace'].includes(scope.source.mode)) throw new Error('The original live resource root is unavailable');
        const store = new KernelWorkingStateRootStore(await options.storage.contextFromSourceGrant({ grant: scope.grant,
          owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id,
          rootId: scope.physicalRoot.rootId, canonicalRoot: scope.physicalRoot.canonicalRoot }));
        const result = await consume(store); await assertResources(selected, signal); return result;
      },
      async withSourceRead(input, consume) {
        verifyIdentity(scope, input.identity); await assertResources(input.source, input.signal);
        const store = new KernelWorkingStateRootStore(await options.storage.contextFromBranchGrant({ grant: scope.grant,
          owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id }));
        const pin = await store.pinBranch(input.source.branchId, { revision: input.source.revision, ...(input.signal ? { signal: input.signal } : {}) });
        try {
          const textEncoding = await readFixedSourceTextEncoding(options.kernel.scoped(scope.grant), input.source.workspaceId,
            input.source.branchId, input.source.revision, input.signal, pin.root);
          const result = await consume({ store, pin, textEncoding, readOriginalSource: () => store.readOriginalSource(input.source.branchId, input.signal ? { signal: input.signal } : {}) });
          await assertResources(input.source, input.signal); return result;
        } finally { await pin.release(); }
      },
    } });
    const language = createLanguageOwner({ documents: options.documents, ...(options.languageSupervisor ? {supervisor:options.languageSupervisor} : {}),
      sources, targetAuthority: true, ...(options.structureSource ? {structure:options.structureSource} : {}) });
    const value: Services = { scope, sources, resources, packages: new Map(), controller: new AbortController(), pending: new Set(),
      languageController: new AbortController(), languagePending: new Set(), language }; services.set(key, value); return value;
  };
  const releaseLanguage = (owner: Services): Promise<void> => {
    if (owner.languageClosing) return owner.languageClosing;
    owner.languageController.abort(new DOMException('Original language source released', 'AbortError'));
    const work = (async () => {
      // Include queries still preparing a view, before the language supervisor has
      // seen them. Other source services have independent cancellation and drain.
      await Promise.allSettled([...owner.languagePending]);
      await owner.language?.releaseSource?.({ ...(owner.scope.scope.kind === 'run' ? { runId: owner.scope.scope.runId } : {}),
        grantId: owner.scope.grant.grantId });
      owner.languageController = new AbortController();
    })();
    owner.languageClosing = work;
    void work.finally(() => { if (owner.languageClosing === work) delete owner.languageClosing; }).catch(() => undefined);
    return work;
  };
  const release: SourceQueryService['release'] = async scope => {
    const owned = [...services.values()].find(owner => owner.scope.authorityId === scope.authorityId && owner.scope.resourceEpoch === scope.resourceEpoch
      && owner.scope.principal.principalId === scope.principal.principalId && owner.scope.coordinatorHostId === scope.coordinatorHostId);
    if (!owned) return;
    const key = keyOf(owned.scope);
    if (!owned.closing) {
      owned.controller.abort(new DOMException('Original source authority retired', 'AbortError'));
      owned.closing = (async () => {
        // Wait for readers/captures to leave their real owners before withdrawing service references.
        await Promise.allSettled([...owned.pending]);
        for (const [captureId, work] of owned.packages) {
          const capture = await work;
          await capture.release();
          owned.packages.delete(captureId);
        }
        await releaseLanguage(owned);
        await owned.sources.dispose(); services.delete(key);
      })();
      void owned.closing.catch(() => { delete owned.closing; });
    }
    return owned.closing;
  };
  const unsubscribeExit = options.kernel.subscribeExit(() => {
    research.clearViews();
    for (const owned of services.values()) void release(owned.scope).catch(() => {
      const failure = new Error('Original managed source service cleanup is incomplete after kernel exit');
      if (options.onError) options.onError(failure); else console.error('[Source] Managed source service cleanup requires attention');
    });
  });
  const execute = async (owner: Services, scope: ManagedSourceLocalScope, operation: Parameters<ManagedSourceServiceHandler>[1], active: AbortSignal): Promise<unknown> => {
    // No domain reader has been entered at this boundary.
    if (active.aborted) throw new ManagedSourceDrainedError(active.reason);
    const query = queryOf(scope), source = resourceThreadSource(scope.source)!;
    const captureIdentity = (operationId: string, ref: string) => {
      if (scope.scope.kind !== 'run') throw new Error('Attachment capture requires its original Run');
      return createHash('sha256').update(JSON.stringify([scope.principal.principalId, scope.coordinatorHostId, stableIdentity(scope.source),
        scope.scope.threadId, scope.scope.runId, operationId, ref])).digest('hex');
    };
    const verifyFileReceipt = async (operationId: string, attachment: unknown, sourceGrantId: unknown) => {
      if (scope.scope.kind !== 'run' || typeof sourceGrantId !== 'string') throw new Error('Original file has no Source provenance');
      const result = await options.kernel.sourceRequest<{ state?: string; grantId?: string; receipt?: { attachment?: unknown } }>('source.file.receipt', {
        principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId, source: scope.source,
        threadId: scope.scope.threadId, runId: scope.scope.runId, operationId,
      }, active);
      if (result.state !== 'committed' || result.grantId !== sourceGrantId || !isDeepStrictEqual(result.receipt?.attachment, attachment))
        throw new Error('Original file receipt differs from its Source owner');
    };
    // These original metadata methods have no deferred capture/compute/process
    // worker. Their completed response (including failure) leaves no reader to
    // cancel. A lost kernel lifetime is still unknown, as are cleanup failures
    // from the deferred query paths below.
    const metadata = async <T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      try {
        active.throwIfAborted();
        // The scoped metadata RPC otherwise rejects cancellation before its
        // native acknowledgement. Join this short original reader first.
        const result = await read(new AbortController().signal);
        active.throwIfAborted();
        return result;
      }
      catch (error) {
        if (options.kernel.isReady && options.kernel.kernelEpoch === scope.resourceEpoch) throw new ManagedSourceDrainedError(error);
        throw error;
      }
    };
    switch (operation.kind) {
      case 'attachment_recover': case 'attachment_capture': {
        if (scope.scope.kind !== 'run' || !operation.operationId || !/^attachment:[a-zA-Z0-9_-]+$/.test(operation.ref)) throw new Error('Attachment capture requires its original Run and selection');
        const client = options.kernel.scoped(scope.grant), workspaceId = scope.source.workspace_id;
        const captureId = captureIdentity(operation.operationId, operation.ref);
        const retainedId = `attachment.capture:${captureId}`;
        const releaseCapture = () => client.releaseRecord(`attachment-capture-release:${captureId}`, workspaceId, retainedId);
        const validateReceiptAuthority = () => options.kernel.assertGrantForScope(scope.grant);
        const previous = await client.getRecord(workspaceId, operation.ref, active);
        if (previous) {
          // A retained selection is immutable: validate its original Source
          // authority without looking up a mutable path again on retry.
          await validateReceiptAuthority();
          const saved = JSON.parse(previous.payloadJson) as { attachment: { ref: string; filename: string; mimeType: string; byteLength: number }; contentHash: string; operationId: string; path: string; captureId: string; expectedReadVersion?:string };
          if (previous.recordType !== 'attachment.file' || previous.state === 'released' || previous.threadId !== scope.scope.threadId || previous.runId !== scope.scope.runId
            || saved.attachment.ref !== operation.ref || saved.operationId !== operation.operationId || saved.path !== operation.path || saved.captureId !== captureId || saved.expectedReadVersion !== operation.expectedReadVersion
            || !previous.references.some(item => item.slot === 'source' && item.objectHash === saved.contentHash)) throw new Error('Original attachment capture identity changed');
          if (await client.getRecord(workspaceId, retainedId)) await releaseCapture();
          const staleIntent = `attachment.managed-capture-intent:${captureId}`;
          if (await client.getRecord(workspaceId, staleIntent)) {
            if (path.isAbsolute(operation.path)) {
              const key = JSON.stringify(['absolute', `managed:${captureId}`, operation.operationId, operation.ref]);
              const stale = await restoreCapturedAttachment(options.kernel, { id: scope.scope.threadId, captureScope: `managed:${captureId}` }, key, operation.path, active);
              if (stale) await stale.release(true);
            }
            await client.releaseRecord(`attachment-intent-release:${captureId}`, workspaceId, staleIntent);
          }
          return { attachment: saved.attachment, contentHash: saved.contentHash };
        }
        const intentId = `attachment.managed-capture-intent:${captureId}`;
        if (operation.kind === 'attachment_capture') {
          await client.putRecord({ operationId: `attachment-intent:${captureId}`, recordId: intentId, workspaceId,
            recordType: 'attachment.managed-capture-intent', state: 'temporary', threadId: scope.scope.threadId, runId: scope.scope.runId,
            payloadJson: JSON.stringify({ captureId, operationId: operation.operationId, ref: operation.ref, path: operation.path }), ownerIds: [], references: [] }, active);
        }
        const retained = scope.source.mode === 'fixed_branch' ? null : await client.getRecord(workspaceId, retainedId, active);
        const retainedPayload = retained && retained.state !== 'released' ? JSON.parse(retained.payloadJson) as { canonicalRoot?: string } : null;
        const root = scope.physicalRoot?.canonicalRoot ?? retainedPayload?.canonicalRoot;
        let selectedPath = operation.path;
        if (path.isAbsolute(selectedPath)) {
          const relative = root ? path.relative(root, selectedPath) : null;
          const within = relative !== null && !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
          if (!within) {
            if (operation.expectedReadVersion) throw new Error('The original file observation requires its admitted source root');
            await validateReceiptAuthority();
            const captureScope = `managed:${captureId}`;
            const key = JSON.stringify(['absolute', captureScope, operation.operationId, operation.ref]);
            const captured = operation.kind === 'attachment_recover'
              ? await restoreCapturedAttachment(options.kernel, { id: scope.scope.threadId, captureScope }, key, operation.path, active)
              : await options.captureAbsoluteAttachment?.({ threadId: scope.scope.threadId, operationId: operation.operationId, ref: operation.ref, selectedPath: operation.path, captureScope }, active);
            if (!captured) {
              if (operation.kind === 'attachment_recover') return null;
              throw new Error('The original Host cannot admit this absolute attachment path');
            }
            let committed = false;
            let result: { attachment: import('@varin/protocol').Attachment; contentHash: string } | undefined;
            try {
              const object = captured.contentHash.startsWith('ranges-')
                ? await copyRangeContent(client, captured.contentHash, captured.byteLength, (offset, length, view) => captured.readPage(offset, length, view), active)
                : await client.putBlobStream(captured.chunks, { operationId: `attachment-absolute-blob:${randomUUID()}`, byteLength: captured.byteLength, expectedHash: captured.contentHash }, active);
              const attachment = { ref: operation.ref, filename: captured.filename, mimeType: captured.mimeType, byteLength: captured.byteLength };
              await client.putRecord({ operationId: `attachment-record:${captureId}`, recordId: operation.ref, workspaceId,
                recordType: 'attachment.file', state: 'temporary', threadId: scope.scope.threadId, runId: scope.scope.runId,
                payloadJson: JSON.stringify({ attachment, contentHash: object.hash, operationId: operation.operationId, path: operation.path, captureId, ...(operation.expectedReadVersion ? {expectedReadVersion:operation.expectedReadVersion}:{}) }),
                ownerIds: [object.ownerId], references: [{ slot: 'source', objectHash: object.hash }] }, active);
              committed = true;
              result = { attachment, contentHash: object.hash };
            } finally { await captured.release(committed); }
            await client.releaseRecord(`attachment-intent-release:${captureId}`, workspaceId, intentId);
            return result;
          }
          selectedPath = relative!.replaceAll('\\', '/');
        }
        if (operation.kind === 'attachment_recover' && (!retained || retained.state === 'released')) return null;
        if (retained && retained.state !== 'released') await validateReceiptAuthority();
        else await owner.sources.checkPath(query, selectedPath, active);
        let state: import('./protocol.generated.js').KernelBranchState;
        let sourcePath = selectedPath;
        if (scope.source.mode === 'fixed_branch') {
          const read = await client.readBranch({ branchId: scope.source.branch_id!, revision: scope.source.revision!, paths: [sourcePath], includeEntries: true }, active);
          state = read.entries[0]?.state ?? { kind: 'missing' };
          sourcePath = read.entries[0]?.path ?? sourcePath;
        } else {
          if (retained && retained.state !== 'released') {
            const saved = JSON.parse(retained.payloadJson) as { path: string; stateJson: string; operationId: string; executionWorkspaceId: string; canonicalRoot: string; readVersion?:string };
            if (retained.recordType !== 'attachment.capture' || retained.threadId !== scope.scope.threadId || saved.path !== selectedPath
              || saved.operationId !== `attachment-capture:${captureId}` || saved.executionWorkspaceId !== scope.source.execution_workspace_id
              || scope.physicalRoot && saved.canonicalRoot !== scope.physicalRoot.canonicalRoot) throw new Error('Original retained attachment selection changed');
            state = JSON.parse(saved.stateJson) as import('./protocol.generated.js').KernelBranchState;
            if (operation.expectedReadVersion) await options.kernel.agentRuntimeRequest('runtime.model_reference.file_state',{source:scope.source,path:saved.path,state,rootId:scope.physicalRoot?.rootId ?? null,...(saved.readVersion ? {readVersion:saved.readVersion}:{}),expectedReadVersion:operation.expectedReadVersion},active);
            if (state.kind === 'regular-file') {
              const hash = state.objectHash;
              if (!retained.references.some(item => item.slot === 'source' && item.objectHash === hash)) throw new Error('Original retained attachment content is unavailable');
            }
            sourcePath = saved.path;
          } else {
            if (!scope.physicalRoot) throw new Error('Original attachment execution root is unavailable');
            const result = await client.fileCapture({ operationId: `attachment-capture:${captureId}`, workspaceId, rootId: scope.physicalRoot.rootId,
              path: selectedPath, store: true, retentionRecordId: retainedId, ...(operation.expectedReadVersion ? {expectedReadVersion:operation.expectedReadVersion}:{}) }, active);
            if (typeof result.stateJson !== 'string' || typeof result.recordId !== 'string') throw new Error('Original attachment capture was not retained');
            state = JSON.parse(result.stateJson) as import('./protocol.generated.js').KernelBranchState;
            if (typeof result.path === 'string') sourcePath = result.path;
          }
        }
        if (scope.source.mode === 'fixed_branch' && operation.expectedReadVersion) await options.kernel.agentRuntimeRequest('runtime.model_reference.file_state',{source:scope.source,path:sourcePath,state,expectedReadVersion:operation.expectedReadVersion},active);
        if (state.kind !== 'regular-file') throw new Error(`Selected attachment is ${state.kind}, not a regular file`);
        const name = path.posix.basename(sourcePath.replaceAll('\\', '/'));
        const attachment = { ref: operation.ref, filename: name, mimeType: attachmentMimeType(name), byteLength: state.byteLength };
        await client.putRecord({ operationId: `attachment-record:${captureId}`, recordId: operation.ref, workspaceId,
          recordType: 'attachment.file', state: 'temporary', threadId: scope.scope.threadId, runId: scope.scope.runId,
          payloadJson: JSON.stringify({ attachment, contentHash: state.objectHash, operationId: operation.operationId, path: operation.path, captureId, ...(operation.expectedReadVersion ? {expectedReadVersion:operation.expectedReadVersion}:{}) }),
          ownerIds: [], references: [{ slot: 'source', objectHash: state.objectHash }] }, active);
        if (scope.source.mode !== 'fixed_branch') await releaseCapture();
        if (await client.getRecord(workspaceId, intentId)) await client.releaseRecord(`attachment-intent-release:${captureId}`, workspaceId, intentId);
        return { attachment, contentHash: state.objectHash };
      }
      case 'attachment_describe': {
        if (scope.scope.kind !== 'run' || !/^attachment:operation_[a-zA-Z0-9_-]+$/.test(operation.ref)) throw new Error('Invalid original file receipt');
        const encoded = operation.ref.slice('attachment:operation_'.length), operationId = Buffer.from(encoded, 'base64url').toString('utf8');
        if (!operationId || Buffer.from(operationId).toString('base64url') !== encoded) throw new Error('Invalid original file receipt');
        const record = await options.kernel.scoped(scope.grant).getRecord(scope.source.workspace_id, operation.ref, active);
        if (!record || record.recordType !== 'attachment.file' || record.state === 'released' || record.threadId !== scope.scope.threadId) throw new Error('Original file receipt is unavailable');
        const value = JSON.parse(record.payloadJson) as { attachment: { ref: string }; contentHash: string; operationId: string; sourceGrantId?: string };
        if (value.operationId !== operationId || value.attachment.ref !== operation.ref || !record.references.some(item => item.slot === 'source' && item.objectHash === value.contentHash)) throw new Error('Original file receipt is invalid');
        await verifyFileReceipt(operationId, value.attachment, value.sourceGrantId);
        return { attachment: value.attachment, contentHash: value.contentHash };
      }
      case 'attachment_discard': {
        // Caller has confirmed the original operation ended without delivery
        // and all its writers drained. Never infer this from a timeout.
        if (scope.scope.kind !== 'run' || !operation.operationId || !operation.path || !/^attachment:[a-zA-Z0-9_-]+$/.test(operation.ref)
          || operation.ref.startsWith('attachment:operation_')) throw new Error('Invalid original attachment discard');
        const client = options.kernel.scoped(scope.grant), workspaceId = scope.source.workspace_id;
        const id = captureIdentity(operation.operationId, operation.ref), intentId = `attachment.managed-capture-intent:${id}`;
        const intent = await client.getRecord(workspaceId, intentId, active);
        if (intent && intent.state !== 'released') {
          const saved = JSON.parse(intent.payloadJson) as { captureId?: string; operationId?: string; ref?: string; path?: string };
          if (intent.recordType !== 'attachment.managed-capture-intent' || intent.threadId !== scope.scope.threadId || intent.runId !== scope.scope.runId
            || saved.captureId !== id || saved.operationId !== operation.operationId || saved.ref !== operation.ref || saved.path !== operation.path)
            throw new Error('Original attachment discard intent changed');
          if (path.isAbsolute(operation.path)) {
            const key = JSON.stringify(['absolute', `managed:${id}`, operation.operationId, operation.ref]);
            const original = await restoreCapturedAttachment(options.kernel, { id: scope.scope.threadId, captureScope: `managed:${id}` }, key, operation.path, active);
            if (original) await original.release(true);
          }
          await client.releaseRecord(`attachment-discard-capture:${id}`, workspaceId, `attachment.capture:${id}`);
        }
        const formal = await client.getRecord(workspaceId, operation.ref, active);
        if (formal && formal.state !== 'released') {
          const saved = JSON.parse(formal.payloadJson) as { captureId?: string; operationId?: string; path?: string };
          if (formal.recordType !== 'attachment.file' || formal.threadId !== scope.scope.threadId || formal.runId !== scope.scope.runId
            || saved.captureId !== id || saved.operationId !== operation.operationId || saved.path !== operation.path) throw new Error('Original attachment discard owner changed');
          await client.releaseRecord(`attachment-discard-file:${id}`, workspaceId, operation.ref);
        }
        if (intent && intent.state !== 'released') await client.releaseRecord(`attachment-discard-intent:${id}`, workspaceId, intentId);
        return;
      }
      case 'attachment_cleanup': {
        // The service admission requires a result authority. Its coordinator
        // must first prove that the original Thread is deleted and its Source
        // writers have drained; a mere grant retirement is not that proof.
        if (scope.scope.kind !== 'run') throw new Error('Attachment cleanup requires the original Run');
        const client = options.kernel.scoped(scope.grant), workspaceId = scope.source.workspace_id;
        const authorities = await options.kernel.sourceRequest<Array<{ purpose: string; grantId: string; source: unknown }>>('source.authority.inspect_scope', {
          principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
          threadId: scope.scope.threadId, runId: scope.scope.runId,
        }, active);
        const originalGrants = new Set(authorities.filter(value => value.purpose === 'source' && isDeepStrictEqual(value.source, scope.source)).map(value => value.grantId));
        for (const recordType of ['attachment.managed-capture-intent', 'attachment.file']) {
          let cursor: number | undefined;
          const records: Array<{ recordId: string; captureId: string; operationId: string; ref: string; path?: string }> = [];
          do {
            const page = await client.listRecords({ workspaceId, recordType, threadId: scope.scope.threadId, ...(cursor === undefined ? {} : { cursor }) });
            for (const record of page.records) {
              if (record.state === 'released' || record.threadId !== scope.scope.threadId || record.runId && record.runId !== scope.scope.runId) continue;
              const value = JSON.parse(record.payloadJson) as { captureId?: string; operationId?: string; ref?: string; path?: string; sourceGrantId?: string; attachment?: unknown };
              const ref = recordType === 'attachment.file' ? record.recordId : value.ref;
              if (!ref || !value.operationId) continue;
              if (recordType === 'attachment.file' && value.sourceGrantId && originalGrants.has(value.sourceGrantId)
                && ref === `attachment:operation_${Buffer.from(value.operationId).toString('base64url')}`) {
                await verifyFileReceipt(value.operationId, value.attachment, value.sourceGrantId);
                records.push({ recordId: record.recordId, captureId: '', operationId: value.operationId, ref });
              } else if (value.captureId && value.captureId === captureIdentity(value.operationId, ref)) {
                records.push({ recordId: record.recordId, captureId: value.captureId, operationId: value.operationId, ref, ...(value.path ? { path: value.path } : {}) });
              }
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          // Native cursors are offsets into the current set. Complete the scan
          // before releases remove entries, otherwise later pages are skipped.
          for (const record of records) {
            if (recordType === 'attachment.managed-capture-intent') {
              if (record.path && path.isAbsolute(record.path)) {
                const key = JSON.stringify(['absolute', `managed:${record.captureId}`, record.operationId, record.ref]);
                const original = await restoreCapturedAttachment(options.kernel, { id: scope.scope.threadId, captureScope: `managed:${record.captureId}` }, key, record.path, active);
                if (original) await original.release(true);
              }
              await client.releaseRecord(`attachment-thread-delete-capture:${record.captureId}`, workspaceId, `attachment.capture:${record.captureId}`);
            }
            const releaseId = createHash('sha256').update(JSON.stringify([workspaceId, scope.scope.threadId, record.recordId])).digest('hex');
            await client.releaseRecord(`attachment-thread-delete:${releaseId}`, workspaceId, record.recordId);
          }
        }
        return;
      }
      case 'attachment_release': {
        if (scope.scope.kind !== 'run' || !/^attachment:[a-zA-Z0-9_-]+$/.test(operation.ref)) throw new Error('Invalid original attachment release');
        const client = options.kernel.scoped(scope.grant);
        const record = await client.getRecord(scope.source.workspace_id, operation.ref, active);
        if (!record) return;
        if (record.recordType !== 'attachment.file' || record.threadId !== scope.scope.threadId || record.runId !== scope.scope.runId) throw new Error('Original attachment release is outside its Run');
        const value = JSON.parse(record.payloadJson) as { operationId?: string; captureId?: string };
        if (!value.operationId || value.captureId !== captureIdentity(value.operationId, operation.ref)) throw new Error('Original attachment release changed its owner');
        const releaseId = createHash('sha256').update(JSON.stringify([scope.source.workspace_id, scope.scope.threadId, scope.scope.runId, operation.ref])).digest('hex');
        await client.releaseRecord(`attachment-release:${releaseId}`, scope.source.workspace_id, operation.ref);
        return;
      }
      case 'attachment_read': {
        if (scope.scope.kind !== 'run' || !/^attachment:[a-zA-Z0-9_-]+$/.test(operation.ref)
          || !Number.isSafeInteger(operation.offset) || operation.offset < 0 || !Number.isSafeInteger(operation.length) || operation.length < 0 || operation.length > 256 * 1024) throw new Error('Invalid original attachment read');
        const client = options.kernel.scoped(scope.grant);
        const record = await client.getRecord(scope.source.workspace_id, operation.ref, active);
        if (!record || record.recordType !== 'attachment.file' || record.state === 'released' || record.threadId !== scope.scope.threadId) throw new Error('Original attachment is unavailable');
        const value = JSON.parse(record.payloadJson) as { attachment: { ref: string }; contentHash: string; operationId?: string; captureId?: string; sourceGrantId?: string };
        const originalFile = operation.ref.startsWith('attachment:operation_') && typeof value.operationId === 'string'
          && operation.ref === `attachment:operation_${Buffer.from(value.operationId).toString('base64url')}`;
        if ((!originalFile && (record.runId !== scope.scope.runId || !value.operationId || value.captureId !== captureIdentity(value.operationId, operation.ref))) || value.attachment.ref !== operation.ref
          || !record.references.some(item => item.slot === 'source' && item.objectHash === value.contentHash)) throw new Error('Original attachment receipt is invalid');
        if (originalFile) await verifyFileReceipt(value.operationId!, value.attachment, value.sourceGrantId);
        return client.getBlob(operation.rangeObject ?? value.contentHash, { recordId: operation.ref, slot: 'source' }, { offset: operation.offset, length: operation.length,
          ...(operation.representation ? { representation: operation.representation } : {}), ...(operation.rangeObject ? { rangeRoot: value.contentHash } : {}), signal: active });
      }
      case 'experiment_admit': case 'experiment_capture': case 'experiment_read':
        await metadata(signal => owner.sources.validate(query, signal));
        return research.handle(scope, operation, active);
      case 'validate': await metadata(signal => owner.sources.validate(query, signal)); return { pathScopes: [...scope.grant.pathScopes] };
      case 'read':
        await metadata(signal => owner.sources.checkPath(query, operation.path, signal));
        return owner.sources.read(query, operation.path, active);
      case 'structure_recipe': case 'structure_units': {
        await owner.sources.checkPath(query, operation.path, active);
        const structure = options.structureSource?.();
        if (!structure) throw new Error('This source Host has no configured structure service');
        const request = { workspaceId: scope.source.workspace_id, path: operation.path, languageId: operation.languageId };
        const result = operation.kind === 'structure_recipe'
          ? { recipeId: await structure.unitsRecipe?.(request) ?? null }
          : await (() => {
            if (!structure.unitsFixed) throw new Error('This source Host cannot prepare source structure');
            return structure.unitsFixed({ ...request, signal: active, lane: 'foreground',
              compute: (input, config) => owner.sources.compute(query, input, { ...config, signal: active }) });
          })();
        await owner.sources.validate(query, active); return result;
      }
      case 'document_read': {
        if (scope.scope.kind !== 'run') throw new Error('Document ingestion requires its actual coordinator Run');
        await owner.sources.validate(query, active);
        const document = await readSourceDocument({ client: options.kernel.scoped(scope.grant), source: scope.source,
          physicalRoot: scope.physicalRoot, operationId: operation.operationId, path: operation.path, signal: active,
          fileVersion: async (path,state,rootId) => (await options.kernel.agentRuntimeRequest<{readVersion:string},'runtime.model_reference.file_state'>('runtime.model_reference.file_state',{source:scope.source,path,state,...(rootId ? {rootId}:{})},active)).readVersion });
        await owner.sources.validate(query, active);
        return { bytesBase64: document.source.toString('base64'), byteLength: document.source.byteLength,
          sourceUrl: document.sourceUrl, title: document.title, contentType: document.contentType, ...(document.fileObservation ? {fileObservation:document.fileObservation}:{}) };
      }
      case 'binary_write': {
        await owner.sources.validate(query, active);
        return writeManagedBinary(options.kernel, scope, operation, active);
      }
      case 'package_capture': {
        if (scope.scope.kind !== 'run' || scope.grant.operationId !== operation.operationId || !operation.captureId) {
          throw new ManagedSourceDrainedError(new Error('Package capture requires its original caller-owned Source operation'));
        }
        await owner.sources.validate(query, active);
        if (owner.packages.has(operation.captureId)) throw new ManagedSourceDrainedError(new Error('Package capture already exists'));
        const runId = scope.scope.runId;
        const work = (async () => {
          const captured = await packages.capture(scope, operation.captureId, operation.packagePath);
          const common = { grant: scope.grant, owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id };
          if (scope.source.mode !== 'fixed_branch' && !scope.physicalRoot) throw new Error('The original physical package source is unavailable');
          const context = scope.source.mode === 'fixed_branch' ? await options.storage.contextFromBranchGrant(common)
            : await options.storage.contextFromSourceGrant({ ...common, rootId: scope.physicalRoot!.rootId,
              canonicalRoot: scope.physicalRoot!.canonicalRoot });
          return captureExtensionSource({ store: new KernelWorkingStateRootStore(context), client: options.kernel.scoped(scope.grant),
            source: scope.source, physicalRoot: scope.physicalRoot, runId,
            operationId: operation.operationId, packagePath: operation.packagePath, signal: active, pinId: captured.pinId });
        })();
        owner.packages.set(operation.captureId, work);
        void work.catch(error => {
          // captureExtensionSource has already joined and released a failed
          // capture. Keep only uncertain cleanup, not a permanently rejected reader.
          if (!(error instanceof AggregateError) && owner.packages.get(operation.captureId) === work) owner.packages.delete(operation.captureId);
        });
        try {
          const capture = await work;
          await owner.sources.validate(query, active);
          return { captureId: operation.captureId, snapshot: capture.snapshot };
        } catch (error) {
          // A successfully captured but undelivered result is still owned here;
          // authority retirement releases it without recapturing mutable files.
          if (error instanceof AggregateError) throw error;
          if (options.kernel.isReady && options.kernel.kernelEpoch === scope.resourceEpoch) throw new ManagedSourceDrainedError(error);
          throw error;
        }
      }
      case 'package_read': {
        const work = owner.packages.get(operation.captureId);
        if (!work) throw new ManagedSourceDrainedError(new Error('Original package capture is unavailable'));
        try { return await (await work).read(operation.path, operation.offset, operation.length, active); }
        catch (error) {
          if (options.kernel.isReady && options.kernel.kernelEpoch === scope.resourceEpoch) throw new ManagedSourceDrainedError(error);
          throw error;
        }
      }
      case 'check_path': await metadata(signal => owner.sources.checkPath(query, operation.path, signal)); return { checked: true };
      case 'routing_workspace': return metadata(signal => owner.sources.routingWorkspace(query, signal));
      case 'files': {
        await owner.sources.validate(query, active);
        let drained = false;
        try {
          const result = await querySourceFiles((input, config) => owner.sources.compute(query, input,
            { ...config, onDrained: () => { drained = true; } }), { source: query.source, physicalRoot: query.physicalRoot, runId: query.runId ?? null }, operation.options, active);
          await owner.sources.validate(query, active);
          return result;
        } catch (error) { if (drained) throw new ManagedSourceDrainedError(error); throw error; }
      }
      case 'compute': {
        if (['workspaceId', 'rootId', 'branchId', 'revision', 'pinId', 'objects'].some(key => Object.hasOwn(operation.input, key))) {
          throw new Error('Source computation cannot select another resource address');
        }
        const { jobId: _requestJob, ...input } = operation.input;
        return owner.sources.compute(query, input, { signal: active });
      }
      case 'resources_prepare': {
        verifyIdentity(scope, operation.identity);
        const resourceOptions = { signal: active, ...(operation.request ? { request: operation.request } : {}),
          ...(operation.instructionDirectories ? { instructionDirectories: operation.instructionDirectories } : {}),
          ...(operation.supportingFiles ? { supportingFiles: operation.supportingFiles } : {}) };
        if (operation.snapshot) return owner.resources.withScope(operation.identity, source, operation.admitted, async () => operation.snapshot!,
          { ...resourceOptions, snapshot: operation.snapshot });
        return owner.resources.prepare(operation.identity, source, operation.admitted, resourceOptions);
      }
      case 'resource_read': case 'resource_list': {
        verifyIdentity(scope, operation.identity);
        return owner.resources.withScope(operation.identity, source, operation.snapshot.scope, async ({ readers }) => {
          const reference = operation.reference;
          const reader = readers.find(reader => reader.domainId === reference.domainId && reader.viewId === reference.viewId);
          if (!reader) return resourceFailure(reference, reference.path, 'denied', 'Resource is outside the original admitted snapshot');
          return operation.kind === 'resource_read' ? reader.read(reference.path, active) : reader.list(reference.path, active);
        }, { snapshot: operation.snapshot, signal: active, ...(operation.request ? { request: operation.request } : {}) });
      }
      case 'language': {
        if (scope.scope.kind !== 'run') throw new Error('Language queries require an actual coordinator Run');
        if (!owner.language) return { status: 'unavailable', items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, message: 'This source Host has no configured language service' };
        return owner.language({ ...operation.query, source: scope.source, physicalRoot: scope.physicalRoot,
          runId: scope.scope.runId, threadId: scope.scope.threadId, grantId: scope.grant.grantId }, active);
      }
      case 'original_source': {
        if (operation.branchId !== scope.source.branch_id) throw new Error('Original source read changed its selected branch');
        const store = new KernelWorkingStateRootStore(await options.storage.contextFromBranchGrant({ grant: scope.grant,
          owningWorkspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id }));
        return store.readOriginalSource(operation.branchId, { signal: active });
      }
      default: throw new Error(`Source service ${operation.kind} has no query consumer`);
    }
  };
  const handler: ManagedSourceServiceHandler = (scope, operation, signal) => {
    if (operation.kind === 'language_release') {
      if (scope.scope.kind !== 'run') throw new Error('Language release requires its actual coordinator Run');
      const selected = scope.scope;
      // Child settlement drains language writers. Other services retain their
      // own scopes, including an independently held package capture.
      return Promise.all([...services.values()].filter(({ scope: original }) => original.principal.principalId === scope.principal.principalId
        && original.coordinatorHostId === scope.coordinatorHostId && original.scope.kind === 'run'
        && original.scope.threadId === selected.threadId && original.scope.runId === selected.runId
        && original.scope.epoch <= selected.epoch).map(releaseLanguage)).then(() => undefined);
    }
    const owner = get(scope);
    const active = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    const work = Promise.resolve().then(async () => {
      if (operation.kind !== 'language') return execute(owner, scope, operation, active);
      if (owner.languageClosing) await waitWithSignal(owner.languageClosing, active);
      active.throwIfAborted();
      const query = execute(owner, scope, operation, AbortSignal.any([active, owner.languageController.signal]));
      owner.languagePending.add(query);
      try { return await query; } finally { owner.languagePending.delete(query); }
    });
    owner.pending.add(work);
    return work.finally(() => { owner.pending.delete(work); });
  };
  return Object.assign(handler, { release, async cleanup(scope: ManagedSourceCleanupScope) {
    await packages.release(scope); await research.release(scope);
  }, async dispose() {
    unsubscribeExit(); await Promise.all([...services.values()].map(owner => release(owner.scope)));
    research.clearViews();
  } });
}
