import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadsAPI, ThreadIdentity } from '@varin/application-client';
import type { ChildReportPage, StoredMedia } from '@varin/protocol';
import { ThreadChildReport } from './ThreadChildReport';

const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'parent', branchId: 'parent-branch' };
const media: StoredMedia = { media_type: 'image/png', content_ref: { content_object: 'sha256-child-image' }, source: { kind: 'operation', operation_id: 'original-child-capture' } };
const body = JSON.stringify({ data: { count: 2, kind: 'media', data_base64: 'opaque-lookalike' }, parts: [
  { kind: 'text', text: '原始报告 before' }, { kind: 'media', media }, { kind: 'text', text: 'after image' },
] });
const cut = body.indexOf('before') + 3;
const firstText = body.slice(0, cut); const secondText = body.slice(cut);
const first: ChildReportPage = { format: 'output_body', operation_id: 'dispatch', execution_id: 'execution-original', item_id: 'report-original',
  offset: 0, next_offset: new TextEncoder().encode(firstText).length, total_bytes: new TextEncoder().encode(body).length, text: firstText };
const last: ChildReportPage = { ...first, offset: first.next_offset!, next_offset: null, text: secondText };
function fixture() {
  const readReport = vi.fn<NonNullable<ThreadsAPI['collaboration']>['readReport']>(async (_identity, _operation, _item, offset) => offset ? last : first);
  const readExecutionReport = vi.fn<NonNullable<ThreadsAPI['collaboration']>['readExecutionReport']>(async (_identity, _execution, _item, offset) => offset ? last : first);
  const mediaRead = vi.fn<ThreadsAPI['mediaRead']>(async input => ({ media, partIndex: input.partIndex, chunkIndex: 0, chunkCount: 1, totalBytes: 3, bytesBase64: 'AQID' }));
  return { readReport, readExecutionReport, mediaRead, api: { collaboration: { readReport, readExecutionReport }, mediaRead } as unknown as ThreadsAPI };
}
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:child-report'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const click = async (text: string) => { await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === text)!.click()); };
const render = async (api: ThreadsAPI, selected = identity, executionId?: string) => { await act(async () => root.render(<ThreadChildReport api={api} identity={selected} operationId="dispatch" executionId={executionId} itemId="report-original" />)); };

it.each([undefined, 'execution-original'])('assembles the complete original UTF-8 output report before rendering, using execution %s', async executionId => {
  const f = fixture(); let finish!: (page: ChildReportPage) => void;
  const reader = executionId ? f.readExecutionReport : f.readReport;
  reader.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(f.api, identity, executionId); await click(executionId ? 'Read execution report' : 'Read report');
  expect(container.querySelector('[aria-label="Typed output"]')).toBeNull();
  expect(container.textContent).not.toContain('原始报告 before');
  expect(container.textContent).toContain(`${first.next_offset} of ${first.total_bytes} bytes`);
  expect(reader.mock.calls[1]![3]).toBe(first.next_offset);
  await act(async () => finish(last));
  const content = container.querySelector('[aria-label="Typed output"]')!;
  expect([...content.children].map(value => value.tagName)).toEqual(['P', 'FIGURE', 'P', 'DETAILS']);
  expect(content.textContent).toContain('原始报告 before'); expect(content.textContent).toContain('after image');
  expect(content.textContent).toContain('opaque-lookalike'); expect(container.querySelectorAll('figure')).toHaveLength(1);
  expect(f.mediaRead).not.toHaveBeenCalled(); await click('View image');
  expect(f.mediaRead).toHaveBeenCalledExactlyOnceWith({ ...identity, holder: { kind: 'child_report', operationId: 'dispatch', executionId: 'execution-original', itemId: 'report-original' }, partIndex: 1, chunkIndex: 0, expectedContentRef: 'sha256-child-image' }, expect.any(AbortSignal));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:child-report');
});

it('keeps ordinary text report paging and never infers typed media from its JSON-looking text', async () => {
  const f = fixture(); const text = JSON.stringify({ data: null, parts: [{ kind: 'media', media }] });
  const split = Math.floor(text.length / 2);
  f.readReport.mockResolvedValueOnce({ ...first, format: 'text', text: text.slice(0, split), next_offset: split, total_bytes: text.length })
    .mockResolvedValueOnce({ ...first, format: 'text', text: text.slice(split), offset: split, next_offset: null, total_bytes: text.length });
  await render(f.api); await click('Read report'); expect(f.readReport).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(text.slice(0, split)); expect(container.querySelector('figure')).toBeNull();
  await click('Read next page'); expect(f.readReport.mock.calls[1]![3]).toBe(split);
  expect(container.textContent).toContain(text.slice(split)); expect(f.mediaRead).not.toHaveBeenCalled();
});

it.each(['cancel', 'thread', 'host'] as const)('discards an unfinished original report on %s without publishing partial output', async change => {
  const f = fixture(); let finish!: (page: ChildReportPage) => void;
  f.readReport.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(f.api); await click('Read report'); const signal = f.readReport.mock.calls[1]![5]!;
  if (change === 'cancel') await click('Cancel report read');
  else if (change === 'thread') await render(f.api, { ...identity, threadId: 'next-parent' });
  else await act(async () => { endpoint.generation += 1; endpoint.listeners.forEach(listener => listener()); });
  expect(signal.aborted).toBe(true); await act(async () => finish(last));
  expect(container.querySelector('[aria-label="Typed output"]')).toBeNull(); expect(f.mediaRead).not.toHaveBeenCalled();
});

it.each([
  { execution_id: 'other-execution' }, { operation_id: 'other-dispatch' }, { item_id: 'other-item' },
  { total_bytes: last.total_bytes + 1 }, { offset: last.offset + 1 }, { format: 'text' as const }, { next_offset: last.offset },
])('rejects a changed report page rather than mixing it into the original output: %s', async changed => {
  const f = fixture(); f.readReport.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...last, ...changed });
  await render(f.api); await click('Read report');
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.querySelector('[aria-label="Typed output"]')).toBeNull();
  expect(f.mediaRead).not.toHaveBeenCalled(); await click('Retry report read');
  expect(f.readReport.mock.calls[2]![3]).toBe(0); expect(container.textContent).toContain('after image');
});

it('reports malformed complete output without exposing raw partial JSON and keeps retries on the original report', async () => {
  const f = fixture(); const invalid = '{"data":"private raw fragment';
  f.readReport.mockResolvedValueOnce({ ...first, text: invalid, total_bytes: new TextEncoder().encode(invalid).length, next_offset: null });
  await render(f.api); await click('Read report');
  expect(container.textContent).toContain('incomplete or invalid');
  expect(container.textContent).not.toContain('private raw fragment');
  expect(container.querySelector('[aria-label="Typed output"]')).toBeNull();
  await click('Retry report read'); expect(container.textContent).toContain('after image');
  expect(f.readReport.mock.calls.every(call => call[1] === 'dispatch' && call[2] === 'report-original')).toBe(true);
});
