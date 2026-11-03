import { getRuntimeEndpointGeneration, type ThreadSkillSelection, type ThreadObjectReference } from '@varin/application-client';
import type { ComposerReference } from '../editor/references';

/** Preserve display ranges until the original Host resolves resource and family authority. */
export function composerInputReferences(text: string, references: readonly ComposerReference[] = [], sourceKey?: string): { skills?: ThreadSkillSelection[]; references?: ThreadObjectReference[] } {
  const skills: ThreadSkillSelection[] = [], objects: ThreadObjectReference[] = [];
  for (const reference of references) {
    if (text.slice(reference.from, reference.to) !== reference.text) continue;
    if (reference.host !== getRuntimeEndpointGeneration()) throw new Error('The referenced object belongs to a different Host. Select it again.');
    const range = { start: reference.from, end: reference.to }, target = reference.target;
    if (target.kind === 'skill') skills.push({ ...range, resourceId: target.resourceId, version: target.version, ...(target.locator ? { locator: target.locator } : {}) });
    if (target.kind === 'thread') objects.push({ ...range, kind: 'thread', threadId: target.identity.threadId, branchId: target.identity.branchId });
    if ((target.kind === 'directory' || target.kind === 'file') && sourceKey !== undefined && target.sourceKey !== sourceKey) throw new Error('The referenced file belongs to an earlier source. Select it again.');
    if (target.kind === 'directory') objects.push({ ...range, kind: 'directory', path: target.path });
  }
  return { ...(skills.length ? { skills } : {}), ...(objects.length ? { references: objects } : {}) };
}
