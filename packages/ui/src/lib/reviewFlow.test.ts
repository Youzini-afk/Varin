import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadSubmit, ThreadsAPI, RuntimeAPIs } from '@varin/application-client';
import type { HistoryItem, InputSubmitReceipt, Run } from '@varin/protocol';
const endpoint = vi.hoisted(() => ({ generation: 1, url: 'https://host-a', before: new Set<() => void>() }));
const panel = vi.hoisted(() => vi.fn());
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeApiBaseUrl: () => endpoint.url, getRuntimeKey: () => 'same-label', getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => { endpoint.before.add(listener); return () => endpoint.before.delete(listener); },
}));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ openContextPanelTab: panel }) } }));
import { registerRuntimeAPIs } from './runtime-api/registry';
import { threadHostKey } from '@/stores/useThreadStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { reviewLinkKey, useReviewFlowStore } from '@/stores/useReviewFlowStore';
import { hasFinalReviewMarker, resumeAutoReviewRun, startReviewFlow, stopAutoReviewRun, transferReviewMessage } from './reviewFlow';
const original: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const review: ThreadIdentity = { runtime: 'agent', threadId: 'thread:review', branchId: 'branch:review' };
const model = { providerId: 'review-channel', modelId: 'review-model' };
const config = { providerId: 'original-channel', model: 'original-model' };
const source = { resource_owner: { kind: 'managed_host', hostId: 'actual-host', connectionId: 'remote-connection', endpointIdentity: 'https://source-host' },
  workspace_id: 'workspace:original', execution_workspace_id: 'workspace:worktree', mode: 'materialized', branch_id: 'source:fixed', revision: 7, live_root: null, environment_run_id: 'run:worktree-owner' } as const;
const ownerRun = (identity: ThreadIdentity, id: string, state: Run['state'] = 'completed'): Run => ({ id, thread_id: identity.threadId,
  branch_id: identity.branchId, state, revision: 1, epoch: 1, configuration: config, cancel_requested: false, waiting_on: null });
function snapshot(identity: ThreadIdentity): ThreadSnapshot {
  const run = ownerRun(identity, 'run:previous');
  return { identity, eventCursor: 0, thread: { thread_id: identity.threadId, main_branch_id: identity.branchId,
    title: '', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null,
    activity_cursor: 0, read_cursor: 0, unread: false, bot_id: null, observer_project_ids: [],
    branches: [{ branch_id: identity.branchId, head: null, active_run_id: null, latest_run: run }] },
    activeRun: null, history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [],
    launch: { run_id: run.id, selection: { source, tools: [{ name: 'file_read', requirements: { source: 'source', process: false } }] } } as ThreadSnapshot['launch'],
    modelSelection: { active: null, desired: null }, policySelection: null, context: { checkpoint: null, jobs: [] } };
}
const assistant = (id: string, runId: string, text: string): HistoryItem => ({ id, run_id: runId, thread_id: review.threadId, parent: null, source: 'assistant', provider: null, content: { content: { kind: 'text', text } } });
function fixture() {
  const views = new Map([[original.threadId, snapshot(original)], [review.threadId, snapshot(review)]]);
  const receipts = new Map<string, InputSubmitReceipt>(); const runs = new Map<string, Run>(); let sequence = 0;
  const submit = vi.fn(async (input: ThreadSubmit) => {
    const previous = receipts.get(input.key); if (previous) return previous;
    const view = views.get(input.threadId)!;
    const id = `run:${++sequence}`; const inputId = `input:${sequence}`;
    const run = ownerRun(input, id, 'generating'); run.configuration = { providerId: input.model.providerId, model: input.model.modelId };
    runs.set(id, run); view.activeRun = run; view.thread.branches[0].latest_run = run; view.thread.branches[0].active_run_id = id;
    view.history.push({ id: inputId, thread_id: input.threadId, run_id: id, source: 'user', content: input.text, parent: view.historyPage.head, provider: null }); view.historyPage.head = inputId;
    const receipt = { thread_id: input.threadId, branch_id: input.branchId, input_id: inputId, run_id: id, cursor: sequence }; receipts.set(input.key, receipt); return receipt;
  });
  const api = { create: vi.fn(async () => review), update: vi.fn(async () => views.get(review.threadId)!.thread), snapshot: vi.fn(async (id: ThreadIdentity) => views.get(id.threadId)!), submit,
    run: vi.fn(async (id: string) => runs.get(id)!), historyPage: vi.fn(), cancelRun: vi.fn() } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ threads: api } as RuntimeAPIs);
  const complete = (text: string) => {
    const input = submit.mock.calls.at(-1)![0]; const receipt = receipts.get(input.key)!; const view = views.get(input.threadId)!;
    runs.get(receipt.run_id)!.state = 'completed'; view.activeRun = null; view.thread.branches[0].active_run_id = null;
    const item = assistant(`answer:${sequence}`, receipt.run_id, text); item.thread_id = input.threadId;
    view.history.push(item); view.historyPage.head = item.id;
  };
  return { api, views, submit, complete };
}
const key = () => reviewLinkKey(threadHostKey(), original);
const flow = () => useAutoReviewStore.getState().runs[key()];
const advance = () => vi.advanceTimersByTimeAsync(1100);
beforeEach(() => { vi.useFakeTimers(); endpoint.generation += 1; endpoint.url = 'https://host-a'; useAutoReviewStore.setState({ runs: {} }); useReviewFlowStore.setState({ linksByOriginal: {} }); panel.mockClear(); });
afterEach(async () => { useAutoReviewStore.getState().stopAll(); await advance(); vi.useRealTimers(); registerRuntimeAPIs(null); });

