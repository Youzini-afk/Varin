import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';
import { CompanionDirector } from './directorPresentation';
import { DirectorPortfolioProjector } from './directorPortfolio';

/** Explicit offline coordination choreography review, NOT evidence of a real Varin delegation route. These identities must never be used for Host navigation or writes. */
export type DirectorReviewStep = 'portfolio' | 'team-active' | 'a-child-ended' | 'b-intake' | 'b-result' | 'requests' | 'b-resolved' | 'unknown' | 'reconnected' | 'bot-ready' | 'bot-reasoning' | 'bot-output' | 'report-delivered' | 'retry-wait' | 'queued-successor' | 'queue-promoted' | 'executor-stopped';
export interface DirectorReviewViewOptions {
  visible?: boolean;
  interacting?: boolean;
  inspected?: ThreadIdentity | null;
  hideTaskNames?: boolean;
}
const identity = (name: string): ThreadIdentity => ({ runtime: 'agent', threadId: `review-thread-${name}`, branchId: `review-branch-${name}` });
const runId = (name: string) => `review-run-${name}`;
function branch(name: string, title: string, avatar: string, parent: string | null = null): ThreadAttentionBranch {
  const run = { id: runId(name), state: 'executing' as const, revision: 1, cancelRequested: false, visibleOutput: null };
  return { ...identity(name), title, avatar, botId:'review-bot', botSessionThreadId: identity('entry').threadId, parentThreadId: parent ? identity(parent).threadId : null,
    archived: false, deleted: false, activeRunId: run.id, currentRun: run, latestRun: run, hasUnsettledWork: true };
}
function fixture(step: DirectorReviewStep, cursor: number): ThreadAttentionSnapshot {
  const branches = [branch('a', '资料整理', 'slope-lilac', 'entry'), branch('b', '页面方案', 'dome-ivory', 'entry'), branch('c', '行程确认', 'taper-sage', 'entry'), branch('entry', 'Varin', 'dome-ivory')];
  const team = step !== 'portfolio';
  if (team) branches.push(branch('a-child', '资料核对', 'pebble-blue', 'a'), branch('c-child', '路线核对', 'overlap-coral', 'c'));
  if (step === 'b-intake') {
    const b = branches[1]!;
    b.currentRun = { ...b.currentRun!, state: 'executing' }; b.latestRun = b.currentRun;
  }
  if (['b-result', 'unknown', 'reconnected'].includes(step)) {
    const b = branches[1]!;
    b.activeRunId = null; b.hasUnsettledWork = false;
    b.currentRun = { ...b.currentRun!, state: 'completed', revision: 2 }; b.latestRun = b.currentRun;
  }
  if (step === 'b-result') {
    // Varin's own session round ends with a reply the user can read, after B reported.
    const entry = branches[3]!;
    entry.activeRunId = null;
    entry.currentRun = { ...entry.currentRun!, state: 'completed', revision: 2, visibleOutput: true }; entry.latestRun = entry.currentRun;
  }
  if (step === 'a-child-ended') {
    const child = branches.find(value => value.threadId === identity('a-child').threadId)!;
    child.activeRunId = null; child.hasUnsettledWork = true;
    child.currentRun = { ...child.currentRun!, state: 'completed', revision: 2 }; child.latestRun = child.currentRun;
  }
  const items: ThreadAttentionItem[] = [];
  const request = (name: string, kind: 'permission' | 'question'): ThreadAttentionItem => ({ ...identity(name),
    key: JSON.stringify(['review', name, kind, runId(name)]), runId: runId(name), revision: 1, kind, actionable: true,
    requestId: `review-request-${name}`, operationId: `review-operation-${name}`,
    ...(kind === 'permission' ? { permissionId: 'review-permission-b' } : {}) });
  if (step === 'requests') items.push(request('b', 'permission'));
  if (step === 'requests' || step === 'b-resolved') items.push(request('c', 'question'));
  for (const item of items) {
    const owner = branches.find(value => value.threadId === item.threadId)!;
    owner.currentRun = { ...owner.currentRun!, state: 'waiting' }; owner.latestRun = owner.currentRun;
  }
  return { follows: [],
    delegations: branches.filter(value=>value.parentThreadId).map(value=>({operationId:`review-delegation-${value.threadId}`,parentThreadId:value.parentThreadId!,parentBranchId:value.parentThreadId!.replace('thread','branch'),parentRunId:value.parentThreadId!.replace('thread','run'),childThreadId:value.threadId,childBranchId:value.branchId,acceptedCursor:step==='b-intake'&&value.threadId===identity('b').threadId?cursor:1,
      continuedCursor:null,continuedByThreadId:null,reportCursor:step==='b-result'&&value.threadId===identity('b').threadId?cursor:null,reportOutcome:step==='b-result'&&value.threadId===identity('b').threadId?'succeeded':null})),
    epoch: 1, eventCursor: cursor, coverage: { native: 'complete', external: 'unsupported', scope: 'host' }, branches, items,
    teamExecutions: team ? [{ parentThreadId: identity('a').threadId, parentBranchId: identity('a').branchId,
      parentRunId: runId('a'), childOperationId: 'review-child-operation-a', executionId: 'review-child-execution-a',
      childThreadId: identity('a-child').threadId, childBranchId: identity('a-child').branchId, avatar: 'pebble-blue',
      state: step === 'a-child-ended' ? 'completed' : 'ready', childRunId: runId('a-child'),
        childRunState: step === 'a-child-ended' ? 'completed' : 'executing',
        ...(step === 'a-child-ended' ? {} : { activity: 'running' as const }) },
      { parentThreadId: identity('c').threadId, parentBranchId: identity('c').branchId, parentRunId: runId('c'),
        childOperationId: 'review-child-operation-c', executionId: 'review-child-execution-c',
        childThreadId: identity('c-child').threadId, childBranchId: identity('c-child').branchId, avatar: 'overlap-coral',
        state: 'ready', childRunId: runId('c-child'), childRunState: 'executing', activity: 'running' }] : [],
    counts: { actionRequired: items.length, affectedBranches: new Set(items.map(item => item.branchId)).size, unknownEffects: 0 } };
}

