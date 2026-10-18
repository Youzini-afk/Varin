import { expect, it, vi } from 'vitest';
import type { UiReceipt, UiSource } from '@varin/application-client';
import { projectUiWork, releaseUiWork } from './work-projection';
import type { UiSession } from './sessions';

const api = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  createInteractiveUiHttpAPI: () => api, getRuntimeEndpointGeneration: () => 1, subscribeRuntimeEndpointWillChange: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ formatMessage: (_dictionary: unknown, key: string) => key, useI18nStore: { getState: () => ({ dictionary: {} }) } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ openContextPanelTab: vi.fn() }) } }));
const session = (): UiSession => ({ key: 'card', identity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, host: 1, placement: 'inline' });
const receipt: UiReceipt = { kind: 'ui', ref: 'ui:work@1', workRef: 'ui:work', title: '报告', entry: 'index.html', files: ['index.html'], revision: 1 };

it('streams nested gateway HTML and its selected entry before the tool finishes', () => {
  const current = session();
  const raw = '{"reference":{"name":"render_ui","version":"1"},"arguments":{"entry":"report.html","changes":[{"file":"report.html","op":"write","text":"<h1>生成中';
  try {
    projectUiWork(current, { type: 'toolCall', id: 'call', name: 'render_ui', arguments: {}, rawArguments: raw }, undefined, true, false);
    expect(current.display).toMatchObject({ entry: 'report.html', files: { 'report.html': '<h1>生成中' }, committed: false });
    projectUiWork(current, { type: 'toolCall', id: 'call', name: 'render_ui', arguments: {}, rawArguments: raw + '内容</h1>"}]}}' }, undefined, true, false);
    expect(current.display?.files['report.html']).toBe('<h1>生成中内容</h1>');
  } finally { releaseUiWork(current); }
});

it('keeps completed HTML available for preview and source while a remounted card loads the saved revision', async () => {
  let finish!: (source: UiSource) => void;
  api.source.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const current = session(), html = '<h1>已完成的报告</h1>';
  try {
    projectUiWork(current, { type: 'toolCall', id: 'call', name: 'render_ui', arguments: {}, rawArguments: '{"title":"报告"' }, undefined, true, false);
    expect(current.display?.files).toEqual({});
    projectUiWork(current, { type: 'toolCall', id: 'call', name: 'render_ui', arguments: { changes: [{ file: 'index.html', op: 'write', text: html }] } }, receipt, false, false);
    expect(current.display).toMatchObject({ files: { 'index.html': html }, committed: false });
    expect(api.source).toHaveBeenLastCalledWith(current.identity, receipt.ref, expect.any(AbortSignal));
    finish({ ...receipt, contents: { 'index.html': html }, assets: {} });
    await Promise.resolve();
    expect(current.display).toMatchObject({ source: { ref: receipt.ref }, files: { 'index.html': html }, committed: true });
  } finally { releaseUiWork(current); }
});