describe('native review workflow', () => {
  it('creates real review identity, hands off the exact accepted run and retains the original remote working copy', async () => {
    const f = fixture();
    await startReviewFlow({ original, directory: '/navigation/not-authority', model });
    expect(f.submit.mock.calls[0][0]).toMatchObject({ ...original, model: { providerId: 'original-channel' }, source: {
      resourceOwner: source.resource_owner, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      environmentRunId: source.environment_run_id, branchId: source.branch_id, revision: 7, tools: ['file_read'],
    } });
    expect(panel).toHaveBeenCalledWith('/navigation/not-authority', expect.objectContaining({ thread: review }));
    f.complete('Intent, changes and validation'); await advance();
    expect(f.submit.mock.calls[1][0]).toMatchObject({ ...review, model, text: expect.stringContaining('Intent, changes and validation') });
    expect(f.submit.mock.calls[1][0].source).toEqual(f.submit.mock.calls[0][0].source);
    f.complete('No issues found'); await advance();
    expect(flow().status).toBe('completed'); expect(f.submit).toHaveBeenCalledTimes(2);
  });
  it('forwards exact reviewer and implementer runs without treating an unrelated marker as completion', async () => {
    const f = fixture(); await startReviewFlow({ original, directory: '/workspace', model, generateHandoff: false, autoReview: true });
    f.views.get(review.threadId)!.history.push(assistant('unrelated', 'run:someone-else', 'FINAL_REVIEW_STATUS: no_remaining_findings'));
    f.complete('Fix the missed bound check.'); await advance();
    expect(f.submit.mock.calls[1][0]).toMatchObject({ ...original, text: expect.stringContaining('Fix the missed bound check.') });
    f.complete('Bound check fixed and tested.'); await advance();
    expect(f.submit.mock.calls[2][0]).toMatchObject({ ...review, text: expect.stringContaining('Bound check fixed and tested.') });
    f.complete('No remaining findings.\nFINAL_REVIEW_STATUS: no_remaining_findings'); await advance();
    expect(flow().status).toBe('completed'); expect(f.submit).toHaveBeenCalledTimes(3);
  });
  it('reconciles lost create and admission replies with the original keys and immutable command', async () => {
    const f = fixture(); vi.mocked(f.api.create).mockRejectedValueOnce(new Error('create reply lost'));
    await expect(startReviewFlow({ original, directory: '/workspace', model, generateHandoff: false })).rejects.toThrow('create reply lost');
    const createKey = vi.mocked(f.api.create).mock.calls[0][0];
    const nativeSubmit = f.submit.getMockImplementation()!;
    f.submit.mockImplementationOnce(async input => { await nativeSubmit(input); throw new Error('submit reply lost'); });
    await expect(resumeAutoReviewRun(key())).rejects.toThrow('submit reply lost');
    expect(vi.mocked(f.api.create).mock.calls[1][0]).toBe(createKey);
    expect(flow().command?.status).toBe('unknown');
    const acceptedInput = f.submit.mock.calls[0][0];
    await resumeAutoReviewRun(key());
    expect(f.submit.mock.calls[1][0]).toBe(acceptedInput);
    expect(flow().command?.receipt?.run_id).toBe('run:1');
    f.complete('Review complete'); await advance(); expect(flow().status).toBe('completed');
  });
  it('fences a Host switch during reads even when labels and thread IDs are reused', async () => {
    const f = fixture(); let resolve!: (value: ThreadSnapshot) => void;
    vi.mocked(f.api.snapshot).mockImplementationOnce(async () => f.views.get(original.threadId)!).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const starting = startReviewFlow({ original, directory: '/workspace', model, generateHandoff: false });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    for (const callback of endpoint.before) callback(); endpoint.url = 'https://host-b'; endpoint.generation += 1;
    resolve(f.views.get(review.threadId)!);
    await expect(starting).rejects.toThrow('Application Host changed'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('stops forwarding without claiming or requesting cancellation of an accepted executor', async () => {
    const f = fixture(); await startReviewFlow({ original, directory: '/workspace', model, generateHandoff: false, autoReview: true });
    const accepted = flow().command!.receipt;
    stopAutoReviewRun(key()); f.complete('Please fix this'); await advance();
    expect(flow()).toMatchObject({ status: 'stopped', command: { receipt: accepted } });
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.api.cancelRun).not.toHaveBeenCalled();
  });
  it('preserves failed execution as a paused outcome instead of forwarding a partial response', async () => {
    const f = fixture(); await startReviewFlow({ original, directory: '/workspace', model, generateHandoff: false, autoReview: true });
    f.views.get(review.threadId)!.activeRun!.state = 'cancelled'; await advance();
    expect(flow()).toMatchObject({ status: 'paused', error: expect.stringContaining('cancelled') }); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects missing source instead of resolving a navigation path on the local Host', async () => {
    const f = fixture(); f.views.get(original.threadId)!.launch = null;
    await expect(startReviewFlow({ original, directory: '/same-name-local-path', model })).rejects.toThrow('workspace source');
    expect(f.api.create).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('deduplicates explicit transfer and reconciles uncertain acceptance with the same native command', async () => {
    const f = fixture(); useReviewFlowStore.getState().upsertLink({ hostKey: threadHostKey(), original, review, directory: '/workspace' });
    const item = assistant('review-message', 'review-run', 'Fix this finding.');
    const nativeSubmit = f.submit.getMockImplementation()!;
    f.submit.mockImplementationOnce(async input => { await nativeSubmit(input); throw new Error('lost delivery'); });
    const first = transferReviewMessage(review, item); const second = transferReviewMessage(review, item);
    await expect(first).rejects.toThrow('lost delivery'); await expect(second).rejects.toThrow('lost delivery');
    expect(f.submit).toHaveBeenCalledTimes(1);
    await transferReviewMessage(review, item); expect(f.submit.mock.calls[1][0]).toBe(f.submit.mock.calls[0][0]);
    await transferReviewMessage(review, item); expect(f.submit).toHaveBeenCalledTimes(2);
    endpoint.generation += 1;
    await expect(transferReviewMessage(review, item)).rejects.toThrow('earlier Host connection');
  });
  it('deduplicates repeated review clicks while the original branch snapshot is pending', async () => {
    const f = fixture(); let resolve!: (snapshot: ThreadSnapshot) => void;
    vi.mocked(f.api.snapshot).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const input = { original, directory: '/workspace', model, generateHandoff: false };
    const first = startReviewFlow(input); const second = startReviewFlow(input);
    expect(first).toBe(second); resolve(f.views.get(original.threadId)!); await first;
    expect(f.api.create).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('requires the final marker on the final line', () => {
    expect(hasFinalReviewMarker('No issues.\nFINAL_REVIEW_STATUS: no_remaining_findINGS\n')).toBe(true);
    expect(hasFinalReviewMarker('FINAL_REVIEW_STATUS: no_remaining_findings\nStill have findings')).toBe(false);
  });
});
