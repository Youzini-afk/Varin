import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentReadRequest, FetchResult } from '@varin/protocol';

const mocks = vi.hoisted(() => ({
  runtimeKey: 'runtime-a',
  runtimeFetch: vi.fn(),
  addRegion: vi.fn(),
  translate: (key: string) => key,
  generation: 1, changed: new Set<() => void>(), changing: new Set<() => void>(),
}));

vi.mock('@varin/application-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@varin/application-client')>();
  return {
    ...actual,
    getRuntimeEndpointGeneration: () => mocks.generation,
    subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.changed.add(listener); return () => mocks.changed.delete(listener); },
    subscribeRuntimeEndpointWillChange: (listener: () => void) => { mocks.changing.add(listener); return () => mocks.changing.delete(listener); },
    runtimeFetch: mocks.runtimeFetch,
    getRuntimeKey: () => mocks.runtimeKey,
  };
});
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children, onOpenChange }: { open: boolean; children: React.ReactNode; onOpenChange?: (value: boolean) => void }) => open ? <div role="dialog"><button onClick={() => onOpenChange?.(false)}>Close material</button>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>, SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-testid="pdf-text">{content}</div> }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/pi-runtime/addPdfMaterialToDraft', () => ({ addPdfMaterialRegionToDraft: mocks.addRegion }));

import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { ThreadMaterials } from './ThreadMaterials';
import type { ThreadMaterialsAPI, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { ThreadContent } from './ThreadContent';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { usePdfMaterialLinkInteractions } from '@/components/materials/usePdfMaterialLinkInteractions';
import { PDF_MATERIAL_OPEN_EVENT, formatPdfMaterialCitationUrl, pdfMaterialMarkdownHref } from '@/lib/pi-runtime/pdfMaterialCitation';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

const okOverview = (snapshotId: string, sourceHash: string): FetchResult => ({
  status: 'ok',
  url: 'https://example.test/paper.pdf',
  finalUrl: 'https://example.test/paper.pdf',
  contentType: 'application/pdf',
  markdown: '',
  bytes: 100,
  fromCache: true,
  rendered: false,
  snapshot: {
    snapshotId,
    sourceUrl: 'https://example.test/paper.pdf',
    finalUrl: 'https://example.test/paper.pdf',
    fetchedAt: 1,
    contentHash: `text-${sourceHash}`,
    representation: 'pdf-text',
    byteLength: 100,
    document: { kind: 'pdf', pageCount: 3, parser: 'native', source: { contentHash: sourceHash, byteLength: 100, contentType: 'application/pdf' } },
  },
  overview: {
    sourceHash,
    sourceSnapshotId: `original-${snapshotId}`,
    pageCount: 3,
    pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
    textStatus: 'available',
  },
});

const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

let root: Root;
let container: HTMLElement;
let priorObjectUrl: typeof URL.createObjectURL | undefined;
let priorRevokeUrl: typeof URL.revokeObjectURL | undefined;
let objectUrlMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Element', dom.Element);
  vi.stubGlobal('HTMLAnchorElement', dom.HTMLAnchorElement);
  vi.stubGlobal('CustomEvent', dom.CustomEvent);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('Event', dom.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  usePiSessionStore.setState({ currentSessionId: null, runtimeKey: 'runtime-a' });
  mocks.runtimeKey = 'runtime-a'; mocks.generation = 1;
  mocks.runtimeFetch.mockReset();
  mocks.addRegion.mockReset().mockReturnValue('added');
  mocks.translate = (key: string) => key;
  priorObjectUrl = URL.createObjectURL;
  priorRevokeUrl = URL.revokeObjectURL;
  objectUrlMock = vi.fn(() => `blob:page-${objectUrlMock.mock.calls.length}`);
  URL.createObjectURL = objectUrlMock as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  if (priorObjectUrl) URL.createObjectURL = priorObjectUrl;
  if (priorRevokeUrl) URL.revokeObjectURL = priorRevokeUrl;
  vi.clearAllMocks();
});

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const respond = (request: DocumentReadRequest): FetchResult => {
  const result = okOverview(request.snapshotId!, 'hash-a') as Extract<FetchResult, { status: 'ok' }>;
  if (request.view === 'page-image') result.pageImages = [{ page: request.page ?? 1, width: 100, height: 200, data: 'AQID', mimeType: 'image/png', byteLength: 3, sourceHash: 'hash-a' }];
  if (request.view === 'text') result.markdown = 'Retained page text';
  if (request.view === 'structure') result.structure = { headings: [{ level: 1, title: 'Retained heading', line: 1 }] };
  return result;
};
const mediaAPI = { mediaRead: vi.fn() } as Pick<ThreadsAPI, 'mediaRead'>;
function History({ data = okOverview('snapshot-a', 'hash-a') }: { data?: unknown }) {
  return <ThreadContent api={mediaAPI} identity={identity} holder={{ kind: 'history', itemId: 'original-tool-result' }} messageId="original-tool-result"
    parts={historyParts({ content: { kind: 'tool_result', result: { completion: { kind: 'result', content: { data, parts: [] } } } } }, 'tool')} />;
}
function Citation({ snapshotId = 'material:citation' }: { snapshotId?: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null); usePdfMaterialLinkInteractions({ containerRef });
  return <div ref={containerRef}><a data-varin-material-link="true" href={pdfMaterialMarkdownHref(formatPdfMaterialCitationUrl({ snapshotId, page: 2 }))}>Cited page</a></div>;
}
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent?.includes(label));
  expect(button).toBeTruthy(); await act(async () => { button!.click(); await settle(); });
};
const render = async (api: ThreadMaterialsAPI, selected = identity, data: unknown = okOverview('snapshot-a', 'hash-a')) => {
  await act(async () => { root.render(<ThreadMaterials api={api} identity={selected}><History data={data} /></ThreadMaterials>); await settle(); });
};

