import { isDeepStrictEqual } from 'node:util';
import { parseThreadSkillLocator, skillLocatorId, skillTextVersion } from './thread-skill-selection.js';
import { referenceKey } from '../agent-resources/source-reader.js';
import type { ThreadIdentity, ThreadSkillSelection } from '@varin/application-client';
import { parseExplicitSkillCommand, prepareExplicitSkillActivation, selectExplicitSkill, type ExplicitSkillCommand } from '../agent-resources/activation.js';
import { resourceFailure, type ResourceResult } from '../agent-resources/source-reader.js';
import { resourceThreadSource } from './thread-context.js';
import type { ContextResources, PreparedExplicitSkill } from './protocol.generated.js';
import { ResourceScopeError, type ThreadResourceScope } from './thread-resource-scope.js';

/** Selectors carry no body, path grant or renderer-chosen source. Their range uses editor UTF-16 offsets. */
export function parseThreadSkills(value: unknown, text: string): ThreadSkillSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Skills must be an array');
  const selections = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['resourceId', 'version', 'start', 'end', 'locator'].includes(key))
      || typeof item.resourceId !== 'string' || !item.resourceId.trim()
      || typeof item.version !== 'string' || !item.version.trim()
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < 0 || item.end <= item.start || item.end > text.length
      || !text.slice(item.start, item.end).startsWith('/skill:') || item.end - item.start <= 7) {
      throw new Error('Malformed explicit skill selection');
    }
    const locator = item.locator === undefined ? undefined : parseThreadSkillLocator(item.locator);
    if (locator && skillLocatorId(locator) !== item.resourceId) throw new Error('Skill source locator does not match its identity');
    return { resourceId: item.resourceId, version: item.version, start: item.start, end: item.end, ...(locator ? { locator } : {}) };
  }).sort((left, right) => left.start - right.start);
  if (selections.some((item, index) => index > 0 && item.start < selections[index - 1]!.end)) {
    throw new Error('Explicit skill selections cannot overlap');
  }
  return selections;
}

export interface ThreadSkillInputPreparer {
  (identity: ThreadIdentity, resources: ContextResources | undefined, text: string,
    signal?: AbortSignal, selections?: readonly ThreadSkillSelection[]): Promise<ResourceResult<{
      skill: PreparedExplicitSkill | null; skills?: PreparedExplicitSkill[];
    }>>;
}

/** Host-only adjunct preparation. It cannot admit an input or create a Run/tool call.
 * The adapter supplies its actual context, never a renderer-supplied snapshot or body.
 * Receipt replay and unchanged-input edits reuse their persisted selection upstream.
 */
export function createThreadSkillInputPreparer(scope: Pick<ThreadResourceScope, 'withScope'>): ThreadSkillInputPreparer {
  return async (identity, resources, text, signal, selections) => {
    const location = { domainId: 'agent-resources', viewId: resources?.snapshot.id ?? 'input' };
    if (signal?.aborted) return resourceFailure(location, '', 'cancelled', 'Skill input preparation was cancelled');
    let commands: Array<ExplicitSkillCommand & { selection?: ThreadSkillSelection }>;
    if (selections?.length) {
      let parsed;
      try { parsed = parseThreadSkills(selections, text)!; }
      catch { return resourceFailure(location, '', 'invalid', 'Explicit skill selection does not match the input'); }
      commands = parsed.map(selection => ({ name: text.slice(selection.start + 7, selection.end), arguments: '',
        resourceId: selection.resourceId, version: selection.version, selection }));
    } else {
      const command = parseExplicitSkillCommand(text);
      if (!command) return { status: 'ready', skill: null };
      commands = [command];
    }
    if (commands.some(command => !command.name)) return resourceFailure(location, '', 'invalid', 'Explicit skill command requires a name');
    if (!resources) return resourceFailure(location, commands[0]!.name, 'unavailable', 'Input context has no prepared resource snapshot');
    const { snapshot } = resources;
    let source;
    try { source = resourceThreadSource(resources.source); }
    catch { return resourceFailure(location, '', 'invalid', 'Resource snapshot has invalid source provenance'); }
    const skills: PreparedExplicitSkill[] = [];
    const seen = new Map<string, string>();
    for (const rawCommand of commands) {
      let command = rawCommand;
      const locator = rawCommand.selection?.locator;
      if (locator) {
        if (!resources.source || resources.source.workspace_id !== locator.workspaceId
          || !isDeepStrictEqual(resources.source.resource_owner, locator.resourceOwner)) {
          return resourceFailure(location, locator.path, 'stale', 'Selected skill belongs to a different execution source');
        }
        const matches = snapshot.skills.filter(skill => skill.reference.domainId === locator.domainId && skill.reference.path === locator.path);
        if (matches.length !== 1) return resourceFailure(location, locator.path, matches.length ? 'invalid' : 'missing', 'Selected skill source is no longer uniquely available');
        const descriptor = matches[0]!;
        const capture = snapshot.capturedFiles.find(file => referenceKey(file.reference) === referenceKey(descriptor.reference));
        if (!capture || skillTextVersion(capture.content) !== rawCommand.version) {
          return resourceFailure(location, locator.path, 'stale', 'Selected skill changed after discovery; choose it again');
        }
        command = { ...rawCommand, resourceId: descriptor.id, version: descriptor.reference.version };
      }
      const selected = selectExplicitSkill(snapshot, command, signal);
      if (selected.status !== 'ready') return selected;
      // Validate every occurrence before deduplicating so an edited duplicate cannot hide stale metadata.
      const selectedIdentity = JSON.stringify([rawCommand.resourceId ?? selected.descriptor.id, rawCommand.version ?? selected.descriptor.reference.version]);
      const previousIdentity = seen.get(selected.descriptor.id);
      if (previousIdentity !== undefined) {
        if (previousIdentity !== selectedIdentity) return resourceFailure(location, command.name, 'invalid', 'Selections use different identities for the same skill; select it again');
        continue;
      }
      const request = { kind: 'skill' as const, resourceId: selected.descriptor.id };
      try {
        const prepared = await scope.withScope(identity, source, { mode: snapshot.scope.mode, threadRole: snapshot.scope.threadRole,
          projectId: snapshot.scope.projectId }, async () => prepareExplicitSkillActivation(snapshot, command, signal),
        { snapshot, request, ...(signal ? { signal } : {}) });
        if (prepared.status !== 'ready') return prepared;
        skills.push(locator ? { ...prepared.skill, selection: { resourceId: rawCommand.resourceId!, version: rawCommand.version! } } : prepared.skill);
        seen.set(selected.descriptor.id, selectedIdentity);
      } catch (error) {
        if (signal?.aborted || (error as Error)?.name === 'AbortError') {
          return resourceFailure(location, '', 'cancelled', 'Skill input preparation was cancelled');
        }
        if (error instanceof ResourceScopeError) return error.failure;
        throw error;
      }
    }
    return selections?.length ? { status: 'ready', skill: null, skills } : { status: 'ready', skill: skills[0]! };
  };
}
