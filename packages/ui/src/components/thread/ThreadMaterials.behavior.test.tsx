import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentReadRequest, ExperimentArtifactView, ExperimentAttemptView, FetchResult } from '@varin/protocol';
import type { AgentSettingsSnapshot } from '@varin/application-client';

const mocks = vi.hoisted(() => ({
  runtimeKey: 'runtime-a',
  runtimeFetch: vi.fn(),
  readModelSettings: vi.fn<(cwd?: string, signal?: AbortSignal) => Promise<AgentSettingsSnapshot>>(),
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
    // The real conversation reads model defaults through this separate owner.
    createModelConnectionsHttpAPI: (host?: number) => ({
      ...actual.createModelConnectionsHttpAPI(host),
      readSettings: mocks.readModelSettings,
    }),
  };
});
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
// Exercise the conversation draft through its composer port; browser editor/layout
// behavior has separate renderer tests.
vi.mock('./ThreadComposer', () => ({ ThreadComposer: (props: React.ComponentProps<typeof import('./ThreadComposer').ThreadComposer>) => <div>
  {props.children}
  <select aria-label="Registered model" value={JSON.stringify([props.providerId, props.modelId])} onChange={event => {
    const [provider, model] = JSON.parse(event.currentTarget.value); props.onModelChange(provider, model, props.thinkingLevel);
  }}>
    {props.models.map(model => <option key={`${model.providerId}:${model.modelId}`} value={JSON.stringify([model.providerId, model.modelId])}>{model.name}</option>)}
  </select>
  <textarea aria-label="Message thread" ref={props.editorRef as React.Ref<HTMLTextAreaElement>} value={props.value} onInput={event => props.onChange(event.currentTarget.value)} />
  <button type="submit" disabled={props.sendDisabled}>Send</button>
</div> }));
vi.mock('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} />,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children, onOpenChange }: { open: boolean; children: React.ReactNode; onOpenChange?: (value: boolean) => void }) => open ? <div role="dialog"><button onClick={() => onOpenChange?.(false)}>Close material</button>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
// Drive the same menu selection semantics; browser checks cover floating geometry.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext, useState, cloneElement } = await import('react');
  const State = createContext({ open: false, setOpen: (_value: boolean) => {} });
  return {
    DropdownMenu: ({ children }: React.PropsWithChildren) => { const [open, setOpen] = useState(false); return <State.Provider value={{ open, setOpen }}>{children}</State.Provider>; },
    DropdownMenuTrigger: ({ children }: { children: React.ReactElement<React.HTMLAttributes<HTMLElement>> }) => { const state = useContext(State); return cloneElement(children, { onClick: () => state.setOpen(!state.open) }); },
    DropdownMenuContent: ({ children }: React.PropsWithChildren) => useContext(State).open ? <div role="menu">{children}</div> : null,
    DropdownMenuItem: ({ children, onSelect, onClick, disabled }: React.PropsWithChildren<{ onSelect?(): void; onClick?(): void; disabled?: boolean }>) => { const state = useContext(State); return <button role="menuitem" disabled={disabled} onClick={() => { onSelect?.(); onClick?.(); state.setOpen(false); }}>{children}</button>; },
    DropdownMenuSeparator: () => <hr />,
  };
});

vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>, SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-testid="pdf-text">{content}</div> }));
vi.mock('@/lib/i18n', async original => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));

