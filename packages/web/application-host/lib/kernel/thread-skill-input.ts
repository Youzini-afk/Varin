import type { ThreadIdentity } from '@varin/application-client';
import { parseExplicitSkillCommand, prepareExplicitSkillActivation, selectExplicitSkill } from '../agent-resources/activation.js';
import { resourceFailure, type ResourceResult } from '../agent-resources/source-reader.js';
import { resourceThreadSource } from './thread-context.js';
import type { ContextResources, PreparedExplicitSkill } from './protocol.generated.js';
import { ResourceScopeError, type ThreadResourceScope } from './thread-resource-scope.js';

export interface ThreadSkillInputPreparer {
  (identity: ThreadIdentity, resources: ContextResources | undefined, text: string,
    signal?: AbortSignal): Promise<ResourceResult<{ skill: PreparedExplicitSkill | null }>>;
}

/** Host-only adjunct preparation. It cannot admit an input or create a Run/tool call.
 * The adapter supplies its actual context, never a renderer-supplied snapshot or body.
 * Receipt replay and unchanged-text edits reuse their persisted selection upstream.
 */
export function createThreadSkillInputPreparer(scope: Pick<ThreadResourceScope, 'withScope'>): ThreadSkillInputPreparer {
  return async (identity, resources, text, signal) => {
    const location = { domainId: 'agent-resources', viewId: resources?.snapshot.id ?? 'input' };
    if (signal?.aborted) return resourceFailure(location, '', 'cancelled', 'Skill input preparation was cancelled');
    const command = parseExplicitSkillCommand(text);
    if (!command) return { status: 'ready', skill: null };
    if (!command.name) return resourceFailure(location, '', 'invalid', 'Explicit skill command requires a name');
    if (!resources) return resourceFailure(location, command.name, 'unavailable', 'Input context has no prepared resource snapshot');
    const { snapshot } = resources;
    const selected = selectExplicitSkill(snapshot, command, signal);
    if (selected.status !== 'ready') return selected;
    const request = { kind: 'skill' as const, resourceId: selected.descriptor.id };
    let source;
    try { source = resourceThreadSource(resources.source); }
    catch { return resourceFailure(location, '', 'invalid', 'Resource snapshot has invalid source provenance'); }
    try {
      return await scope.withScope(identity, source, { mode: snapshot.scope.mode, threadRole: snapshot.scope.threadRole,
        projectId: snapshot.scope.projectId }, async () => prepareExplicitSkillActivation(snapshot, command, signal),
      { snapshot, request, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === 'AbortError') {
        return resourceFailure(location, '', 'cancelled', 'Skill input preparation was cancelled');
      }
      if (error instanceof ResourceScopeError) return error.failure;
      throw error;
    }
  };
}
