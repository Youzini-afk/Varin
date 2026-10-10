import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { Followup, FollowupRegisterParams, FollowupRegistrationTrigger } from './protocol.generated.js';
import type { LiveSourceResolver } from './live-source.js';

/** Same relative-path admission as Storage: preserve names, reject parent/root components. */
export function followupFilePaths(trigger: FollowupRegistrationTrigger): string[] {
  const sources = trigger.kind === 'any' || trigger.kind === 'all' ? trigger.sources : [trigger];
  return [...new Set(sources.flatMap(source => {
    if (source.kind !== 'file') return [];
    const normalized = source.path.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (!normalized || normalized.includes('\0') || path.parse(normalized).root !== ''
      || segments[0] === '.' || segments.includes('..')) throw new Error('File follow-up requires a relative source path');
    const value = segments.filter(segment => segment !== '' && segment !== '.').join('/');
    if (!value) throw new Error('File follow-up requires a relative source path');
    return [value];
  }))];
}

/** User admission grants only these original-source reads. Storage keeps the accepted
 * receipt's provenance; ordinary cleanup retires this caller, never revokes its observer. */
export async function registerUserFollowup(kernel: KernelClient, runtime: AgentRuntimeClient,
  input: FollowupRegisterParams, validateLiveSource?: LiveSourceResolver, signal?: AbortSignal): Promise<Followup> {
  const paths = followupFilePaths(input.trigger);
  if (!paths.length) return kernel.agentRuntimeRequest('runtime.followup.register', input, signal);
  const [run, launch] = await Promise.all([runtime.run(input.runId, signal), runtime.launch(input.runId, signal)]);
  const source = launch?.selection.source;
  if (!source) throw new Error('File follow-up requires the original Run source');
  if (source.mode === 'live_root') {
    if (!source.live_root || !validateLiveSource) throw new Error('Live source owner is unavailable');
    await validateLiveSource({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      liveRoot: source.live_root }, signal);
  }
  signal?.throwIfAborted();
  const grant = await kernel.issueGrant({ grantId: `file-observation-user:${randomUUID()}`,
    owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
    threadId: run.thread_id, capabilities: ['storage.read'], pathScopes: paths }, signal);
  try {
    signal?.throwIfAborted();
    return await kernel.agentRuntimeRequest('runtime.followup.register', {
      ...input, fileAuthority: { grantId: grant.grantId },
    }, signal);
  } finally {
    // Request cancellation or an unknown reply must not destroy an already accepted
    // observation. This read-only grant owns no process that can delay retirement.
    await kernel.retireGrant(grant.grantId);
  }
}