import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { listEditorContextAttachments, resetEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { threadSummary } from '@/test/threadFixtures';
import { ThreadMaterials } from './ThreadMaterials';
import { toast } from '@/components/ui';
import { ThreadRequestError } from '@varin/application-client';
import type { ThreadMaterialsAPI, ThreadIdentity, ThreadResearchAPI, ThreadSnapshot, ThreadSubmit, ThreadsAPI } from '@varin/application-client';
import { ThreadResearch } from './ThreadResearch';
import { ThreadConversation } from './ThreadConversation';
import { ThreadContent } from './ThreadContent';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { usePdfMaterialLinkInteractions } from '@/components/materials/usePdfMaterialLinkInteractions';
import { PDF_MATERIAL_OPEN_EVENT, formatPdfMaterialCitationUrl, pdfMaterialMarkdownHref } from '@/lib/materials/pdfMaterialCitation';

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
  Object.defineProperty(dom.window, 'location', { value: new URL('http://ui.test/'), configurable: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Element', dom.Element);
  vi.stubGlobal('HTMLAnchorElement', dom.HTMLAnchorElement);
  vi.stubGlobal('CustomEvent', dom.CustomEvent);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('Event', dom.Event);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useThreadDraftStore.setState({ drafts: {} });
  useWorkOverviewStore.setState({ bySession: {} });
  resetEditorContextAttachments();
  mocks.runtimeKey = 'runtime-a'; mocks.generation = 1;
  mocks.runtimeFetch.mockReset();
  mocks.readModelSettings.mockReset().mockResolvedValue({
    global: {}, globalRevision: 'fixture-global',
    project: {}, projectRevision: 'fixture-project', projectTrusted: false,
  });
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
  vi.restoreAllMocks();
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
const render = async (api: Pick<ThreadMaterialsAPI, 'read'>, selected = identity, data: unknown = okOverview('snapshot-a', 'hash-a')) => {
  await act(async () => { root.render(<ThreadMaterials api={api} identity={selected}><History data={data} /></ThreadMaterials>); await settle(); });
};

it('opens a tool-result material through the original Thread and shares page, text, structure and errors', async () => {
  const read = vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request)); const api = { read };
  await render(api); expect(read).not.toHaveBeenCalled(); await click('https://example.test/paper.pdf');
  // Format discovery and the reader may each inspect the retained material;
  // the contract is its original scope and page, not a fixed number of reads.
  expect(read).toHaveBeenCalledWith(identity, expect.objectContaining({ snapshotId: 'snapshot-a', view: 'page-image', page: 1 }), expect.any(AbortSignal));
  expect(read.mock.calls.every(([owner, request]) => owner.threadId === identity.threadId && owner.branchId === identity.branchId && request.snapshotId === 'snapshot-a')).toBe(true);
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
    const api = { read }; await render(api); await click('https://example.test/paper.pdf');
    const signal = read.mock.calls.find(call => call[1].view === 'page-image')?.[2];
    if (change === 'close') await click('Close material');
    if (change === 'thread') await render(api, { ...identity, threadId: 'thread:new' });
    if (change === 'api') await render({ read: vi.fn(async (_owner, request) => respond(request)) });
    if (change === 'source') { await render(api, identity, okOverview('snapshot-b', 'hash-a')); await click('https://example.test/paper.pdf'); }
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
  expect(read).toHaveBeenCalledWith(identity, expect.objectContaining({ snapshotId: 'material:citation', view: 'page-image', page: 2 }), expect.any(AbortSignal));
  expect(globalEvent).not.toHaveBeenCalled();
  const readsBeforeGlobalEvent = [...read.mock.calls];
  await act(async () => { window.dispatchEvent(new CustomEvent(PDF_MATERIAL_OPEN_EVENT, { detail: { href: formatPdfMaterialCitationUrl({ snapshotId: 'foreign', page: 1 }) } })); await settle(); });
  expect(read.mock.calls).toEqual(readsBeforeGlobalEvent); window.removeEventListener(PDF_MATERIAL_OPEN_EVENT, globalEvent);
});

it('finds WebSearchResult PDF references without recursively scanning arbitrary nested data', async () => {
  const api = { read: vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request)) };
  await render(api, identity, { items: [{ fetch: okOverview('snapshot-a', 'hash-a') }] }); await click('https://example.test/paper.pdf'); expect(api.read).toHaveBeenCalled();
  await render(api, identity, { arbitrary: okOverview('snapshot-a', 'hash-a') });
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('https://example.test/paper.pdf'))).toBe(false);
});

it('shows a missing material as a finished error rather than an empty page or endless loader', async () => {
  const errorToast = vi.spyOn(toast, 'error').mockReturnValue('missing-material');
  const read = vi.fn<ThreadMaterialsAPI['read']>(async () => ({ status: 'snapshot-missing', snapshotId: 'snapshot-a' }));
  await render({ read }); await click('https://example.test/paper.pdf');
  expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain('harness.pdf.loading');
  expect(container.querySelector('img')).toBeNull();
  expect(read).toHaveBeenCalledWith(identity, { snapshotId: 'snapshot-a', view: 'overview' }, expect.any(AbortSignal));
  expect(read.mock.calls.some(([, request]) => request.view === 'page-image')).toBe(false);
});

