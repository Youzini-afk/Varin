import {
  getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, ThreadRequestError,
  type ThreadIdentity, type ThreadModel, type ThreadSnapshot, type ThreadSource, type ThreadsAPI,
} from '@varin/application-client';
import type { HistoryItem } from '@varin/protocol';
import { actionInstruction } from '@/lib/actionInstructions';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useAutoReviewStore, type AutoReviewRun, type ReviewCommand } from '@/stores/useAutoReviewStore';
import { reviewLinkKey, useReviewFlowStore, type ReviewThreadLink } from '@/stores/useReviewFlowStore';
import { threadHostKey, useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';

const FINAL_MARKER = 'FINAL_REVIEW_STATUS: no_remaining_findings';
const POLL_MS = 1000;
const activeLoops = new Set<string>();
const activeCommands = new Map<string, Promise<void>>();
const owners = new Map<string, ThreadsAPI>();
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
const sameIdentity = (left: ThreadIdentity, right: ThreadIdentity) => left.threadId === right.threadId && left.branchId === right.branchId;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const current = (run: AutoReviewRun) => run.hostGeneration === getRuntimeEndpointGeneration() && run.hostKey === threadHostKey();
const assertOwner = (run: AutoReviewRun) => { if (!current(run)) throw new Error('Application Host changed. Return to the original Host to inspect accepted work.'); };
const getRun = (key: string) => useAutoReviewStore.getState().runs[key];
const patch = (key: string, value: Partial<AutoReviewRun>) => useAutoReviewStore.getState().update(key, value);
const assertRunning = (run: AutoReviewRun) => {
  assertOwner(run);
  if (getRun(run.key)?.status !== 'running' || getRun(run.key)?.createKey !== run.createKey) throw new Error('Review forwarding stopped. Accepted work is still owned by its original run.');
};
const requireAPI = () => {
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!api) throw new Error('Thread execution is unavailable');
  return api;
};
subscribeRuntimeEndpointWillChange(() => useAutoReviewStore.getState().stopAll());

export const hasFinalReviewMarker = (text: string): boolean => text.trim().split('\n').at(-1)?.trim().toLowerCase() === FINAL_MARKER.toLowerCase();
export const stripFinalReviewMarker = (text: string): string => hasFinalReviewMarker(text) ? text.trimEnd().split('\n').slice(0, -1).join('\n').trim() : text;
const reviewerInstructions = (text: string) => `${text}\n\nThis is an automatic review. If there are no remaining findings, end with this exact final line:\n${FINAL_MARKER}\nOtherwise explain the findings and omit that line.`;

/** Preserve the admitted source, including its remote authority and actual materialized environment.
 * A navigation directory is never substituted for this execution identity. */
