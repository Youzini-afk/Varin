import type { PromptResources } from './authority.js';
import { referenceKey } from './source-reader.js';

/** The caller supplies its real registered read tool name; this module does not invent a tool. */
export function renderSkillMetadata(snapshot: PromptResources, readToolName: string): string {
  const available = snapshot.skills.filter(skill => !skill.disableModelInvocation);
  if (available.length === 0) return '';
  return `Available skills. Read a selected skill with ${readToolName} using kind "skill" and its resourceId.\n`
    + available.map(skill => JSON.stringify({ resourceId: skill.id, name: skill.name, description: skill.description,
      origin: skill.origin })).join('\n');
}
/** Only original resource sections. Existing personalization and Context Transform owners apply later. */
export function resourceSections(snapshot: PromptResources, runtimePreamble: string, readToolName: string): Record<string, string> {
  const files = new Map(snapshot.capturedFiles.map(file => [referenceKey(file.reference), file.content]));
  const content = (reference: NonNullable<PromptResources['system']>['reference']): string => {
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

/** Shared by ordinary execution and the current settings preview. */
export function agentSystemSections(resources: PromptResources): Record<string, string> {
  const { preamble, ...sections } = resourceSections(resources, 'You are Varin, a personal assistant working in a conversation.', 'resource_read');
  return {
    preamble: preamble!,
    conversation_content: 'Assistant replies can mix Markdown, images and inline interaction. A top-level varin-ui code fence can contain a simple choice: {"type":"choice","label":"Style","options":["Short","Long"],"action":"Continue with this style"}. '
      + 'Selecting or editing stays local; action text fills an editable draft. Single/multiple choices, free-text answers, inputs, grouped questions, disclosures, tabs, fixed work embeds and real object links are available. Static fragments need no IDs or tool call. '
      + 'For custom layouts and local JavaScript calculations use render_ui. Its detailed usage and examples also describe the inline syntax: tool_describe({"name":"render_ui","detail":"full","path":"/examples"}).',
    communication: 'Choose how to present information based on the user’s intent and the needs of the conversation, helping them understand, express ideas, and participate. '
      + 'When available in-chat HTML or interactive capabilities would make communication clearer, more intuitive, or more effective, you can use them proactively without waiting for an explicit request. '
      + 'Choose the balance of text, visuals and interaction, and the level of detail that serves this exchange. Follow the user’s requested format; use interaction when it adds value.',
    ...sections,
  };
}