const originalAttempt: ExperimentAttemptView = { attemptId: 'attempt:original', specId: 'spec:original',
  cancelRequested: false, backend: 'local', state: 'completed', collection: 'done', createdAt: 1, permissions: { control: false } };
const originalArtifact: ExperimentArtifactView = { recordRevision: 1, artifactId: 'artifact:pdf', attemptId: originalAttempt.attemptId,
  name: 'Original experiment.pdf', kind: 'file', state: 'available', byteLength: 100 };
function researchFixture(artifacts: ExperimentArtifactView[] = [originalArtifact]) {
  const api = {
    scopes: vi.fn(async () => ['run:original', 'run:other'].map(sourceRunId => ({ sourceRunId,
      workspaceId: `workspace:${sourceRunId}`, executionWorkspaceId: `workspace:${sourceRunId}`, canSubmit: false,
      source: { resource_owner: { kind: 'local' as const }, workspace_id: `workspace:${sourceRunId}`, execution_workspace_id: `workspace:${sourceRunId}`,
        branch_id: `source:${sourceRunId}`, revision: 1, mode: 'fixed_branch' as const, live_root: null },
    }))),
    list: vi.fn(async () => ({ attempts: [originalAttempt], text: '' })),
    get: vi.fn(async () => ({ attempt: originalAttempt, artifacts })),
    resources: vi.fn(async () => ({ machines: [], generatedAt: 1, text: '' })),
    sources: vi.fn(async () => ({ sources: [], text: '' })),
    artifact: vi.fn(), logs: vi.fn(), cancel: vi.fn(), collect: vi.fn(), submit: vi.fn(),
  } satisfies ThreadResearchAPI;
  const materials = {
    upload: vi.fn<ThreadMaterialsAPI['upload']>(),
    readSource: vi.fn<ThreadMaterialsAPI['readSource']>(),
    readArtifact: vi.fn<ThreadMaterialsAPI['readArtifact']>(async () => okOverview('snapshot-artifact', 'hash-a')),
    read: vi.fn<ThreadMaterialsAPI['read']>(async (_owner, request) => respond(request)),
  } satisfies ThreadMaterialsAPI;
  const renderResearch = async (selected = identity, nextMaterials: ThreadMaterialsAPI = materials, nextAPI: ThreadResearchAPI = api) => {
    await act(async () => {
      root.render(<ThreadResearch api={nextAPI} materials={nextMaterials} identity={selected} sourceRunId="run:original" />);
      await settle();
    });
  };
  const open = async () => { await renderResearch(); await click('research-facts.viewDetails'); await click('harness.pdf.openReader'); };
  return { api, materials, renderResearch, open };
}

it('opens the real native ArtifactRow with its exact source Run, then reads retained pages through the shared reader', async () => {
  const f = researchFixture(); await f.open();
  expect(f.materials.readArtifact).toHaveBeenCalledExactlyOnceWith({ ...identity, sourceRunId: 'run:original' },
    { artifact: { attemptId: originalAttempt.attemptId, artifactId: originalArtifact.artifactId }, view: 'overview' }, expect.any(AbortSignal));
  expect(f.materials.read.mock.calls[0]).toEqual([identity, { snapshotId: 'snapshot-artifact', view: 'page-image', page: 1, scale: 1 }, expect.any(AbortSignal)]);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:page-1');
  expect(container.textContent).toContain('Original experiment.pdf');
  expect(container.textContent).toContain('100 B');
  await click('harness.pdf.textView');
  expect(f.materials.read.mock.calls.at(-1)?.[1]).toMatchObject({ snapshotId: 'snapshot-artifact', view: 'text', pages: [1] });
  expect(container.textContent).toContain('Retained page text');
  expect(f.api.artifact).not.toHaveBeenCalled();
  expect(mocks.runtimeFetch).not.toHaveBeenCalled();
});

