import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ExploreSearchSnippet, ExploreToolProgress, PiToolResultMessage } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';
import { PiExploreCard, PiExploreScope } from './PiExploreCard';
import { explorePresentation } from './explorePresentation';

const runtime = vi.hoisted(() => ({ key: 'runtime-a', grant: vi.fn(async () => undefined) }));
vi.mock('@varin/application-client', async (original) => ({ ...await original<object>(), getRuntimeKey: () => runtime.key }));
vi.mock('@/lib/outsideFileGrants', () => ({ ensureOutsideFileGrantForDesktop: runtime.grant }));
// Linkedom has no layout/compositor. Verify the settled card content and interactions here.
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    li: ({ children, layout: _layout, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: React.HTMLAttributes<HTMLLIElement> & {
      layout?: unknown; initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
    }) => <li {...props}>{children}</li>,
  },
}));

const call = { type: 'toolCall' as const, id: 'explore-1', name: 'explore', arguments: { question: 'Where is context prepared?', paths: ['/workspace', '/other'] } };
const snippet: ExploreSearchSnippet = { path: '/workspace/a.ts', startLine: 2, endLine: 3,
  text: 'const frozen = true;\nreturn frozen;', revision: 'source-revision', source: 'surface-draft', why: 'Definition of the requested symbol' };
const progress: ExploreToolProgress = { phase: 'collecting', elapsedMs: 1100, receivedFiles: 2, receivedSnippets: 3, sources: [], activities: [
  { kind: 'phase', phase: 'starting', sequence: 0, elapsedMs: 0 },
  { kind: 'read', viewId: 'view-a', ...snippet, sequence: 1, elapsedMs: 1100 },
] };
const execution: PiToolExecutionState = { toolCallId: call.id, name: call.name, args: call.arguments, status: 'running', partialResult: { details: { progress } } as never };
const result = (details: PiToolResultMessage['details']): PiToolResultMessage => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: 1, isError: false, content: [], details });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  runtime.key = 'runtime-a'; runtime.grant.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (output?: PiToolResultMessage, key = 'live', current = execution) => act(async () => root.render(
  <I18nProvider><PiExploreScope><PiExploreCard key={key} cwd="/workspace" call={call}
    execution={output ? undefined : current} result={output} rawDetails={<p>native raw result</p>} /></PiExploreScope></I18nProvider>,
));
const click = async (text: string) => act(async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  expect(button).toBeDefined(); button.click();
});
const clickFile = async (path: string) => act(async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.title === `Open current file: ${path}`);
  expect(button).toBeDefined(); button!.click();
});

test('shows received evidence separately from returned snippets and keeps reading open across native persistence', async () => {
  const open = vi.spyOn(useUIStore.getState(), 'openContextFileAtLine').mockImplementation(() => {});
  await render();
  expect(container.textContent).toContain('Received 3 candidate excerpts from 2 files');
  expect(container.textContent).not.toContain('Returned');
  expect(container.textContent).toContain('a.ts');
  await click('Expand');
  await render(result({ progress: { ...progress, phase: 'complete', elapsedMs: 1900 }, snippets: [snippet] } as never), 'saved');
  expect(container.textContent).toContain('Returned 1 excerpts from 1 files');
  expect(container.textContent).toContain('/workspace · /other');
  await click('Excerpt');
  expect(container.querySelector('pre code')?.textContent).toBe(snippet.text);
  expect(container.textContent).toContain('source-revision');
  await clickFile(snippet.path);
  expect(open).toHaveBeenCalledWith('/workspace', '/workspace/a.ts', 2, 1);
  await click('Collapse');
  expect(container.querySelector('pre')).toBeNull();
  expect(container.textContent).toContain('Returned 1 excerpts');
});

test('completed cards start compact; partial, cancelled, malformed, and empty results remain distinct', async () => {
  await render(result({ snippets: [snippet], partial: true, progress: { ...progress, phase: 'partial' } } as never));
  expect(container.textContent).toContain('Partial results returned');
  expect(container.textContent).toContain('a.ts');
  expect(container.textContent).not.toContain('Definition of the requested symbol');
  await click('Expand');
  expect(container.textContent).toContain('Some work did not complete');
  await render({ ...result({ progress: { ...progress, phase: 'cancelled' } } as never), isError: true });
  expect(container.textContent).toContain('Search cancelled');
  expect(container.textContent).not.toContain('Search failed');
  expect(explorePresentation(undefined, result({ snippets: [] })).phase).toBe('empty');
  expect(explorePresentation(undefined, result({ snippets: [{ path: 'broken' }] })).phase).toBe('invalid');
  expect(explorePresentation(undefined, result({ error: 'No source available', errorCode: 'unavailable' })).phase).toBe('unavailable');
});

test('does not open a file in another runtime after an outstanding outside-file grant', async () => {
  let release!: () => void;
  runtime.grant.mockImplementation(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  const open = vi.spyOn(useUIStore.getState(), 'openContextFileAtLine').mockImplementation(() => {});
  await render(result({ snippets: [{ ...snippet, path: '/other/a.ts' }] } as never));
  await clickFile('/other/a.ts');
  expect(runtime.grant).toHaveBeenCalledWith('/other/a.ts', '/workspace');
  runtime.key = 'runtime-b';
  await act(async () => release());
  expect(open).not.toHaveBeenCalled();
});

test('the rolling activity preview becomes a result preview and the header expands the whole list', async () => {
  const excerpts = Array.from({ length: 6 }, (_,index) => ({ ...snippet, path: `/workspace/file-${index}.ts` }));
  const currentProgress: ExploreToolProgress = { ...progress, receivedFiles: 6, receivedSnippets: 6, activities: excerpts.map((excerpt, index) => ({
    kind: 'read', viewId: `view-${index}`, ...excerpt, sequence: index, elapsedMs: index * 100,
  })) };
  await render(undefined, 'live', { ...execution, partialResult: { details: { progress: currentProgress } } as never });
  const activityList = () => container.querySelector('ol[aria-label="Search activity"]')!;
  expect(activityList().children).toHaveLength(4);
  expect(activityList().textContent).not.toContain('file-1.ts');
  expect(activityList().textContent).toContain('file-5.ts');

  const nextProgress: ExploreToolProgress = { ...currentProgress, receivedFiles: 7, receivedSnippets: 7, activities: [...currentProgress.activities, {
    kind: 'read', viewId: 'next-view', ...snippet, path: '/workspace/next.ts', sequence: 6, elapsedMs: 2000,
  }] };
  await render(undefined, 'live', { ...execution, partialResult: { details: { progress: nextProgress } } as never });
  expect(activityList().children).toHaveLength(4);
  expect(activityList().textContent).not.toContain('file-2.ts');
  expect(activityList().textContent).toContain('next.ts');

  await render(result({ snippets: excerpts, progress: { ...nextProgress, phase: 'complete' } } as never));
  expect(container.querySelector('ol[aria-label="Search activity"]')).toBeNull();
  const results = () => container.querySelector('ol[aria-label="Search results"]')!;
  expect(results().children).toHaveLength(4);
  expect(results().textContent).toContain('file-0.ts');
  expect(results().textContent).not.toContain('file-4.ts');
  expect(container.textContent).toContain('Returned 6 excerpts from 6 files');
  expect(container.textContent).not.toContain('View process');
  expect(container.textContent).not.toContain('View results and process');

  await act(async () => {
    const header = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Quick search'))!;
    header.click();
  });
  expect(results().children).toHaveLength(6);
  await click('Collapse');
  expect(results().children).toHaveLength(4);
});
