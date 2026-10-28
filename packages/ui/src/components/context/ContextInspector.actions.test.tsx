import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { ContextInspector } from './ContextInspector';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { useThreadStore } from '@/stores/useThreadStore';
import { useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { dict } from '@/lib/i18n/messages/en';

const runtime = vi.hoisted(() => ({ generation: 1, api: undefined as ThreadsAPI | undefined }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => runtime.generation }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: runtime.api }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre> }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipContent: () => null }));

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:context-actions', branchId: 'branch:context-actions' };
function snapshot(): ThreadSnapshot {
  const run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, epoch: 1, revision: 1,
    state: 'executing' as const, waiting_on: null, cancel_requested: false, configuration: { providerId: 'fixture-provider', model: 'fixture-model' } };
  return { identity, eventCursor: 1,
    thread: { thread_id: identity.threadId, main_branch_id: identity.branchId, title: 'Context actions', revision: 1, created_at_ms: 1, updated_at_ms: 1, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 1, read_cursor: 0, unread: false, bot_id: null, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: identity.branchId, head: 'message', active_run_id: run.id, latest_run: run }] },
    activeRun: run, history: [], historyPage: { head: 'message', previous: null }, inputs: [], operations: [], followups: [], goals: [], launch: null,
    modelSelection: { desired: null, active: null }, policySelection: null,
    context: { checkpoint: null, jobs: [{ run: { ...run, id: 'context-job' }, job: { request: { key: 'summary', owner_run_id: run.id, branch_id: identity.branchId, through_id: 'message', expected_revision: 0, summary_recipe: { mode: 'background' } }, receipt: { run_id: 'context-job', branch_id: 'context-job-branch' } } } as ThreadSnapshot['context']['jobs'][number]] } };
}
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = window.document.getElementById('root')! as unknown as HTMLElement; root = createRoot(container);
  runtime.generation = 1; useThreadContextUsageStore.setState({ views: {} }); useThreadStore.setState({ hostKey: 'fixture-host' });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const stop = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === dict['contextManager.stopPreparation'])!;

it('admits one action before React disables the control and survives equivalent identity objects', async () => {
  let finish!: () => void;
  const cancelContext = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const api = { cancelContext } as unknown as ThreadsAPI, view = snapshot(), refresh = vi.fn(async () => {});
  const render = (target: ThreadIdentity) => root.render(<ContextInspector api={api} identity={target} snapshot={view} active={false} refresh={refresh} />);
  await act(async () => render(identity));
  await act(async () => { stop().click(); stop().click(); });
  expect(cancelContext).toHaveBeenCalledExactlyOnceWith(identity, 'context-job');
  expect(stop().disabled).toBe(true);
  await act(async () => render({ ...identity }));
  await act(async () => finish());
  expect(refresh).toHaveBeenCalledOnce();
  expect(stop().disabled).toBe(false);
});

it.each(['Host', 'API'])('discards a previous %s action completion and leaves the current controls usable', async owner => {
  let finish!: () => void;
  const cancelContext = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  let api = { cancelContext } as unknown as ThreadsAPI;
  const view = snapshot(), refresh = vi.fn(async () => {});
  const render = () => root.render(<ContextInspector api={api} identity={identity} snapshot={view} active={false} refresh={refresh} />);
  await act(async () => render());
  await act(async () => stop().click());
  if (owner === 'Host') runtime.generation = 2; else api = { cancelContext } as unknown as ThreadsAPI;
  await act(async () => render());
  await act(async () => finish());
  expect(refresh).not.toHaveBeenCalled();
  expect(stop().disabled).toBe(false);
  await act(async () => stop().click());
  expect(cancelContext).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
});

it('preserves the mutation conflict when snapshot reconciliation also fails', async () => {
  const failure = new ThreadRequestError(409, 'thread-conflict');
  const api = { cancelContext: vi.fn().mockRejectedValue(failure) } as unknown as ThreadsAPI;
  const refresh = vi.fn().mockRejectedValue(new Error('snapshot unavailable'));
  await act(async () => root.render(<ContextInspector api={api} identity={identity} snapshot={snapshot()} active={false} refresh={refresh} />));
  await act(async () => stop().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure.message);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('snapshot unavailable');
  expect(refresh).toHaveBeenCalledOnce();
  expect(stop().disabled).toBe(false);
});

it('binds reconciliation to the original projection owner after navigation', async () => {
  const read = vi.fn<ThreadsAPI['snapshot']>(async (target: ThreadIdentity) => ({ ...snapshot(), identity: target }));
  runtime.api = { snapshot: read, contextInspection: async (_target: ThreadIdentity, input: { headId: string | null }) => ({ head: input.headId, counts: { total: 0, user: 0, assistant: 0, tool: 0 }, latestRequest: null, contextRequest: null }),
    observe: async (_cursor: number, _next: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } as unknown as ThreadsAPI;
  const callbacks = new Map<string, () => Promise<void>>();
  function Probe({ target }: { target: ThreadIdentity }) {
    const view = useSelectedThreadSnapshot(true, target);
    React.useEffect(() => { callbacks.set(target.branchId, view.refresh); }, [target.branchId, view.refresh]);
    return <p>{view.snapshot?.identity.branchId}</p>;
  }
  await act(async () => root.render(<Probe target={identity} />));
  const next = { ...identity, branchId: 'branch:next' };
  await act(async () => root.render(<Probe target={next} />));
  const count = read.mock.calls.length;
  await act(async () => callbacks.get(identity.branchId)!());
  expect(read).toHaveBeenCalledTimes(count);
  await act(async () => callbacks.get(next.branchId)!());
  expect(read).toHaveBeenCalledTimes(count + 1);
  expect(read).toHaveBeenLastCalledWith(next, expect.any(AbortSignal));
  expect(read.mock.calls.at(-1)![1]?.aborted).toBe(false);
});