it('cancels native artifact ingestion and retained image reads on close, Thread, source Run, API or Host change', async () => {
  for (const phase of ['ingestion', 'page'] as const) {
    for (const change of ['close', 'thread', 'branch', 'sourceRun', 'materials', 'research', 'host'] as const) {
      await act(async () => root.render(null));
      const f = researchFixture(); const pending = deferred<FetchResult>();
      if (phase === 'ingestion') f.materials.readArtifact.mockImplementation(async () => pending.promise);
      else f.materials.read.mockImplementation(async () => pending.promise);
      await f.open();
      const signal = phase === 'ingestion' ? f.materials.readArtifact.mock.calls[0]?.[2] : f.materials.read.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      if (change === 'close') await click('Close material');
      if (change === 'thread') await f.renderResearch({ ...identity, threadId: 'thread:other' });
      if (change === 'branch') await f.renderResearch({ ...identity, branchId: 'branch:other' });
      if (change === 'materials') await f.renderResearch(identity, { ...f.materials });
      if (change === 'research') await f.renderResearch(identity, f.materials, { ...f.api });
      if (change === 'sourceRun') await act(async () => {
        const select = container.querySelector('select')!;
        Object.defineProperty(select, 'value', { value: 'run:other', configurable: true });
        select.dispatchEvent(new Event('change', { bubbles: true })); await settle();
      });
      if (change === 'host') await act(async () => {
        mocks.changing.forEach(listener => listener()); mocks.generation += 1; mocks.changed.forEach(listener => listener()); await settle();
      });
      expect(signal?.aborted, `${phase}/${change}`).toBe(true);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      objectUrlMock.mockClear();
      await act(async () => {
        pending.resolve(phase === 'ingestion' ? okOverview('snapshot-artifact', 'hash-a') : respond({ snapshotId: 'snapshot-artifact', view: 'page-image', page: 1 }));
        await settle();
      });
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(f.api.cancel).not.toHaveBeenCalled();
      expect(f.api.collect).not.toHaveBeenCalled();
    }
  }
});

it('keeps unavailable artifact metadata and original reader failure codes without treating a receipt or cache as a PDF', async () => {
  const unavailable = researchFixture([
    { ...originalArtifact, state: 'pending' },
    { ...originalArtifact, artifactId: 'artifact:failed', state: 'failed', name: 'Failed.pdf', error: 'Collection failed' },
    { ...originalArtifact, artifactId: 'artifact:remote', name: 'Remote.pdf', remote: { machineId: 'machine:remote', outputId: 'output:original',
      path: '/outputs/report.pdf', retainedBy: 'execution-target', accessible: 'unreachable' } },
  ]);
  await unavailable.renderResearch(); await click('research-facts.viewDetails');
  expect(container.textContent).toContain('pending'); expect(container.textContent).toContain('Collection failed');
  expect(container.textContent).toContain('/outputs/report.pdf'); expect(container.textContent).toContain('research-facts.remoteUnreachable');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'harness.pdf.openReader')).toBe(false);
  expect(unavailable.materials.readArtifact).not.toHaveBeenCalled();
  for (const failure of [new ThreadRequestError(403, 'artifact-forbidden'), new ThreadRequestError(404, 'artifact-missing')]) {
    await act(async () => root.render(null)); const f = researchFixture();
    f.materials.readArtifact.mockRejectedValue(failure); await f.open();
    expect(container.textContent).toContain(failure.code); expect(container.querySelector('img')).toBeNull();
    expect(f.materials.read).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('harness.pdf.loading');
  }
  await act(async () => root.render(null)); const failed = researchFixture();
  failed.materials.readArtifact.mockResolvedValue({ status: 'failed', url: 'artifact:pdf', reason: 'Artifact collection has not completed' });
  await failed.open();
  expect(container.textContent).toContain('Artifact collection has not completed');
  expect(failed.materials.read).not.toHaveBeenCalled(); expect(container.querySelector('img')).toBeNull();
  await act(async () => root.render(null)); const f = researchFixture();
  const receipt = { ...okOverview('ignored-cache', 'hash-a'), snapshot: undefined, overview: undefined, operationId: 'operation:accepted' } as unknown as FetchResult;
  f.materials.readArtifact.mockResolvedValue(receipt); await f.open();
  expect(container.textContent).toContain('harness.pdf.sourceUnavailable');
  expect(f.materials.read).not.toHaveBeenCalled(); expect(container.querySelector('img')).toBeNull();
});

