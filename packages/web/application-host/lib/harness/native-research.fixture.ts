/** Explicit native provenance and source-owner seam for domain tests. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExperimentCaller, ResearchOwner } from './research-identity.js';
import { prepareExperimentInput } from './experiment-workspace.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ResearchSourceAuthority } from '../kernel/research-source.js';

type CallerOptions = Partial<ExperimentCaller> & {
  sourceRoot?: string; rootThreadId?: string; threadId?: string; branchId?: string; runId?: string; operationId?: string;
  readThreadIds?: readonly string[]; controlThreadIds?: readonly string[];
};
export function nativeResearchCaller(options: CallerOptions = {}): ExperimentCaller {
  const threadId = options.threadId ?? options.owner?.threadId ?? 'thread';
  const runId = options.runId ?? options.owner?.runId ?? 'run';
  const workspaceId = options.workspaceId ?? 'ws';
  const executionWorkspaceId = options.executionWorkspaceId ?? workspaceId;
  const prior = options.owner;
  const owner: ResearchOwner = {
    runtime: 'agent', actor: prior?.actor.kind === 'tool' || prior?.actor.kind === 'user' ? prior.actor : { kind: 'user', key: randomUUID() },
    rootThreadId: options.rootThreadId ?? prior?.rootThreadId ?? threadId, threadId,
    branchId: options.branchId ?? prior?.branchId ?? `branch:${threadId}`, runId,
    operationId: options.operationId ?? (prior && 'operationId' in prior ? prior.operationId : `operation:${randomUUID()}`),
    executionOwner: prior && 'executionOwner' in prior ? prior.executionOwner : { kind: 'external', identity: 'research-fixture', epoch: 'host-fixture' },
    source: prior ? { ...prior.source, workspace_id: workspaceId, execution_workspace_id: executionWorkspaceId }
      : { resource_owner: { kind: 'local' }, workspace_id: workspaceId, execution_workspace_id: executionWorkspaceId,
        mode: 'live_root', branch_id: null, revision: null, live_root: { hostId: 'fixture-host', rootId: 'fixture-root', canonicalRoot: options.sourceRoot ?? '/fixture/source' } },
  };
  return { workspaceId, executionWorkspaceId, owner, workspaceScope: options.workspaceScope ?? [],
    access: { kind: 'family', readThreadIds: options.readThreadIds ?? (options.access?.kind === 'family' ? [...new Set([...options.access.readThreadIds, threadId])] : [threadId]),
      controlThreadIds: options.controlThreadIds ?? options.readThreadIds ?? (options.threadId && options.threadId !== options.owner?.threadId ? [threadId] : options.access?.kind === 'family' ? options.access.controlThreadIds : [threadId]) } };
}
export function nativeResearchReader(options: CallerOptions = {}): ExperimentCaller {
  const caller = nativeResearchCaller(options);
  const { operationId: _operationId, executionOwner: _executionOwner, ...owner } = caller.owner as ResearchOwner;
  return { ...caller, owner: { ...owner, actor: { kind: 'reader' } } };
}
/** Domain tests inject the source owner, while capture still exercises the production Storage path. */
export function createResearchSourceFixture(client: KernelClient, resolveRoot: () => string | Promise<string>): ResearchSourceAuthority {
  return {
    async admit(caller, cwd, signal) {
      signal?.throwIfAborted();
      const canonicalRoot = await resolveRoot();
      if (caller.owner.source.mode !== 'live_root' || caller.owner.source.live_root?.canonicalRoot !== canonicalRoot) throw new Error('Original native source root changed');
      const relative = cwd ? path.relative(canonicalRoot, path.resolve(canonicalRoot, cwd)).replaceAll('\\', '/') : '';
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Experiment cwd is outside its original source');
      if (caller.workspaceScope?.length && relative && !caller.workspaceScope.some(root => root === '' || relative === root || relative.startsWith(`${root}/`)))
        throw new Error('Experiment cwd is outside its original source scope');
      return { kind: 'physical', canonicalRoot, selection: structuredClone(caller.owner.source), cwd: relative };
    },
    async capture(caller, admitted, options) {
      if (admitted.kind !== 'physical' || !isDeepStrictEqual(admitted.selection, caller.owner.source)) throw new Error('Original source admission changed');
      return prepareExperimentInput(client, caller, admitted.canonicalRoot, { ...options, cwd: admitted.cwd });
    },
    async release() {},
    async reconcileUnaccepted() { return true; },
  };
}
