import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentReadRequest, FetchResult } from '@varin/protocol';

const mocks = vi.hoisted(() => ({
  runtimeKey: 'runtime-a',
  runtimeFetch: vi.fn(),
  addRegion: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('@varin/application-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@varin/application-client')>();
  return {
    ...actual,
    runtimeFetch: mocks.runtimeFetch,
    getRuntimeKey: () => mocks.runtimeKey,
  };
});
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-testid="pdf-text">{content}</div> }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/pi-runtime/addPdfMaterialToDraft', () => ({ addPdfMaterialRegionToDraft: mocks.addRegion }));

import { runtimeFetch } from '@varin/application-client';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { PdfMaterialReader } from './PdfMaterialReader';

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

const jsonResponse = (value: FetchResult): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const pngResponse = (): Response => new Response(new Blob(['png'], { type: 'image/png' }), {
  status: 200,
  headers: { 'Content-Type': 'image/png' },
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
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('Event', dom.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  usePiSessionStore.setState({ currentSessionId: 'session-1', runtimeKey: 'runtime-a' });
  mocks.runtimeKey = 'runtime-a';
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

const renderReader = async (
  snapshotId: string,
  sourceHash: string,
  page = 1,
  region?: { x: number; y: number; width: number; height: number },
) => {
  await act(async () => root.render(
    <PdfMaterialReader
      open
      sessionId="session-1"
      title="Paper"
      snapshotId={snapshotId}
      sourceHash={sourceHash}
      initialPage={page}
      {...(region ? { initialRegion: region } : {})}
    />,
  ));
};

describe('PDF reader async state and page selection', () => {
  it('ignores an older source overview after the reader switches snapshots', async () => {
    const oldOverview = deferred<Response>();
    const readCalls: Array<{ request: DocumentReadRequest; signal?: AbortSignal }> = [];
    vi.mocked(runtimeFetch).mockImplementation((route, init) => {
      if (String(route).endsWith('/materials/read')) {
        const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
        readCalls.push({ request, signal: init?.signal ?? undefined });
        return request.snapshotId === 'snapshot-a' ? oldOverview.promise : Promise.resolve(jsonResponse(okOverview('snapshot-b', 'hash-b')));
      }
      return Promise.resolve(pngResponse());
    });

    await renderReader('snapshot-a', 'hash-a');
    expect(readCalls[0]?.request.snapshotId).toBe('snapshot-a');
    expect(readCalls[0]?.signal?.aborted).toBe(false);
    await act(async () => root.render(
      <PdfMaterialReader open sessionId="session-1" title="Paper B" snapshotId="snapshot-b" sourceHash="hash-b" />,
    ));
    await act(settle);
    expect(readCalls[0]?.signal?.aborted).toBe(true);
    expect(vi.mocked(runtimeFetch).mock.calls.some(([route]) => String(route).includes('/materials/snapshot-b/page?'))).toBe(true);

    await act(async () => { oldOverview.resolve(jsonResponse(okOverview('snapshot-a', 'hash-a'))); await settle(); });
    expect(vi.mocked(runtimeFetch).mock.calls.some(([route]) => String(route).includes('/materials/snapshot-a/page?'))).toBe(false);
    expect(container.textContent).not.toContain('harness.pdf.sourceHashMismatch');
  });

  it('ignores an overview from the previous runtime after a runtime switch', async () => {
    const oldOverview = deferred<Response>();
    let overviewCount = 0;
    vi.mocked(runtimeFetch).mockImplementation((route, init) => {
      if (String(route).endsWith('/materials/read')) {
        const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
        if (request.view === 'overview' && overviewCount++ === 0) return oldOverview.promise;
        return Promise.resolve(jsonResponse(okOverview('snapshot-a', 'hash-a')));
      }
      return Promise.resolve(pngResponse());
    });

    await renderReader('snapshot-a', 'hash-a');
    await act(async () => {
      mocks.runtimeKey = 'runtime-b';
      usePiSessionStore.setState({ runtimeKey: 'runtime-b' });
      await settle();
    });
    expect(overviewCount).toBe(2);
    await act(async () => { oldOverview.resolve(jsonResponse(okOverview('snapshot-a', 'hash-a'))); await settle(); });
    expect(container.textContent).not.toContain('harness.pdf.sessionChanged');
    expect(vi.mocked(runtimeFetch).mock.calls.some(([route]) => String(route).includes('/materials/snapshot-a/page?'))).toBe(true);
  });

  it('requests only the visible page when opening the text view', async () => {
    vi.mocked(runtimeFetch).mockImplementation((route, init) => {
      if (String(route).endsWith('/materials/read')) {
        const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
        const response = okOverview('snapshot-a', 'hash-a') as Extract<FetchResult, { status: 'ok' }>;
        if (request.view === 'text') response.markdown = 'Current page text';
        return Promise.resolve(jsonResponse(response));
      }
      return Promise.resolve(pngResponse());
    });

    await renderReader('snapshot-a', 'hash-a', 2);
    await act(settle);
    const textTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('harness.pdf.textView'))!;
    await act(async () => textTab.click());
    await act(settle);
    const request = vi.mocked(runtimeFetch).mock.calls
      .filter(([route, init]) => String(route).endsWith('/materials/read') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)) as DocumentReadRequest)
      .find((entry) => entry.view === 'text');
    expect(request?.pages).toEqual([2]);
    expect(container.querySelector('[data-testid="pdf-text"]')?.textContent).toBe('Current page text');
  });

  it('shows a page selection and clears it when the reader moves to another page', async () => {
    vi.mocked(runtimeFetch).mockImplementation((route, init) => {
      if (String(route).endsWith('/materials/read')) {
        const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
        if (request.view === 'overview') return Promise.resolve(jsonResponse(okOverview('snapshot-a', 'hash-a')));
        return Promise.resolve(jsonResponse({
          ...(okOverview('snapshot-a', 'hash-a') as Extract<FetchResult, { status: 'ok' }>),
          pageImages: [{ page: 2, mimeType: 'image/png', data: 'cG5n', byteLength: 3, width: 100, height: 200, sourceHash: 'hash-a', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
        }));
      }
      return Promise.resolve(pngResponse());
    });

    await renderReader('snapshot-a', 'hash-a', 2, { x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
    await act(settle);
    expect(container.querySelector<HTMLInputElement>('#pdf-material-page')?.value).toBe('2');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('harness.pdf.askAboutSelection'))).toBe(true);

    const next = container.querySelector<HTMLButtonElement>('button[aria-label="harness.pdf.nextPage"]')!;
    await act(async () => next.click());
    await act(settle);
    expect(container.querySelector<HTMLInputElement>('#pdf-material-page')?.value).toBe('3');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('harness.pdf.askAboutSelection'))).toBe(false);
    expect(vi.mocked(runtimeFetch).mock.calls.some(([route]) => String(route).includes('/materials/snapshot-a/page?page=3'))).toBe(true);
  });

  it('restores reading location without repeating overview reads when location is saved', async () => {
    const locationChanged = vi.fn();
    vi.mocked(runtimeFetch).mockImplementation((route, init) => {
      if (!String(route).endsWith('/materials/read')) return Promise.resolve(pngResponse());
      const request = JSON.parse(String(init?.body)) as DocumentReadRequest;
      return Promise.resolve(jsonResponse({ ...okOverview('snapshot-a', 'hash-a'),
        ...(request.view === 'text' ? { markdown: 'Restored page text' } : {}),
      } as FetchResult));
    });
    await act(async () => root.render(<PdfMaterialReader sessionId="session-1" title="Paper" snapshotId="snapshot-a"
      sourceHash="hash-a" initialPage={2} initialView="text" initialScale={1.25} onLocationChange={locationChanged} presentation="inline" />));
    await act(settle);
    await act(settle);
    expect(container.querySelector('[data-testid="pdf-text"]')?.textContent).toBe('Restored page text');
    expect(locationChanged).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, view: 'text', scale: 1.25, snapshotId: 'snapshot-a', sourceHash: 'hash-a' }));
    const reads = vi.mocked(runtimeFetch).mock.calls.filter(([route]) => String(route).endsWith('/materials/read'))
      .map(([, init]) => JSON.parse(String(init?.body)) as DocumentReadRequest);
    expect(reads.filter(request => request.view === 'overview')).toHaveLength(1);
    expect(reads.filter(request => request.view === 'text').map(request => request.pages)).toEqual([[2]]);
    expect(reads.some(request => request.ocr)).toBe(false);
  });
});
