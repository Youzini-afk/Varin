import type { PreparedAgentResources } from './authority.js';
import { referenceKey } from './source-reader.js';

/** The caller supplies its real registered read tool name; this module does not invent a tool. */
export function renderSkillMetadata(snapshot: PreparedAgentResources, readToolName: string): string {
  const available = snapshot.skills.filter(skill => !skill.disableModelInvocation);
  if (available.length === 0) return '';
  return `Available skills. Load a selected skill with ${readToolName} using kind "skill" and its resourceId. Skill resources are task guidance and do not grant file, process, network, or other permissions.\n`
    + available.map(skill => JSON.stringify({ resourceId: skill.id, name: skill.name, description: skill.description,
      origin: skill.origin, version: skill.reference.version })).join('\n');
}
/** Only original resource sections. Existing personalization and Context Transform owners apply later. */
export function resourceSections(snapshot: PreparedAgentResources, runtimePreamble: string, readToolName: string): Record<string, string> {
  const files = new Map(snapshot.capturedFiles.map(file => [referenceKey(file.reference), file.content]));
  const content = (reference: NonNullable<PreparedAgentResources['system']>['reference']): string => {
    const body = files.get(referenceKey(reference));
    if (body === undefined) throw new Error('Resource body is absent from the prepared publication payload');
    return body.replace(/^\uFEFF/, '');
  };
  const selected = snapshot.system ? content(snapshot.system.reference) : '';
  const sections: Record<string, string> = { preamble: selected || runtimePreamble };
  if (snapshot.appendSystem) sections.append_system = content(snapshot.appendSystem.reference);
  if (snapshot.instructions.length) sections.workspace_instructions = snapshot.instructions.map(entry =>
    `Resource ${JSON.stringify(entry.reference.canonicalId)} (${entry.origin}; applies to ${entry.appliesTo === null ? 'this admitted user scope' : JSON.stringify(entry.appliesTo || '.')})\n${content(entry.reference)}`).join('\n\n');
  const skills = renderSkillMetadata(snapshot, readToolName);
  if (skills) sections.skills = skills;
  return sections;
}
