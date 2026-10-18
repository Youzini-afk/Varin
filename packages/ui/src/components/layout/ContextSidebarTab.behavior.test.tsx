import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadContextInspection, ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { ModelPresentation, Run } from '@varin/protocol';
const runtime = vi.hoisted(() => ({ api: undefined as ThreadsAPI | undefined }));
const copy = vi.hoisted(() => vi.fn(async (_value: string) => ({ ok: true })));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: runtime.api }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: copy }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre> }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>, TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>, TooltipContent: () => null }));
import { ContextPanelContent } from './ContextSidebarTab';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { contextUsageKey, useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { I18nProvider } from '@/lib/i18n';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:context', branchId: 'branch:context' };
let root: Root; let container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  container = window.document.getElementById('root')! as unknown as HTMLElement; root = createRoot(container);
  useThreadContextUsageStore.setState({ views: {} }); useThreadStore.setState({ selectedIdentity: identity });
  copy.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
function HeaderUsage() {
  const usage = useThreadContextUsageStore(state => state.views[contextUsageKey(identity)]?.usage);
  return usage && usage.totalTokens > 0 ? <ContextUsageDisplay {...usage} hideIcon showPercentIcon /> : null;
}

it('restores context cards and raw JSON while header usage stays independent of the visible history page', async () => {
  const request: ModelPresentation = { requestId: 'request:older', providerFamily: 'openai-completions', modelId: 'fixture-model', contextTokens: 26000,
    usage: { measurement: 'actual', inputTokens: 25000, outputTokens: 1000, cachedInputTokens: 20000, reasoningTokens: 200 } };
  const run: Run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, epoch: 1, revision: 1,
    state: 'executing', waiting_on: null, cancel_requested: false,
    configuration: { providerFamily: request.providerFamily, model: request.modelId, endpoint: 'http://fixture.test', credentialEnvironment: null,
      allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 8000, contextWindowTokens: 100000 } };
  const view: ThreadSnapshot = { identity, eventCursor: 10,
    thread: { thread_id: identity.threadId, main_branch_id: identity.branchId, title: 'Context inspection', revision: 1, created_at_ms: 1, updated_at_ms: 2, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 10, read_cursor: 0, unread: false, bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: 'tool:39', active_run_id: run.id, latest_run: run }] },
    activeRun: run, history: Array.from({ length: 20 }, (_, i) => ({ id: `tool:${i + 20}`, thread_id: identity.threadId, parent: `tool:${i + 19}`, source: 'tool', run_id: 'run', provider: null, content: { text: `result ${i + 20}` } })),
    historyPage: { head: 'tool:39', previous: 'tool:20' }, inputs: [], operations: [], followups: [], goals: [], launch: null,
    modelSelection: { desired: null, active: null },
    policySelection: null, context: { checkpoint: null, jobs: [] } };
  const inspection: ThreadContextInspection = { head: 'tool:39', counts: { total: 40, user: 1, assistant: 1, tool: 38 }, latestRequest: request, contextRequest: request };
  let resolve!: (value: ThreadContextInspection) => void;
  const inspect = vi.fn<ThreadsAPI['contextInspection']>().mockImplementationOnce(() => new Promise(yes => { resolve = yes; })).mockImplementation(async () => structuredClone(inspection));
  let listener!: Parameters<ThreadsAPI['observe']>[1];
  const observe: ThreadsAPI['observe'] = async (_cursor, next, { signal }) => { listener = next; await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true })); };
  const historyUsage = vi.fn(async () => []);
  runtime.api = { snapshot: async () => structuredClone(view), observe, contextInspection: inspect, historyUsage } as unknown as ThreadsAPI;
  await act(async () => root.render(<I18nProvider><HeaderUsage /><ContextPanelContent /></I18nProvider>));
  expect(container.querySelector('h2')?.textContent).toBe('Context inspection');
  expect(container.querySelector('svg[role=progressbar]')).toBeNull();
  await act(async () => resolve(inspection));
  expect(container.querySelector('svg[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('26');
  const context = container.querySelector('section[aria-label="Context"]')!;
  expect(context.textContent).toContain('26,000 / 100,000');
  expect(container.textContent).toContain('26.0%');
  const stats = [...container.querySelectorAll('div')].find(node => node.textContent === 'Messages' && node.children.length === 0)!;
  expect(stats.nextElementSibling?.textContent).toBe('40');
  expect(container.querySelector('section[aria-label="Last Assistant Message"]')?.textContent).toContain('20,000');
  const raw = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => raw.click());
  expect(container.querySelector('pre')?.textContent).toContain('tool:39');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy JSON"]')!.click());
  expect(JSON.parse(copy.mock.calls[0]![0] as string).id).toBe('tool:39');
  request.contextTokens = 31000; inspection.contextRequest = request;
  view.eventCursor = 11;
  await act(async () => listener({ cursor: 11, subject: 'run', revision: 2, kind: 'model.settled', data: {} }));
  expect(container.querySelector('svg[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('31');
  expect(raw.getAttribute('aria-expanded')).toBe('true');
  view.activeRun = null;
  view.thread.branches[0]!.active_run_id = null;
  view.thread.branches[0]!.latest_run = { ...run, state: 'completed' };
  view.eventCursor = 12;
  await act(async () => listener({ cursor: 12, subject: 'run', revision: 3, kind: 'run.changed', data: {} }));
  expect(container.querySelector('svg[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('31');
  expect(container.querySelector('section[aria-label="Context"]')?.textContent).toContain('31,000 / 100,000');
  inspection.contextRequest = null; view.eventCursor = 13;
  await act(async () => listener({ cursor: 13, subject: 'run', revision: 4, kind: 'context.committed', data: {} }));
  expect(container.querySelector('svg[role=progressbar]')).toBeNull();
  const signal = inspect.mock.calls.at(-1)![2]!;
  await act(async () => root.render(<I18nProvider><ContextPanelContent active={false} /></I18nProvider>));
  expect(signal.aborted).toBe(true);
  expect(historyUsage).not.toHaveBeenCalled();
});