/** All timestamps, receipts and identities below are explicit offline DTO examples, never Host writes. */
const factSteps = new Set<DirectorReviewStep>(['bot-ready', 'bot-reasoning', 'bot-output', 'report-delivered', 'retry-wait', 'queued-successor', 'queue-promoted', 'executor-stopped']);
function factFixture(step: DirectorReviewStep, cursor: number, precursor: boolean): ThreadAttentionSnapshot {
  const snapshot = fixture('portfolio', cursor);
  const root = snapshot.branches.find(value => value.threadId === identity('entry').threadId)!;
  const lead = snapshot.branches[1]!;
  snapshot.branches = [root];
  snapshot.delegations = [];
  root.currentRun = { ...root.currentRun!, state: 'waiting' };
  root.latestRun = root.currentRun;
  if (step === 'bot-ready') root.currentRun.state = 'preparing';
  if (step === 'bot-reasoning' || step === 'bot-output') {
    root.currentRun.state = 'generating';
    root.currentRun.generation = { requestId: 'review-provider-request', phase: step === 'bot-reasoning' ? 'reasoning' : 'output', revision: cursor };
  }
  if (step === 'retry-wait') {
    root.currentRun.state = 'generating';
    root.currentRun.retry = { requestId: 'review-retry-request', attempt: 2, scheduledAtMs: 1, retryAtMs: 2, revision: cursor };
  }
  if (step === 'queued-successor' || step === 'queue-promoted') {
    root.activeRunId = null; root.currentRun = null; root.queuedRunCount = 1;
    root.latestRun = { id: 'review-queued-successor', state: 'accepted', revision: cursor, cancelRequested: false, visibleOutput: null };
    if (step === 'queue-promoted' && !precursor) {
      root.queuedRunCount = 0; root.currentRun = root.latestRun; root.activeRunId = root.currentRun.id;
    }
  }
  if (step === 'report-delivered' || step === 'executor-stopped') {
    snapshot.branches.push(lead);
    snapshot.delegations = (fixture('portfolio', cursor).delegations ?? []).filter(value => value.childThreadId === lead.threadId);
    lead.currentRun = { ...lead.currentRun!, state: step === 'report-delivered' ? 'completed' : precursor ? 'executing' : 'cancelled' };
    lead.latestRun = lead.currentRun;
    lead.activeRunId = precursor && step === 'executor-stopped' ? lead.currentRun.id : null;
    lead.hasUnsettledWork = step === 'executor-stopped';
    if (!precursor && step === 'report-delivered') snapshot.deliveredReports = [{
      parentThreadId: root.threadId, parentBranchId: root.branchId, parentRunId: runId('entry'), receivingRunId: runId('entry'),
      childOperationId: `review-delegation-${lead.threadId}`, executionId: 'review-delivered-execution-b',
      childThreadId: lead.threadId, childBranchId: lead.branchId, deliveredCursor: cursor,
    }];
    if (!precursor && step === 'executor-stopped') snapshot.stoppedExecutors = [{
      threadId: lead.threadId, branchId: lead.branchId, runId: lead.currentRun.id,
      operationId: 'review-stopped-executor-b', revision: cursor, stoppedCursor: cursor,
    }];
  }
  return snapshot;
}

export function createDirectorReviewFixtureSession() {
  const director = new CompanionDirector();
  const mapper = new DirectorPortfolioProjector();
  let cursor = 1;
  let attention = fixture('portfolio', cursor);
  let health: 'current' | 'unknown' = 'current';
  let options: DirectorReviewViewOptions = {};
  const view = (nextOptions: DirectorReviewViewOptions = options) => {
    options = nextOptions;
    const presentation = director.observe(attention, health,
      options.inspected === undefined ? identity('a') : options.inspected,
      { visible: options.visible ?? true, interacting: options.interacting ?? false, cardCapacity: 3, interactionRoute: 'coordination-review' });
    return { reviewOnly: true as const, attention, presentation,
      projection: mapper.project(presentation, attention, 1, [], { hideTaskNames: options.hideTaskNames }) };
  };
  return {
    view,
    step(name: DirectorReviewStep): void {
      // A button jump still observes the actual precursor; React batching cannot manufacture edges.
      director.discardTransient(); health = 'current';
      if (factSteps.has(name)) {
        attention = factFixture(name, ++cursor, true); view();
        attention = factFixture(name, ++cursor, false); view();
        return;
      }
      attention = fixture(name === 'b-result' || name === 'a-child-ended' ? 'team-active' : name === 'b-resolved' ? 'requests' : name, ++cursor);
      if (name === 'b-intake') attention.branches = attention.branches.filter(value => value.threadId !== identity('b').threadId);
      view();
      if (name === 'reconnected') { health = 'unknown'; view(); health = 'current'; }
      attention = fixture(name, ++cursor); health = name === 'unknown' ? 'unknown' : 'current';
      view();
    },
    consumeEdge(key: string): void { director.consumeEdge(key); },
    discardTransient(): void { director.discardTransient(); },
  };
}
