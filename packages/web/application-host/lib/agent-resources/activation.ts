import type { PreparedExplicitSkill } from '../kernel/protocol.generated.js';
import type { PreparedAgentResources, SkillDescriptor } from './authority.js';
import { parseSkill } from './formats.js';
import { referenceKey, resourceFailure, type ResourceResult } from './source-reader.js';

export interface ExplicitSkillCommand {
  name: string;
  arguments: string;
}

/** Match the locked SDK's single leading command and first ASCII-space delimiter.
 * This is selection metadata, never a replacement for the original user text.
 * Name-format diagnostics remain warnings, as in the resource selection owner.
 */
export function parseExplicitSkillCommand(text: string): ExplicitSkillCommand | null {
  if (!text.startsWith('/skill:')) return null;
  const space = text.indexOf(' ');
  return { name: space === -1 ? text.slice(7) : text.slice(7, space),
    arguments: space === -1 ? '' : text.slice(space + 1).trim() };
}

/** Select only the winner already published in the full snapshot, including hidden skills. */
export function selectExplicitSkill(snapshot: PreparedAgentResources, command: ExplicitSkillCommand,
  signal?: AbortSignal): ResourceResult<{ descriptor: SkillDescriptor }> {
  const location = { domainId: 'agent-resources', viewId: snapshot.id };
  if (signal?.aborted) return resourceFailure(location, '', 'cancelled', 'Skill input preparation was cancelled');
  if (!command.name) return resourceFailure(location, '', 'invalid', 'Explicit skill command requires a name');
  const selected = snapshot.skills.filter(skill => skill.name === command.name);
  if (!selected.length) return resourceFailure(location, command.name, 'missing', 'Skill is not selected in this resource snapshot');
  if (selected.length !== 1) return resourceFailure(location, command.name, 'invalid', 'Resource snapshot has no unique selected skill');
  return { status: 'ready', descriptor: selected[0]! };
}

/** Derive resource material from the original capture without opening a source reader.
 * The caller reauthorizes the selected resource through its existing admission owner.
 * Publication, input identity/revision and checkpoint CAS belong to the input owner.
 */
export function prepareExplicitSkillActivation(snapshot: PreparedAgentResources, command: ExplicitSkillCommand,
  signal?: AbortSignal): ResourceResult<{ skill: PreparedExplicitSkill }> {
  const selected = selectExplicitSkill(snapshot, command, signal);
  if (selected.status !== 'ready') return selected;
  const { descriptor } = selected;
  const reference = descriptor.reference;
  const captures = snapshot.capturedFiles.filter(file => referenceKey(file.reference) === referenceKey(reference));
  if (!captures.length) return resourceFailure(reference, reference.path, 'unavailable', 'Selected skill body was not captured in this resource snapshot');
  if (captures.length !== 1) return resourceFailure(reference, reference.path, 'invalid', 'Resource snapshot has more than one capture for the selected skill');
  const capture = captures[0]!;
  if (capture.reference.canonicalId !== reference.canonicalId || capture.reference.version !== reference.version) {
    return resourceFailure(reference, reference.path, 'stale', 'Captured skill reference differs from the selected descriptor');
  }
  let parsed: ReturnType<typeof parseSkill>;
  try { parsed = parseSkill(capture.content, reference.path); }
  catch { return resourceFailure(reference, reference.path, 'invalid', 'Captured skill frontmatter is malformed'); }
  if (!parsed.metadata) return resourceFailure(reference, reference.path, 'invalid', 'Captured skill has no loadable metadata');
  // Discovery may derive a missing name from an admitted display root when the
  // capture path is only SKILL.md. Its selected name is already authoritative;
  // the relative capture path cannot reconstruct that original fallback name.
  if (parsed.metadata.description !== descriptor.description
    || parsed.metadata.disableModelInvocation !== descriptor.disableModelInvocation) {
    return resourceFailure(reference, reference.path, 'stale', 'Captured skill metadata differs from the selected descriptor');
  }
  if (signal?.aborted) return resourceFailure(reference, reference.path, 'cancelled', 'Skill input preparation was cancelled');
  return { status: 'ready', skill: { snapshotId: snapshot.id, resourceId: descriptor.id, reference: { ...reference },
    name: descriptor.name, arguments: command.arguments, body: parsed.body.trim() } };
}