it('opens a tool-result material through the original Thread and shares page, text, structure and errors', async () => {
  const read = vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request)); const api = { read };
  await render(api); expect(read).not.toHaveBeenCalled(); await click('Read PDF');
  expect(read.mock.calls.map(call => [call[0], call[1].view])).toEqual([[identity, 'overview'], [identity, 'page-image']]);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:page-1');
  expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  await click('harness.pdf.textView');
  expect(read.mock.calls.at(-1)?.[1]).toMatchObject({ snapshotId: 'snapshot-a', view: 'text', pages: [1] });
  expect(container.textContent).toContain('Retained page text');
  await click('harness.pdf.structureView'); await click('harness.pdf.analyzeStructure');
  expect(read.mock.calls.at(-1)?.[1]).toMatchObject({ view: 'structure', pages: [1], parser: 'docling' });
  expect(container.textContent).toContain('Retained heading');
  await click('harness.pdf.textView');
  read.mockResolvedValueOnce({ status: 'failed', url: 'material:original', reason: 'OCR service unavailable' });
  await click('harness.pdf.readCurrentPageWithOcr');
  expect(container.textContent).toContain('OCR service unavailable');
  expect(container.textContent).not.toContain('harness.pdf.loadingPage');
});

it('rejects late page images after Thread, API, source or Host changes and dismissal', async () => {
  for (const change of ['thread', 'api', 'source', 'host', 'close'] as const) {
    const pending = deferred<FetchResult>();
    const read = vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => request.view === 'page-image' && request.snapshotId === 'snapshot-a' ? pending.promise : respond(request));
    const api = { read }; await render(api); await click('Read PDF');
    const signal = read.mock.calls.find(call => call[1].view === 'page-image')?.[2];
    if (change === 'close') await click('Close material');
    if (change === 'thread') await render(api, { ...identity, threadId: 'thread:new' });
    if (change === 'api') await render({ read: vi.fn(async (_owner, request) => respond(request)) });
    if (change === 'source') { await render(api, identity, okOverview('snapshot-b', 'hash-a')); await click('Read PDF'); }
    if (change === 'host') await act(async () => { mocks.changing.forEach(listener => listener()); mocks.generation += 1; mocks.changed.forEach(listener => listener()); await settle(); });
    expect(signal?.aborted).toBe(true); objectUrlMock.mockClear();
    await act(async () => { pending.resolve(respond({ snapshotId: 'snapshot-a', view: 'page-image', page: 1 })); await settle(); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  }
});

it('routes a citation only to its enclosing Thread and never consumes another conversation global event', async () => {
  const read = vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request));
  const globalEvent = vi.fn(); window.addEventListener(PDF_MATERIAL_OPEN_EVENT, globalEvent);
  const other = { ...identity, threadId: 'thread:other' };
  await act(async () => root.render(<><ThreadMaterials api={{ read }} identity={identity}><Citation /></ThreadMaterials><ThreadMaterials api={{ read }} identity={other}><Citation snapshotId="material:other" /></ThreadMaterials></>));
  const event = new Event('click', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'button', { value: 0 });
  await act(async () => { container.querySelector('a')!.dispatchEvent(event); await settle(); });
  expect(read.mock.calls.every(call => call[0].threadId === identity.threadId)).toBe(true);
  expect(read.mock.calls[0]?.[1]).toEqual({ snapshotId: 'material:citation', view: 'overview' });
  expect(read.mock.calls[1]?.[1]).toMatchObject({ page: 2 }); expect(globalEvent).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new CustomEvent(PDF_MATERIAL_OPEN_EVENT, { detail: { href: formatPdfMaterialCitationUrl({ snapshotId: 'foreign', page: 1 }) } })); await settle(); });
  expect(read).toHaveBeenCalledTimes(2); window.removeEventListener(PDF_MATERIAL_OPEN_EVENT, globalEvent);
});

it('finds WebSearchResult PDF references without recursively scanning arbitrary nested data', async () => {
  const api = { read: vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request)) };
  await render(api, identity, { items: [{ fetch: okOverview('snapshot-a', 'hash-a') }] }); await click('Read PDF'); expect(api.read).toHaveBeenCalled();
  await render(api, identity, { arbitrary: okOverview('snapshot-a', 'hash-a') });
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('Read PDF'))).toBe(false);
});

it('shows a missing material as a finished error rather than an empty page or endless loader', async () => {
  const read = vi.fn<ThreadMaterialsAPI['read']>(async () => ({ status: 'snapshot-missing', snapshotId: 'snapshot-a' }));
  await render({ read }); await click('Read PDF');
  expect(container.textContent).toContain('snapshot-missing');
  expect(container.textContent).not.toContain('harness.pdf.loading');
  expect(container.querySelector('img')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
