import { expect, test } from 'vitest';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { composerInputReferences } from './references';
import type { ComposerReference } from '../editor/references';
const host = getRuntimeEndpointGeneration();
const skill: ComposerReference = { id: 'a', from: 2, to: 15, text: '/skill:review', host,
  target: { kind: 'skill', resourceId: 'skill:exact', version: 'v1', locator: { resourceOwner: { kind: 'local' }, workspaceId: 'workspace', domainId: 'project', path: 'skills/review/SKILL.md' } } };
test('keeps precise skill provenance and raw UTF-16 display range', () => {
  const text = '前 /skill:review 后';
  expect(composerInputReferences(text, [skill]).skills).toEqual([{ start: 2, end: 15, resourceId: 'skill:exact', version: 'v1', locator: skill.target.kind === 'skill' ? skill.target.locator : undefined }]);
  expect(composerInputReferences(text.replace('review', 'other!'), [skill])).toEqual({});
});
test('a readable task reference never becomes an implicit recipient', () => {
  const target = { runtime: 'agent' as const, threadId: 'task-1', branchId: 'branch-2' };
  expect(composerInputReferences('@Review', [{ id: 'b', host, text: '@Review', from: 0, to: 7, target: { kind: 'thread', identity: target } }])).toEqual({ references: [{ kind: 'thread', threadId: 'task-1', branchId: 'branch-2', start: 0, end: 7 }] });
});
test('source and Host changes reject old bindings rather than relabeling their authority', () => {
  const directory: ComposerReference = { id: 'd', host, from: 0, to: 8, text: '@my docs', target: { kind: 'directory', path: '/project/my docs', workspacePath: '/project', sourceKey: 'first-source' } };
  expect(() => composerInputReferences(directory.text, [directory], 'other-source')).toThrow('earlier source');
  expect(() => composerInputReferences(directory.text, [{ ...directory, host: host + 1 }], 'first-source')).toThrow('different Host');
  expect(composerInputReferences(directory.text, [directory], 'first-source').references).toEqual([{ kind: 'directory', path: '/project/my docs', start: 0, end: 8 }]);
});
