import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { ThreadsAPI, ThreadSourceFilePage } from '@varin/application-client';
import { useSourceFileCandidates } from './useSourceFileCandidates';
let root: Root, container: HTMLDivElement;
const identity = { runtime: 'agent' as const, threadId: 'one', branchId: 'branch' };
const file = (name: string) => ({ name, path: name, relativePath: name, type: 'file' as const });
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
function View({ api, query, scope = 'original' }: { api: ThreadsAPI; query: string; scope?: string }) {
  const result = useSourceFileCandidates({ api, identity, query, requestedQuery: query, scope, type: 'file', revision: 0 });
  return <div><p>{result.rows.map(item => item.name).join(',')}</p><button onClick={result.more}>More</button>{result.error && <span role="alert">{result.error}</span>}</div>;
}
test('returning to an earlier query starts at its first page and obsolete Source results never publish', async () => {
  let resolveOld!: (page: ThreadSourceFilePage) => void;
  const files = vi.fn(async (_identity, options) => options.query === 'waiting' ? new Promise<ThreadSourceFilePage>(resolve => { resolveOld = resolve; }) : { entries: [file(`${options.query}:${options.cursor ?? 'first'}`)], nextCursor: options.cursor ? null : 'second' });
  const api = { sources: { files } } as unknown as ThreadsAPI;
  await act(async () => root.render(<View api={api} query="A" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('A:first,A:second');
  await act(async () => root.render(<View api={api} query="B" />));
  await act(async () => root.render(<View api={api} query="A" />));
  expect(files.mock.calls.at(-1)?.[1].cursor).toBeUndefined(); expect(container.textContent).toContain('A:first'); expect(container.textContent).not.toContain('A:second');
  await act(async () => root.render(<View api={api} query="waiting" />));
  await act(async () => root.render(<View api={api} query="new" scope="replaced-source" />));
  await act(async () => resolveOld({ entries: [file('stale')], nextCursor: null }));
  expect(container.textContent).toContain('new:first'); expect(container.textContent).not.toContain('stale');
});