export function reviewSource(snapshot: ThreadSnapshot): ThreadSource {
  const source = snapshot.launch?.selection.source;
  if (!source) throw new Error('Select a workspace source in the implementation conversation before reviewing it.');
  const base = { resourceOwner: source.resource_owner, workspaceId: source.workspace_id,
    executionWorkspaceId: source.execution_workspace_id,
    tools: snapshot.launch!.selection.tools.filter(tool => tool.requirements).map(tool => tool.name) };
  if (source.mode === 'live_root') {
    if (!source.live_root) throw new Error('The original live workspace identity is unavailable.');
    return { ...base, mode: 'live_root', liveRoot: source.live_root };
  }
  if (!source.branch_id || source.revision === null) throw new Error('The original source revision is unavailable.');
  return { ...base, mode: source.mode, branchId: source.branch_id, revision: source.revision,
    ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}) };
}
export function reviewModel(snapshot: ThreadSnapshot): ThreadModel {
  const branch = snapshot.thread.branches.find(value => value.branch_id === snapshot.identity.branchId);
  const config = (snapshot.modelSelection.active?.configuration ?? branch?.latest_run?.configuration) as {
    providerId?: string; model?: string; thinkingLevel?: ThreadModel['thinkingLevel']; modelOptions?: { catalogModelId?: string; temperature?: number };
  } | undefined;
  if (!config?.providerId || !config.model) throw new Error('The implementation conversation has no selected model.');
  return { providerId: config.providerId, modelId: config.modelOptions?.catalogModelId ?? config.model,
    ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
    ...(config.modelOptions?.temperature === undefined ? {} : { temperature: config.modelOptions.temperature }) };
}
export function reviewableAssistantText(item: HistoryItem): string {
  if (item.source !== 'assistant') return '';
  const content = (item.content as { content?: { kind?: string; text?: string; output?: { parts?: Array<{ kind: string; text?: string }> } } } | null)?.content;
  if (content?.kind === 'text') return content.text?.trim() ?? '';
  if (content?.kind === 'output') return content.output?.parts?.filter(part => part.kind === 'text').map(part => part.text ?? '').join('\n').trim() ?? '';
  return '';
}
export function openReviewThread(link: ReviewThreadLink): void {
  if (link.hostKey !== threadHostKey()) throw new Error('Review belongs to another Application Host.');
  useUIStore.getState().openContextPanelTab(link.directory, { mode: 'chat', thread: link.review,
    dedupeKey: JSON.stringify([link.review.threadId, link.review.branchId]), label: 'Review', readOnly: false });
}
function remember(run: AutoReviewRun): void {
  if (!run.review) return;
  useReviewFlowStore.getState().upsertLink({ hostKey: run.hostKey, original: run.original, review: run.review, directory: run.directory });
}
function fail(key: string, error: unknown): void {
  const run = getRun(key);
  if (!run || run.status === 'stopped') return;
  patch(key, { status: current(run) ? 'paused' : 'stopped', error: message(error) });
}
function idle(snapshot: ThreadSnapshot): void {
  const branch = snapshot.thread.branches.find(value => value.branch_id === snapshot.identity.branchId);
  if (branch?.active_run_id || snapshot.activeRun && !['completed', 'failed', 'cancelled'].includes(snapshot.activeRun.state)) {
    throw new Error('This conversation has active work. Wait for it to finish before forwarding review input.');
  }
}
async function dispatch(key: string): Promise<void> {
  const existing = activeCommands.get(key);
  if (existing) return existing;
  const work = (async () => {
    let run = getRun(key); assertRunning(run);
    const api = owners.get(key)!;
    if (!run.review) {
      // An uncertain create retains the same native key; there is no replacement conversation.
      const review = await api.create(run.createKey);
      patch(key, { review, phase: run.generateHandoff ? 'handoff' : 'review' });
      assertRunning(run);
      run = getRun(key); remember(run);
      void useThreadStore.getState().loadCatalog().catch(() => {});
      openReviewThread({ hostKey: run.hostKey, original: run.original, review, directory: run.directory });
    }
    if (!run.reviewTitled) {
      if (!run.titleCommand) {
        assertRunning(run); const snapshot = await api.snapshot(run.review!); assertRunning(run);
        patch(key, { titleCommand: { runtime: 'agent', threadId: run.review!.threadId, key: `${run.createKey}:title`,
          expectedRevision: snapshot.thread.revision, title: run.reviewTitle } });
        run = getRun(key);
      }
      assertRunning(run); await api.update(run.titleCommand!); patch(key, { reviewTitled: true }); assertRunning(run);
      run = getRun(key);
      void useThreadStore.getState().loadCatalog().catch(() => {});
    }
    if (!run.command) {
      const target = run.phase === 'review' ? run.review! : run.original;
      assertRunning(run); const snapshot = await api.snapshot(target); assertRunning(run); idle(snapshot);
      const expectedHead = run.phase === 'review' ? run.reviewHead : run.originalHead;
      if (snapshot.historyPage.head !== expectedHead) throw new Error('The conversation changed outside this review. Stop forwarding and inspect the current branch before starting another review.');
      const input = { ...target, key: crypto.randomUUID(), expectedHead, text: run.prompt,
        model: run.phase === 'review' ? run.reviewModel : run.originalModel, source: run.source };
      patch(key, { command: { input, status: 'sending' } });
      run = getRun(key);
    }
    if (run.command!.receipt) return;
    const command = run.command!;
    patch(key, { command: { ...command, status: 'sending' }, error: undefined });
    assertRunning(run);
    try {
      const receipt = await api.submit(command.input);
      // Keep the original receipt even if Stop/Host switch happened while admission was in flight.
      patch(key, { command: { ...command, receipt, status: 'accepted' } });
      assertRunning(run);
    } catch (error) {
      if (!getRun(key).command?.receipt) patch(key, { command: { ...command,
        status: error instanceof ThreadRequestError && error.admission === 'not_started' ? 'rejected' : 'unknown' } });
      throw error;
    }
  })();
  activeCommands.set(key, work);
  try { await work; } finally { if (activeCommands.get(key) === work) activeCommands.delete(key); }
}
async function completedReply(run: AutoReviewRun, api: ThreadsAPI): Promise<{ text: string; head: string | null } | null> {
  const receipt = run.command?.receipt;
  if (!receipt) throw new Error('Review input acceptance is unknown. Retry the original delivery to reconcile its receipt.');
  assertRunning(run); const execution = await api.run(receipt.run_id); assertRunning(run);
  if (execution.thread_id !== receipt.thread_id || execution.branch_id !== receipt.branch_id) throw new Error('The original review run identity changed.');
  if (execution.state === 'failed' || execution.state === 'cancelled') throw new Error(`The original review run ${execution.state}. Inspect its result before starting another review.`);
  if (execution.state !== 'completed') return null;
  const identity = run.command!.input;
  const snapshot = await api.snapshot(identity); assertRunning(run);
  const branch = snapshot.thread.branches.find(value => value.branch_id === identity.branchId);
  if (branch?.latest_run?.id !== receipt.run_id) throw new Error('A newer run changed this conversation. Automatic forwarding is paused.');
  const items = [...snapshot.history]; let previous = snapshot.historyPage.previous;
  const seen = new Set<string>();
  while (previous && snapshot.historyPage.head && !items.some(item => item.id === receipt.input_id)) {
    if (seen.has(previous)) throw new Error('Review history pagination did not advance.');
    seen.add(previous); assertRunning(run);
    const page = await api.historyPage(identity, { headId: snapshot.historyPage.head, beforeId: previous });
    assertRunning(run); items.unshift(...page.items); previous = page.previous;
  }
  const text = items.filter(item => item.run_id === receipt.run_id).map(reviewableAssistantText).filter(Boolean).join('\n\n');
  if (!text) throw new Error('The accepted run completed without a review response. Inspect its history before continuing.');
  return { text, head: snapshot.historyPage.head };
}
function monitor(key: string): void {
  const token = getRun(key).createKey;
  if (activeLoops.has(token)) return;
  activeLoops.add(token);
  void (async () => {
    while (getRun(key)?.status === 'running' && getRun(key)?.createKey === token) {
      const run = getRun(key); assertRunning(run);
      const reply = await completedReply(run, owners.get(key)!);
      if (!reply) { await sleep(); continue; }
      assertRunning(run);
      if (run.phase === 'handoff') {
        let prompt = actionInstruction('session.reviewSession.visible', { handoff: reply.text });
        if (run.autoReview) prompt = reviewerInstructions(prompt);
        patch(key, { originalHead: reply.head, phase: 'review', prompt, command: undefined });
      } else if (run.phase === 'review') {
        if (!run.autoReview || hasFinalReviewMarker(reply.text)) {
          patch(key, { reviewHead: reply.head, status: 'completed' }); return;
        }
        if (run.iteration >= run.maxIterations) {
          patch(key, { status: 'paused', error: 'The selected review-round limit was reached. Inspect the remaining findings before continuing.' }); return;
        }
        patch(key, { reviewHead: reply.head, phase: 'implementation', command: undefined,
          prompt: actionInstruction('session.reviewFeedbackToImplementer.visible', { review_feedback: reply.text }) });
      } else {
        patch(key, { originalHead: reply.head, phase: 'review', command: undefined, iteration: run.iteration + 1,
          prompt: reviewerInstructions(actionInstruction('session.implementationResponseToReviewer.visible', { implementation_response: reply.text })) });
      }
      await dispatch(key);
    }
  })().catch(error => fail(key, error)).finally(() => activeLoops.delete(token));
}
export interface StartReviewFlowInput {
  original: ThreadIdentity;
  directory: string;
  model: ThreadModel;
  generateHandoff?: boolean;
  autoReview?: boolean;
  /** An explicit user budget, not a protocol limit. */
  maxIterations?: number;
}
async function prepareReviewFlow(input: StartReviewFlowInput): Promise<void> {
  const api = requireAPI(); const generation = getRuntimeEndpointGeneration(); const hostKey = threadHostKey();
  const key = reviewLinkKey(hostKey, input.original);
  if (getRun(key)?.status === 'running' || getRun(key)?.status === 'paused' || getRun(key)?.command?.status === 'unknown' || getRun(key)?.phase === 'creating_review') {
    throw new Error('Resolve the existing review before starting another one. Its original delivery and result remain available.');
  }
  const snapshot = await api.snapshot(input.original);
  if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed.');
  idle(snapshot);
  const autoReview = input.autoReview ?? false; const generateHandoff = input.generateHandoff ?? true;
  const maxIterations = input.maxIterations ?? 15;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new Error('Choose a positive number of review rounds.');
  let prompt = generateHandoff ? `${actionInstruction('session.reviewHandoff.visible')}\n\n${actionInstruction('session.reviewHandoff.instructions')}`
    : actionInstruction('session.reviewSessionWithoutHandoff.visible');
  if (autoReview && !generateHandoff) prompt = reviewerInstructions(prompt);
  const run: AutoReviewRun = { key, hostKey, hostGeneration: generation, original: input.original, directory: input.directory,
    source: reviewSource(snapshot), originalModel: reviewModel(snapshot), reviewModel: input.model,
    originalHead: snapshot.historyPage.head, reviewHead: null, createKey: crypto.randomUUID(), reviewTitle: `Review: ${snapshot.thread.title.trim() || input.original.threadId}`,
    autoReview, generateHandoff, maxIterations, status: 'running', phase: 'creating_review', iteration: 0, prompt };
  owners.set(key, api); useAutoReviewStore.getState().put(run);
  try { await dispatch(key); monitor(key); } catch (error) { fail(key, error); throw error; }
}
const starting = new Map<string, { fingerprint: string; work: Promise<void> }>();
export function startReviewFlow(input: StartReviewFlowInput): Promise<void> {
  const key = reviewLinkKey(threadHostKey(), input.original);
  const fingerprint = JSON.stringify(input); const existing = starting.get(key);
  if (existing) return existing.fingerprint === fingerprint ? existing.work : Promise.reject(new Error('Another review is already being prepared for this branch.'));
  const work = prepareReviewFlow(input); starting.set(key, { fingerprint, work });
  const clear = () => { if (starting.get(key)?.work === work) starting.delete(key); };
  void work.then(clear, clear); return work;
}
export async function resumeAutoReviewRun(key: string): Promise<void> {
  const run = getRun(key); if (!run) return;
  assertOwner(run);
  if (run.status === 'running') return;
  if (run.status === 'completed') return;
  if (run.phase === 'review' && run.iteration >= run.maxIterations && run.command?.receipt) {
    throw new Error('Start another review explicitly if more review rounds are needed.');
  }
  patch(key, { status: 'running', error: undefined });
  try { await dispatch(key); monitor(key); } catch (error) { fail(key, error); throw error; }
}
/** Stops future forwarding only; never reports that accepted work or its executors stopped. */
export function stopAutoReviewRun(key: string): void { patch(key, { status: 'stopped', error: 'Forwarding stopped. Accepted runs continue; use Stop run in their conversation to request cancellation.' }); }

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';
export function getReviewLink(identity: ThreadIdentity): ReviewThreadLink | undefined {
  return Object.values(useReviewFlowStore.getState().linksByOriginal).find(link => link.hostKey === threadHostKey()
    && (sameIdentity(link.original, identity) || sameIdentity(link.review, identity)));
}
export function getReviewTransferDirection(identity: ThreadIdentity): ReviewTransferDirection | null {
  const link = getReviewLink(identity);
  return link ? sameIdentity(link.review, identity) ? 'review-to-original' : 'original-to-review' : null;
}
const transfers = new Map<string, { generation: number; command?: ReviewCommand; pending?: Promise<void> }>();
/** Explicit transfer is keyed by the original message, including after a lost acknowledgement. */
export async function transferReviewMessage(identity: ThreadIdentity, item: HistoryItem): Promise<void> {
  const host = threadHostKey(); const generation = getRuntimeEndpointGeneration(); const api = requireAPI();
  const link = getReviewLink(identity); if (!link) throw new Error('The linked review conversation is unavailable.');
  const loop = getRun(reviewLinkKey(host, link.original));
  if (loop?.status === 'running' || loop?.status === 'paused') throw new Error('Stop automatic forwarding before sending a review message manually.');
  const text = reviewableAssistantText(item); if (!text) throw new Error('This message has no review text to transfer.');
  const key = JSON.stringify([host, identity.threadId, identity.branchId, item.id]);
  let transfer = transfers.get(key);
  if (transfer) {
    if (transfer.generation !== generation) throw new Error('This delivery belongs to an earlier Host connection. Inspect its original conversation before sending again.');
    if (transfer.command?.receipt) return;
    if (transfer.pending) return transfer.pending;
  } else {
    transfer = { generation }; transfers.set(key, transfer);
  }
  const original = transfer;
  const assertCurrent = () => { if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed.'); };
  const work = (async () => {
    try {
      if (!original.command) {
        const toOriginal = sameIdentity(identity, link.review); const target = toOriginal ? link.original : link.review;
        assertCurrent(); const snapshot = await api.snapshot(target); assertCurrent(); idle(snapshot);
        const prompt = toOriginal ? actionInstruction('session.reviewFeedbackToImplementer.visible', { review_feedback: text })
          : actionInstruction('session.implementationResponseToReviewer.visible', { implementation_response: text });
        original.command = { status: 'sending', input: { ...target, key: crypto.randomUUID(), expectedHead: snapshot.historyPage.head,
          text: prompt, model: reviewModel(snapshot), source: reviewSource(snapshot) } };
      }
      assertCurrent(); original.command.status = 'sending';
      original.command.receipt = await api.submit(original.command.input); original.command.status = 'accepted';
      if (generation === getRuntimeEndpointGeneration() && sameIdentity(identity, link.original)) openReviewThread(link);
    } catch (error) {
      if (original.command && !original.command.receipt) original.command.status = error instanceof ThreadRequestError && error.admission === 'not_started' ? 'rejected' : 'unknown';
      throw error;
    } finally { original.pending = undefined; }
  })(); original.pending = work; return work;
}
