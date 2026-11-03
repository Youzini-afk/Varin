import { createHash } from 'node:crypto';
import type { ThreadSkillLocator } from '@varin/application-client';
import { relativeResourcePath } from '../agent-resources/source-reader.js';
import { parseSourceResourceOwner } from './thread-sources.js';

export function parseThreadSkillLocator(value: unknown): ThreadSkillLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed skill source locator');
  const locator = value as Record<string, unknown>;
  if (Object.keys(locator).some(key => !['resourceOwner', 'workspaceId', 'domainId', 'path'].includes(key))
    || typeof locator.workspaceId !== 'string' || !locator.workspaceId
    || typeof locator.domainId !== 'string' || !locator.domainId
    || typeof locator.path !== 'string' || !locator.path || relativeResourcePath(locator.path) !== locator.path) {
    throw new Error('Malformed skill source locator');
  }
  return { resourceOwner: parseSourceResourceOwner(locator.resourceOwner), workspaceId: locator.workspaceId, domainId: locator.domainId, path: locator.path };
}
export const skillLocatorId = (locator: ThreadSkillLocator): string => `draft-skill:${createHash('sha256')
  .update(JSON.stringify([locator.resourceOwner, locator.workspaceId, locator.domainId, locator.path])).digest('hex')}`;
/** Document readers expose decoded text; a UTF-8 BOM is not part of skill instructions. */
export const skillTextVersion = (content: string): string => createHash('sha256').update(content.replace(/^\uFEFF/, '')).digest('hex');
