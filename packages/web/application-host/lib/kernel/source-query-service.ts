/** Closed source services execute against the target's real admitted Storage handle.
 * The coordinator's Run is attribution; no target Catalog Run or ToolCall is created. */
import { isDeepStrictEqual } from 'node:util';
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
import { captureExtensionSource, type ExtensionSourceCapture } from './extension-source.js';
import { resourceFailure } from '../agent-resources/source-reader.js';
import { ManagedSourceDrainedError } from '../harness/managed-source-drain.js';
import { waitWithSignal } from '../cancellation.js';
import { createManagedResearchSource } from './managed-research-source.js';
import { createManagedPackageSource } from './managed-package-source.js';

export interface SourceQueryServiceOptions {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'readAgentInputSnapshot' | 'admitWorkspaceRegistration'>;
  validateLiveSource: LiveSourceResolver;
  storage: Pick<KernelStorageAdapter, 'contextFromBranchGrant' | 'contextFromSourceGrant'>;
  resourceOwners: Omit<ThreadResourceScopeOwners, 'remote' | 'targetAuthority'>;
  structureSource?(): StructureSource;
  languageSupervisor?: ReturnType<typeof createLanguageSupervisor>;
  onError?(error: Error): void;
}
export type SourceQueryService = ManagedSourceServiceHandler & {
  release(scope: ManagedSourceLocalScope): Promise<void>;
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
        if (!scope.physicalRoot || scope.source.mode !== 'live_root') throw new Error('The original live resource root is unavailable');
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
          const result = await consume({ store, pin, readOriginalSource: () => store.readOriginalSource(input.source.branchId, input.signal ? { signal: input.signal } : {}) });
          await assertResources(input.source, input.signal); return result;
        } finally { await pin.release(); }
      },
    } });
    const language = options.languageSupervisor ? createLanguageOwner({ documents: options.documents, supervisor: options.languageSupervisor,
      sources, targetAuthority: true }) : undefined;
    const value: Services = { scope, sources, resources, packages: new Map(), controller: new AbortController(), pending: new Set(),
      languageController: new AbortController(), languagePending: new Set(), ...(language ? { language } : {}) }; services.set(key, value); return value;
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
  const release = async (scope: ManagedSourceLocalScope): Promise<void> => {
    const key = keyOf(scope), owned = services.get(key);
    if (!owned) return;
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
          physicalRoot: scope.physicalRoot, operationId: operation.operationId, path: operation.path, signal: active });
        await owner.sources.validate(query, active);
        return { bytesBase64: document.source.toString('base64'), byteLength: document.source.byteLength,
          sourceUrl: document.sourceUrl, title: document.title, contentType: document.contentType };
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
