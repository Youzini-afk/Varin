import { parseAgentInputContext, type SourceResourceOwner } from '@varin/protocol';
import { waitWithSignal } from '../cancellation.js';
import { normalizeWorkspaceRelativePath } from '../workspace/path-safety.js';
import { readSourceDrafts } from '../harness/working-state/source-drafts.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners, type SourceCaptureDocuments } from '../harness/working-state/source-preparation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { ThreadResourceScopeOwners } from './thread-resource-scope.js';
import { SourceAdmissionError } from './source-admission-error.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LiveSourceOwner } from './live-source.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadIdentity, ThreadSource, ThreadPrepareSource, ThreadPreparedSource, ThreadSourcesAPI } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';

export interface ThreadSourceRemoteOwner {
  list: ThreadSourcesAPI['list'];
  resolve: ThreadSourcesAPI['resolve'];
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  admit(source: ThreadSource, identity: ThreadIdentity, runId?: string, signal?: AbortSignal): Promise<void>;
}

/** Untrusted API identity is decoded once; no obsolete shape or local-owner fallback. */
export function parseSourceResourceOwner(value: unknown): SourceResourceOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Explicit source resource owner is required');
  const owner = value as Record<string, unknown>;
  if (owner.kind === 'local' && Object.keys(owner).length === 1) return { kind: 'local' };
  if (owner.kind === 'managed_host' && Object.keys(owner).length === 4
    && ['hostId', 'connectionId', 'endpointIdentity'].every(key => typeof owner[key] === 'string' && owner[key].length > 0)) {
    return { kind: 'managed_host', hostId: owner.hostId as string, connectionId: owner.connectionId as string, endpointIdentity: owner.endpointIdentity as string };
  }
  throw new Error('Source resource owner is malformed');
}

export function createThreadSourceDirectory(options: {
  documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration'>;
  remote?: Pick<ThreadSourceRemoteOwner, 'list' | 'resolve'>;
}): ThreadSourcesAPI {
  return {
    async list(identity, signal) {
      signal?.throwIfAborted();
      const remote = await options.remote?.list(identity, signal);
      return { targets: [{ resourceOwner: { kind: 'local' }, label: 'This Host', capabilities: [] }, ...(remote?.targets ?? [])],
        unavailable: remote?.unavailable ?? [] };
    },
    async resolve(identity, request, signal) {
      const resourceOwner = parseSourceResourceOwner(request.resourceOwner);
      signal?.throwIfAborted();
      if (resourceOwner.kind === 'managed_host') {
        if (!options.remote) throw new SourceAdmissionError('source_unavailable');
        return options.remote.resolve(identity, { ...request, resourceOwner }, signal);
      }
      const workspace = await options.documents.resolveWorkspace({ path: request.path });
      const registration = await options.documents.admitWorkspaceRegistration(workspace.workspaceId, signal);
      return { resourceOwner, workspaceId: workspace.workspaceId, path: registration.canonicalPath };
    },
  };
}

interface SourcePreparationOwners {
  documents: SourceCaptureDocuments & Pick<DocumentAuthority, 'admitWorkspaceRegistration' | 'cloneInputSnapshot'>;
  prepareResources?: StableSourcePreparationOwners['prepareResources'];
  inspectInventory: StableSourcePreparationOwners['inspectInventory'];
  workingStates: WorkspaceWorkingStateRootAccess;
  liveSources?: LiveSourceOwner;
  remote?: Pick<ThreadSourceRemoteOwner, 'prepare'>;
  sourceTools(mode: ThreadSource['mode']): Promise<string[]>;
}

interface SourcePreparationFlight {
  identity: string;
  controller: AbortController;
  work: Promise<ThreadPreparedSource>;
  observers: number;
}

/** A cancelled last observer drains the actual capture before its call settles.
 * Other observers keep shared work alive; no new attempt can overtake that cleanup. */