/** Exercise the actual conversation composer, not an alternate material draft store. */
function artifactConversationFixture() {
  const f = researchFixture();
  const unused = async (): Promise<never> => { throw new Error('Unused fixture API'); };
  const snapshot = async (work: ThreadIdentity): Promise<ThreadSnapshot> => ({ identity: work, eventCursor: 0,
    thread: threadSummary(work.threadId, { main_branch_id: work.branchId, branches: [{ branch_id: work.branchId, head: null, active_run_id: null, latest_run: null }] }),
    activeRun: null, history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [],
    launch: null, modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] } });
  const submit = vi.fn(async (input: ThreadSubmit) => ({ thread_id: input.threadId, branch_id: input.branchId,
    run_id: 'run:submitted', input_id: 'input:submitted', cursor: 1 }));
  const api: ThreadsAPI = { attention: unused, historyRuns: async (_identity, { headId }) => ({ head: headId, runs: [] }), historyRunPreview: async () => '', historyUsage: async () => [], contextHistory: unused, fileTarget: unused, usage: unused,
    materials: f.materials, research: f.api,
    contextInspection: async (_identity, { headId }) => ({ head: headId, counts: { total: 0, user: 0, assistant: 0, tool: 0 }, latestRequest: null, contextRequest: null }),
    computer: { state: async work => ({ state: { work, rootWork: work, currentExecution: null, currentRootExecution: null,
      active: false, status: 'enabled', leases: [], requests: [], cleanups: [] }, activities: [] }), stop: unused, decide: unused },
    goals: { start: unused, update: unused, control: unused, list: async () => [] }, resources: { refresh: unused },
    followups: { jobSources: async () => [], register: unused, list: unused, get: unused, occurrence: unused, occurrences: unused,
      control: unused, pendingRegistrations: async () => [], cancelRegistration: unused },
    listModels: async () => [{ providerId: 'fixture-provider', modelId: 'fixture-model', acceptsImages: true }],
    list: unused, create: unused, update: unused, delete: unused, markRead: unused, mediaRead: unused, listMcpInteractions: async () => ({ items: [], nextCursor: null }),
    readMcpInteraction: unused, respondMcpInteraction: unused, reviewMcpSamplingRequest: unused, reviewMcpSamplingOutput: unused,
    snapshot, submit, enqueue: unused, editInput: unused, cancelInput: unused, sendInputNow: unused, cancelRun: unused,
    sources: { list: async () => ({ targets: [{ resourceOwner: { kind: 'local' }, label: 'This Host', capabilities: [] }], unavailable: [] }), resolve: unused },
    prepareNavigation: unused, recoverySource: unused, navigate: unused, navigationReceipt: unused,
    inspectTools: unused, inspectPolicy: unused, restartPolicy: unused, cancelPolicyUpdate: unused, selectModel: unused,
    decidePermission: unused, answerQuestion: unused, prepareSource: unused, fork: unused, compact: unused, publishContext: unused,
    cancelContext: unused, resumeContext: unused, historyPage: unused, run: unused, toolCalls: async () => [], operation: unused, cancelOperation: unused, retrievalTrace: unused, retrievalFileTarget: unused,
    resume: unused, retryPreparation: unused, events: async () => [],
    observe: async (_cursor, _onEvent, { signal }) => new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  };
  const renderConversation = async (selected = identity) => {
    await act(async () => { root.render(<ThreadConversation api={api} identity={selected} />); await settle(); });
  };
  const open = async () => {
    await renderConversation();
    expect(mocks.readModelSettings).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    // Research details mount on first inspection, just like the real overview path.
    expect(f.api.scopes).not.toHaveBeenCalled();
    const overview = container.querySelector<HTMLElement>('.workbench-overview-control')!;
    if (overview.dataset.view !== 'full') {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-harness-overview-controls] button')!.click());
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="harness.overview.more"]')!.click());
    const research = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.textContent === 'harness.overview.research');
    expect(research).toBeTruthy();
    await act(async () => { research!.click(); await settle(); });
    expect(f.api.scopes).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
    await click('research-facts.viewDetails');
    await click('harness.pdf.openReader');
  };
  return { ...f, api, submit, renderConversation, open };
}
const editComposer = async (text: string) => {
  const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!;
  await act(async () => {
    Object.defineProperty(textarea, 'value', { value: text, configurable: true, writable: true });
    textarea.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  });
};
const selectPdfRegion = async () => {
  const img = container.querySelector<HTMLImageElement>('[role="dialog"] img')!;
  expect(img).toBeTruthy();
  img.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200, x: 0, y: 0, toJSON: () => ({}) });
  const surface = img.parentElement!; surface.setPointerCapture = vi.fn();
  const pointer = (name: string, x: number, y: number) => {
    const event = new Event(name, { bubbles: true }); Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y });
    surface.dispatchEvent(event);
  };
  await act(async () => { pointer('pointerdown', 10, 40); await settle(); });
  expect(surface.setPointerCapture).toHaveBeenCalledWith(1);
  await act(async () => { pointer('pointerup', 40, 60); await settle(); });
  const ask = [...container.querySelectorAll('button')].find(button => button.textContent === 'harness.pdf.askAboutSelection');
  expect(ask, container.textContent ?? '').toBeTruthy(); expect(ask!.disabled).toBe(false);
};

