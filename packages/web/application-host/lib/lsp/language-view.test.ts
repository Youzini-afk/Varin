import { expect, it, vi } from 'vitest';
import { createLanguageViewBinder } from './language-view.js';

it('binds the original admitted native view and revision without reading a same-path live workspace', async () => {
  const readSnapshot = vi.fn(async () => { throw new Error('The old live workspace must not be consulted'); });
  const syncDocument = vi.fn(async () => ({ status: 'synced', documentVersion: 5, generation: 2, viewRevision: 7 }));
  const binder = createLanguageViewBinder({ documents: { readSnapshot }, supervisor: { syncDocument } });
  const bound = await binder.bind({ workspaceId: 'original-workspace', resourceId: 'source.ts', languageId: 'typescript', text: 'disk',
    sourceView: { view: 'agent:source:original', content: 'const captured = 1;\r\n', revision: 'branch:17:original', source: 'working-branch' } });
  expect(bound).toMatchObject({ status: 'bound', view: 'agent:source:original', revision: 'branch:17:original',
    languageRevision: 'branch:17:original', source: 'working-branch', documentVersion: 5, generation: 2, viewRevision: 7 });
  expect(syncDocument).toHaveBeenCalledWith(expect.objectContaining({ view: 'agent:source:original',
    content: 'const captured = 1;\r\n', contentRevision: 'branch:17:original', fixed: true }));
  expect(readSnapshot).not.toHaveBeenCalled();
});

it('leaves an unavailable saved document unavailable without synchronizing invented text', async () => {
  const readSnapshot = vi.fn(async () => ({ status: 'missing' as const, resource: { workspaceId: 'workspace', resourceId: 'missing.ts' }, epoch: 1 }));
  const syncDocument = vi.fn();
  const binder = createLanguageViewBinder({ documents: { readSnapshot }, supervisor: { syncDocument } });
  expect(await binder.bind({ workspaceId: 'workspace', resourceId: 'missing.ts', languageId: 'typescript', text: 'disk' }))
    .toMatchObject({ status: 'unavailable', message: expect.stringMatching(/missing/) });
  expect(syncDocument).not.toHaveBeenCalled();
});