function observePreparation(flight: SourcePreparationFlight, signal?: AbortSignal): Promise<ThreadPreparedSource> {
  flight.observers += 1;
  return new Promise((resolve, reject) => {
    let observing = true;
    const leave = () => { if (!observing) return false; observing = false; flight.observers -= 1; signal?.removeEventListener('abort', abort); return true; };
    const abort = () => {
      if (!leave()) return;
      const reason = signal?.reason ?? new DOMException('Source preparation cancelled', 'AbortError');
      if (flight.observers) { reject(reason); return; }
      flight.controller.abort(reason);
      void flight.work.then(() => reject(reason), () => reject(reason));
    };
    void flight.work.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Request identity and content are frozen before crossing any asynchronous owner. */
export function normalizeThreadSourcePreparation(input: ThreadPrepareSource): ThreadPrepareSource {
  if (!input || input.runtime !== 'agent' || !input.threadId || !input.branchId || !input.key
    || typeof input.workspaceId !== 'string' || !input.workspaceId || !Array.isArray(input.captureScopes)
    || input.captureScopes.some(scope => typeof scope !== 'string')
    || !['fixed_branch', 'materialized', 'live_root'].includes(input.mode)) throw new Error('Source preparation request is malformed');
  const resourceOwner = parseSourceResourceOwner(input.resourceOwner);
  const captureScopes = [...new Set(input.captureScopes.map(scope => normalizeWorkspaceRelativePath(scope) || '.'))].sort();
  let content: ThreadPrepareSource['content'];
  if (input.content?.mode === 'saved-files') content = { mode: 'saved-files' };
  else if (input.content?.mode === 'surface-drafts') {
    const context = parseAgentInputContext(input.content.context);
    if (!context) throw new Error('Source editor context is malformed');
    if (context.source === 'surface') {
      context.roots.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
      for (const root of context.roots) root.dirtyPaths.sort();
    }
    content = { mode: 'surface-drafts', context };
  } else throw new Error('An explicit source content selection is required');
  if (input.mode === 'live_root' && (content.mode !== 'saved-files' || captureScopes.length)) {
    throw new Error('Live workspace access uses saved files and does not capture editor drafts or copy scopes');
  }
  if (resourceOwner.kind === 'managed_host' && content.mode !== 'saved-files') throw new Error('Editor drafts belong to this Host; select saved files for a managed source');
  return { runtime: 'agent', resourceOwner, threadId: input.threadId, branchId: input.branchId, key: input.key,
    workspaceId: input.workspaceId, mode: input.mode, content, captureScopes };
}

/** Documents supplies original drafts; WorkingState's branch-create receipt owns the fixed source. */
export function createThreadSourcePreparer({ documents, workingStates, liveSources, prepareResources, inspectInventory, sourceTools, remote }: SourcePreparationOwners) {
  const preparing = new Map<string, SourcePreparationFlight>();
  const prepare = async (input: ThreadPrepareSource, key: string, captureIdentity: string, signal: AbortSignal): Promise<ThreadPreparedSource> => {
    signal.throwIfAborted();
    if (input.resourceOwner.kind === 'managed_host') {
      if (!remote) throw new SourceAdmissionError('source_unavailable');
      return remote.prepare(input, signal);
    }
    // A saved registration is a namespace, not authority to read a physical directory.
    // Look up the durable receipt before reopening a now-moved directory or expired draft.
    const workspaceId = input.workspaceId;
    const registration = await documents.admitWorkspaceRegistration(workspaceId, signal);
    const tools = await sourceTools(input.mode);
    signal.throwIfAborted();
    if (input.mode === 'live_root') {
      if (!liveSources) throw new Error('Live workspace access is unavailable');
      const liveRoot = await liveSources.prepare(workspaceId, workspaceId, input.threadId, signal);
      return { path: registration.canonicalPath, source: { resourceOwner: input.resourceOwner, workspaceId, executionWorkspaceId: workspaceId, mode: 'live_root', liveRoot, tools } };
    }
    return workingStates.withBranchStore(workspaceId, 'source-prepare', async store => {
      const branchId = `source:${key}`;
      const restored = await store.readOriginalSource(branchId, { signal });
      if (restored) {
        if (restored.provenance.consistency === 'fixed-root' || restored.provenance.captureIdentity !== captureIdentity) {
          throw new Error('This source preparation key already has a different selection');
        }
        const pin = await store.pinBranch(branchId, { revision: 0, signal });
        try {
          if (pin.workspaceId !== workspaceId || pin.branchId !== branchId || pin.revision !== 0 || pin.root !== restored.root) {
            throw new SourceAdmissionError('source_changed');
          }
        } finally { await pin.release(); }
        return { path: registration.canonicalPath, source: { resourceOwner: input.resourceOwner, workspaceId, executionWorkspaceId: workspaceId,
          branchId, revision: 0, mode: input.mode, tools }, provenance: restored.provenance } as ThreadPreparedSource;
      }
      if (await store.getBranchRoot(branchId, { signal })) throw new Error('Source preparation has no original receipt');
      const { root } = await documents.inspectWorkspace(workspaceId, { signal });
      const capturedDraft = input.content.mode === 'surface-drafts'
        ? readSourceDrafts({ documents, consumer: { kind: 'thread', threadId: input.threadId, branchId: input.branchId },
          context: input.content.context, workspaceId, signal }) : { editorDrafts: [] };
        const captured = await captureStableSourceBaseline({ store, directory: root, workspaceId, captureWorkspaceId: workspaceId,
          branchId, captureScopes: input.captureScopes, captureIdentity, ...(capturedDraft.drafts ? { drafts: capturedDraft.drafts } : {}),
          editorDrafts: capturedDraft.editorDrafts, signal,
          content: input.content.mode === 'saved-files' ? { mode: 'saved-files' } : { mode: 'fixed-draft-baseline' } },
        { documents, inspectInventory, ...(prepareResources ? { prepareResources } : {}) });
        return { path: root, source: { resourceOwner: input.resourceOwner, workspaceId, executionWorkspaceId: workspaceId,
          branchId: captured.branch.branchId, revision: 0, mode: input.mode, tools }, provenance: captured.provenance } as ThreadPreparedSource;
    }, 'shared', { threadId: input.threadId });
  };
  return async (value: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource> => {
    signal?.throwIfAborted();
    const input = normalizeThreadSourcePreparation(value);
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.key])).digest('hex');
    const identity = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let flight = preparing.get(key);
    if (flight && flight.identity !== identity) throw new Error('This source preparation key already has a different selection');
    if (flight?.controller.signal.aborted) {
      await waitWithSignal(flight.work.then(() => undefined, () => undefined), signal);
      signal?.throwIfAborted();
      flight = preparing.get(key);
    }
    if (!flight) {
      const controller = new AbortController();
      const next: SourcePreparationFlight = { identity, controller, observers: 0,
        work: Promise.resolve().then(() => prepare(input, key, identity, controller.signal))
          .finally(() => { if (preparing.get(key) === next) preparing.delete(key); }) };
      preparing.set(key, next);
      flight = next;
    }
    return observePreparation(flight, signal);
  };
}

/** Submission and every continuation re-admit the same Host source authority. */
export function createThreadSourceAdmission({ documents, withSourceRead, liveSources, runtime, remote }: {
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'>;
  withSourceRead: ThreadResourceScopeOwners['withSourceRead'];
  liveSources?: LiveSourceOwner;
  runtime: AgentRuntimeClient;
  remote?: Pick<ThreadSourceRemoteOwner, 'admit'>;
}) {
  return async (source: ThreadSource, identity: ThreadIdentity, runId?: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const resourceOwner = parseSourceResourceOwner(source.resourceOwner);
    const relation = source.mode === 'live_root' ? null : await runtime.childForThread(identity.threadId, signal);
    const child = relation && runId ? await runtime.childExecutionForRun(runId, signal) : null;
    if (relation && (!runId || !child || child.child_thread_id !== identity.threadId || child.child_branch_id !== identity.branchId
      || child.source?.kind !== 'ready' || !isDeepStrictEqual(child.source.selection.resource_owner, resourceOwner)
      || (child.source.selection.environment_run_id ?? undefined) !== source.environmentRunId || child.source.selection.workspace_id !== source.workspaceId
      || child.source.selection.execution_workspace_id !== source.executionWorkspaceId
      || child.source.selection.branch_id !== source.branchId || child.source.selection.revision !== source.revision
      || child.source.selection.mode !== source.mode)) throw new SourceAdmissionError('source_changed');
    if (resourceOwner.kind === 'managed_host') {
      if (!remote) throw new SourceAdmissionError('source_unavailable');
      await remote.admit(source, identity, runId, signal);
      return;
    }
    if (source.mode === 'live_root') {
      if (!liveSources) throw new SourceAdmissionError('source_unavailable');
      await liveSources.admit(source, identity.threadId, signal);
      return;
    }
    const admitRegistrations = async () => {
      await documents.admitWorkspaceRegistration(source.workspaceId, signal);
      if (source.executionWorkspaceId !== source.workspaceId) await documents.admitWorkspaceRegistration(source.executionWorkspaceId, signal);
    };
    await admitRegistrations();
    await withSourceRead({ identity, source, paths: [''], ...(runId ? { runId } : {}), ...(signal ? { signal } : {}) }, async ({ pin }) => {
      if (pin.workspaceId !== source.workspaceId || pin.branchId !== source.branchId || pin.view !== 'revision'
        || pin.revision !== source.revision || child?.source?.kind === 'ready' && pin.root !== child.source.pin.root) {
        throw new SourceAdmissionError('source_changed');
      }
      await admitRegistrations();
    });
  };
}