it('adds a real Research ArtifactRow region and citation to its enclosing Thread conversation draft', async () => {
  const f = artifactConversationFixture(); await f.open();
  await editComposer('Keep my question'); await selectPdfRegion(); await click('harness.pdf.askAboutSelection');
  const text = container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value;
  expect(text).toBe('Keep my question');
  const references = listEditorContextAttachments(threadHostKey(), threadComposerKey(threadHostKey(), identity));
  expect(references).toHaveLength(1);
  expect(references[0]?.reference).toMatchObject({ title: 'Original experiment.pdf',
    image: { data: 'AQID', mimeType: 'image/png' }, source: { kind: 'document', snapshotId: 'snapshot-artifact', sourceHash: 'hash-a', page: 1 } });
  expect(f.materials.read.mock.calls.at(-1)?.[1]).toMatchObject({ snapshotId: 'snapshot-artifact', view: 'page-image',
    page: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const model = container.querySelector<HTMLSelectElement>('[aria-label="Registered model"]')!;
  await act(async () => {
    Object.defineProperty(model, 'value', { value: JSON.stringify(['fixture-provider', 'fixture-model']), configurable: true });
    model.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  });
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); });
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...identity, text: expect.stringContaining(text),
    images: [{ data: 'AQID', mimeType: 'image/png' }] }));
  expect(f.submit.mock.calls[0]![0].text).toContain('snapshot-artifact');
  expect(f.submit.mock.calls[0]![0].text).toContain('hash-a');
  expect(mocks.addRegion).not.toHaveBeenCalled(); expect(mocks.runtimeFetch).not.toHaveBeenCalled();
});

it('rejects late research PDF region responses after Thread or Host change without touching either composer', async () => {
  for (const change of ['thread', 'host'] as const) {
    await act(async () => root.render(null));
    const f = artifactConversationFixture(); const pending = deferred<FetchResult>();
    f.materials.read.mockImplementation(async (_owner, request) => request.region ? pending.promise : respond(request));
    await f.open(); await editComposer('Old draft remains unchanged'); await selectPdfRegion();
    await click('harness.pdf.askAboutSelection');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('Old draft remains unchanged');
    const signal = f.materials.read.mock.calls.find(([, request]) => request.region)?.[2];
    if (change === 'thread') await f.renderConversation({ ...identity, threadId: 'thread:new' });
    else await act(async () => { mocks.changing.forEach(listener => listener()); mocks.generation += 1; mocks.changed.forEach(listener => listener()); await settle(); });
    await editComposer('New draft remains unchanged');
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      pending.resolve(respond({ snapshotId: 'snapshot-artifact', view: 'page-image', page: 1,
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } })); await settle();
    });
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message thread"]')!.value).toBe('New draft remains unchanged');
    expect(container.querySelector('img')).toBeNull(); expect(f.submit).not.toHaveBeenCalled();
    expect(mocks.addRegion).not.toHaveBeenCalled();
  }
});
