import type { ThreadAttentionBranch, ThreadAttentionItem, ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';
import { agentAvatarForIdentity, type AgentAvatarId } from '@varin/protocol';
import { directorProjectRelations, directorChildMembers, type DirectorChildMember } from './directorProjects';

/** The lead is the existing task Thread's Agent, not another Varin or a synthetic child. */
export interface DirectorProjectCard {
  key: string;
  identity: ThreadIdentity;
  title: string;
  /** undefined: old/unknown Host metadata; null: known no Bot binding. */
  botId?: string | null;
  lead: { role: 'project-lead' | 'child-agent' | 'task'; identity: string; avatar: AgentAvatarId; runId: string | null; state: string | null };
  status: 'needs-user' | 'uncertain' | 'active' | 'settling' | 'result' | 'available' | 'unknown';
  attentionKeys: string[];
  children: DirectorChildMember[];
  relation: 'project-task' | 'child-task' | 'unclassified-task';
}
export type DirectorInteractionRoute = 'bot-coordinator' | 'agent-companion' | 'unknown' | 'coordination-review';
export type DirectorVerb = 'synchronizing' | 'unavailable' | 'review-portfolio' | 'available'
  | 'present-attention' | 'receive-work' | 'dispatch-work' | 'receive-report' | 'executor-stopped' | 'receive-result' | 'notify-attention' | 'notify-result';
export interface DirectorEdge {
  key: string;
  kind: 'receive-work' | 'dispatch-work' | 'receive-report' | 'executor-stopped' | 'receive-result';
  receiptOperationId?: string;
  receiptCursor?: number;
  reportExecutionId?: string;
  receivingRunId?: string;
  /** Root profile proof is required for an intake without an external project card. */
  rootProfileRevision?: string;
  project: ThreadIdentity;
  runId: string | null;
  dispatchOperationId?: string;
  outcome: 'completed' | 'failed' | 'cancelled' | null;
  /** A completed parent Run can still leave independent work unsettled. */
  workRemains: boolean;
}
export interface DirectorPresentation {
  /** Presentation policy only; current metadata does not prove delegation through Varin. */
  interactionRoute: DirectorInteractionRoute;
  inspectionRoute: DirectorInteractionRoute;
  source: { epoch: number; eventCursor: number } | null;
  health: 'current' | 'unknown' | 'synchronizing';
  body: { /** Expressive work, never evidence of keyboard/tool execution. */ workActive?: boolean; activity?: { kind: 'preparing' | 'thinking' | 'waiting' | 'retry' | 'queued'; key: string; subject: ThreadIdentity }; subjectRoute: DirectorInteractionRoute; verb: DirectorVerb; subject: ThreadIdentity | null; attentionOwner: ThreadIdentity | null; attentionMode: 'single' | 'multiple' | null; attentionItem: ThreadAttentionItem | null; edge: DirectorEdge | null };
  cards: DirectorProjectCard[];
  /** Additional factual cards, not a count of independent business Projects. */
  overflowCards: number;
  inspectedProjectKey: string | null;
  inspection: DirectorProjectCard | null;
  counts: { actionRequired: number; uncertain: number; activeProjectTasks: number } | null;
  coverage: ThreadAttentionSnapshot['coverage'] | null;
}
/** Product mode and task ownership are independent. An absent binding never grants coordination. */
export function directorProjectRoute(route: DirectorInteractionRoute, botId: string | null | undefined): DirectorInteractionRoute {
  if (route === 'coordination-review') return route;
  if (route === 'agent-companion') return route;
  return route === 'bot-coordinator' && typeof botId === 'string' && botId.length > 0 ? 'bot-coordinator' : 'unknown';
}
const isCoordinating = (route: DirectorInteractionRoute) => route === 'bot-coordinator' || route === 'coordination-review';
const ended = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
const branchKey = (branch: { threadId: string; branchId: string }) => JSON.stringify([branch.threadId, branch.branchId]);
const identity = (branch: { threadId: string; branchId: string }): ThreadIdentity => ({ runtime: 'agent', threadId: branch.threadId, branchId: branch.branchId });
const hasQueuedRuns = (branch: ThreadAttentionBranch) => Number.isSafeInteger(branch.queuedRunCount) && (branch.queuedRunCount ?? 0) > 0;
const active = (branch: ThreadAttentionBranch) => hasQueuedRuns(branch) || branch.hasUnsettledWork || !!(branch.currentRun && !ended(branch.currentRun.state));

/** Prototype: manager body + stable project cards; inspection NEVER makes the body a tool executor.
 * It consumes compact authoritative metadata only. It does not schedule, approve or create reports.
 */
export class CompanionDirector {
  private epoch: number | null = null;
  private route: DirectorInteractionRoute = 'unknown';
  private order: string[] = [];
  private previousRuns = new Map<string, string>();
  private previousActiveRuns = new Map<string, string | null>();
  private initialized = false;
  private previousCursor: number | null = null;
  private previousRoots = new Map<string,string>();
  private edge: DirectorEdge | null = null;
  private attentionSubject: string | null = null;

  discardTransient(): void { this.edge = null; this.initialized = false; this.previousRuns.clear(); this.previousActiveRuns.clear(); this.previousCursor = null; this.previousRoots.clear(); }
  consumeEdge(key: string): void { if (this.edge?.key === key) this.edge = null; }

  observe(snapshot: ThreadAttentionSnapshot | null, health: 'current' | 'unknown' | 'synchronizing',
    inspected: ThreadIdentity | null, options: { visible: boolean; interacting: boolean; cardCapacity: number; interactionRoute?: DirectorInteractionRoute }): DirectorPresentation {
    const route = options.interactionRoute ?? 'unknown';
    if (snapshot?.epoch !== this.epoch || route !== this.route) {
      this.route = route;
      this.epoch = snapshot?.epoch ?? null; this.order = []; this.previousRuns.clear(); this.previousActiveRuns.clear();
      this.initialized = false; this.edge = null; this.attentionSubject = null; this.previousCursor = null; this.previousRoots.clear();
    }
    const current = health === 'current' && snapshot !== null;
    const items = snapshot?.items ?? [];
    const branches = snapshot?.branches ?? [];
    const cards = new Map<string, DirectorProjectCard>();
    const relations = snapshot ? directorProjectRelations(snapshot) : {projectForBranch:new Map<string,string>(),roots:new Map<string,string>(),leadKeys:new Set<string>(),proven:new Set<string>()};
    const { projectForBranch } = relations;
    const projectKey = (value: { threadId: string; branchId: string }) => projectForBranch.get(branchKey(value)) ?? branchKey(value);
    for (const branch of branches) {
      const pending = items.filter(item => projectKey(item) === branchKey(branch) || branchKey(item) === branchKey(branch));
      const childWork = branches.some(child => branchKey(child) !== branchKey(branch) && projectKey(child) === branchKey(branch) && active(child));
      const status: DirectorProjectCard['status'] = !current ? 'unknown' : pending.some(item => item.actionable) ? 'needs-user'
        : pending.some(item => item.kind === 'effect_unknown') ? 'uncertain'
          : hasQueuedRuns(branch) || branch.currentRun && !ended(branch.currentRun.state) ? 'active' : branch.hasUnsettledWork || childWork ? 'settling'
            : branch.latestRun && ended(branch.latestRun.state) ? 'result' : 'available';
      const key = branchKey(branch);
      cards.set(key, { key, identity: identity(branch), title: branch.title, botId: branch.botId,
        lead: { role: relations.leadKeys.has(key) ? 'project-lead' : relations.proven.has(key) && !relations.roots.has(key) ? 'child-agent' : 'task', identity: branch.threadId, avatar: agentAvatarForIdentity(branch.threadId, branch.avatar),
          runId: branch.activeRunId, state: branch.currentRun?.state ?? null }, status,
        attentionKeys: pending.map(item => item.key), children: relations.proven.has(key) && !relations.roots.has(key) ? directorChildMembers((snapshot?.teamExecutions ?? []).filter(row => relations.proven.has(branchKey({threadId:row.childThreadId,branchId:row.childBranchId})) && projectKey({threadId:row.childThreadId,branchId:row.childBranchId}) === projectKey(branch)), identity(branch)) : [], relation: relations.leadKeys.has(key) ? 'project-task' : relations.proven.has(key) && !relations.roots.has(key) ? 'child-task' : 'unclassified-task' });
    }
    const inspection = inspected ? cards.get(branchKey(inspected)) ?? null : null;
    // Without exact parent-branch/execution facts, never attach a child to a guessed project branch.
    const portfolio = branches.filter(branch => !relations.roots.has(branchKey(branch)) && projectKey(branch) === branchKey(branch) && (relations.leadKeys.has(branchKey(branch)) || !branch.parentThreadId
      || cards.get(branchKey(branch))!.attentionKeys.length > 0 || active(branch)));
    const candidates = new Set(portfolio.map(branchKey));
    // Child inspection stays a detail lens, not a second independent project card.
    this.order = this.order.filter(key => candidates.has(key));
    for (const key of candidates) if (!this.order.includes(key)) this.order.push(key);
    const needsUser = items.filter(item => item.actionable || item.kind === 'effect_unknown'
      || ['run_failed', 'preparation_failed', 'mcp_error'].includes(item.kind));
    const attentionBranches = new Set(needsUser.map(projectKey));
    if (!this.attentionSubject || !attentionBranches.has(this.attentionSubject)) this.attentionSubject = needsUser[0] ? projectKey(needsUser[0]) : null;

    const newEdges: DirectorEdge[] = [];
    const runs = new Map<string, string>();
    for (const branch of branches) for (const run of [branch.currentRun, branch.latestRun]) {
      if (!run) continue;
      const runKey = JSON.stringify([branch.threadId, branch.branchId, run.id]);
      if (runs.has(runKey)) continue;
      runs.set(runKey, run.state);
      const previous = this.previousRuns.get(runKey);
      // A new exact Bot-root Run is an incoming instruction, not a delegated task.
      // A newly verified root, reconnect or hidden period must not replay old intake.
      const rootRevision = relations.roots.get(branchKey(branch));
      if (current && this.initialized && isCoordinating(route) && rootRevision
        && this.previousRoots.get(branchKey(branch)) === rootRevision
        && this.previousCursor !== null && snapshot!.eventCursor > this.previousCursor
        && this.previousActiveRuns.get(branchKey(branch)) !== run.id && run === branch.currentRun && branch.activeRunId === run.id
        && !ended(run.state) && !run.cancelRequested && !branch.archived && !branch.deleted) {
        newEdges.push({ key: JSON.stringify([snapshot!.epoch, runKey, 'receive-work']), kind: 'receive-work',
          project: identity(branch), runId: run.id, rootProfileRevision: rootRevision, outcome: null, workRemains: true });
      }

      // Only top-level task Runs drive the manager's intake/result beat, never every child/tool.
      if (current && this.initialized && !relations.roots.has(branchKey(branch)) && projectKey(branch) === branchKey(branch)) {
        const kind = ended(run.state) && previous && !ended(previous) ? 'receive-result'
          : null;
        if (kind) newEdges.push({ key: JSON.stringify([snapshot!.epoch, runKey, kind]), kind, project: identity(branch), runId: run.id, outcome: kind === 'receive-result' ? run.state as 'completed' | 'failed' | 'cancelled' : null, workRemains: active(branch) });
      }
    }
    if (current && this.initialized && this.previousCursor !== null && snapshot!.eventCursor >= this.previousCursor) {
      for (const delegation of snapshot!.delegations ?? []) {
        const rootKey = branchKey({threadId:delegation.parentThreadId,branchId:delegation.parentBranchId});
        const childKey = branchKey({threadId:delegation.childThreadId,branchId:delegation.childBranchId});
        const child = branches.find(branch => branchKey(branch) === childKey);
        const cursor = delegation.acceptedCursor;
        const execution = snapshot!.teamExecutions.find(row => row.childOperationId === delegation.operationId);
        const rootRevision = relations.roots.get(rootKey);
        if (!rootRevision || this.previousRoots.get(rootKey) !== rootRevision || !relations.leadKeys.has(childKey)
          || cursor === null || cursor <= this.previousCursor || cursor > snapshot!.eventCursor || !child
          || !isCoordinating(directorProjectRoute(route, child.botId))
          || execution && ended(execution.state) || child.currentRun?.cancelRequested || ended((child.currentRun ?? child.latestRun)?.state ?? '')) continue;
        newEdges.push({key:JSON.stringify([snapshot!.epoch,delegation.operationId,cursor,'dispatch-work']),kind:'dispatch-work',
          project:identity(child),runId:child.currentRun?.id ?? null,dispatchOperationId:delegation.operationId,outcome:null,workRemains:true});
      }
    }
    if (current && this.initialized && this.previousCursor !== null && snapshot!.eventCursor >= this.previousCursor) {
      for (const report of snapshot!.deliveredReports ?? []) {
        const rootKey = branchKey({threadId:report.parentThreadId,branchId:report.parentBranchId});
        const childKey = branchKey({threadId:report.childThreadId,branchId:report.childBranchId});
        const rootRevision = relations.roots.get(rootKey);
        const root = branches.find(branch => branchKey(branch) === rootKey);
        const child = branches.find(branch => branchKey(branch) === childKey);
        const delegation = snapshot!.delegations?.find(row => row.operationId === report.childOperationId
          && row.parentThreadId === report.parentThreadId && row.parentBranchId === report.parentBranchId && row.parentRunId === report.parentRunId
          && row.childThreadId === report.childThreadId && row.childBranchId === report.childBranchId);
        if (!rootRevision || this.previousRoots.get(rootKey) !== rootRevision || !isCoordinating(route)
          || !root || root.currentRun?.id !== report.receivingRunId || root.activeRunId !== report.receivingRunId
          || root.currentRun.cancelRequested || ended(root.currentRun.state) || root.archived || root.deleted
          || !child || !relations.leadKeys.has(childKey) || !delegation || !Number.isSafeInteger(report.deliveredCursor)
          || report.deliveredCursor <= this.previousCursor || report.deliveredCursor > snapshot!.eventCursor) continue;
        newEdges.push({key:JSON.stringify([snapshot!.epoch,report.executionId,report.deliveredCursor,'receive-report']),kind:'receive-report',
          project:identity(child),runId:null,receiptOperationId:report.childOperationId,receiptCursor:report.deliveredCursor,
          reportExecutionId:report.executionId,receivingRunId:report.receivingRunId,rootProfileRevision:rootRevision,outcome:null,workRemains:active(child)});
      }
      // A per-executor receipt must not interrupt another live work loop or announce whole-task completion.
      for (const stop of branches.some(branch => branch.currentRun && ['generating','executing'].includes(branch.currentRun.state)) ? [] : snapshot!.stoppedExecutors ?? []) {
        const branch = branches.find(value => branchKey(value) === branchKey(stop));
        if (!branch || !relations.proven.has(branchKey(branch)) || !Number.isSafeInteger(stop.stoppedCursor)
          || stop.stoppedCursor <= this.previousCursor || stop.stoppedCursor > snapshot!.eventCursor) continue;
        const owned = route === 'coordination-review' || route === 'agent-companion' && branch.botId === null
          || route === 'bot-coordinator' && !!branch.botId;
        if (!owned) continue;
        newEdges.push({key:JSON.stringify([snapshot!.epoch,stop.operationId,stop.stoppedCursor,'executor-stopped']),kind:'executor-stopped',
          project:identity(branch),runId:stop.runId,receiptOperationId:stop.operationId,receiptCursor:stop.stoppedCursor,
          outcome:null,workRemains:active(branch)});
      }
    }
    if (!current || !options.visible || options.interacting) {
      this.edge = null; this.initialized = false;
    } else {
      if (needsUser.length) this.edge = null;
      else if (newEdges.length) this.edge = newEdges.find(edge => edge.kind === 'receive-report') ?? newEdges.find(edge => edge.kind === 'dispatch-work') ?? newEdges.find(edge => edge.kind === 'executor-stopped') ?? newEdges[0]!; // One replaceable beat, never a backlog.
      if (this.edge) {
        const card = cards.get(branchKey(this.edge.project));
        const branch = branches.find(value => branchKey(value) === branchKey(this.edge!.project));
        const relevant = branch && [branch.currentRun, branch.latestRun].some(run => run?.id === this.edge!.runId);
        if (!card || !branch) this.edge = null;
        else if (this.edge.kind === 'dispatch-work') {
          const delegation = snapshot?.delegations?.find(row => row.operationId === this.edge!.dispatchOperationId);
          const execution = snapshot?.teamExecutions.find(row => row.childOperationId === this.edge!.dispatchOperationId);
          if (!delegation || execution && ended(execution.state) || !relations.leadKeys.has(branchKey(branch)) || !isCoordinating(directorProjectRoute(route, card.botId))
            || branch.currentRun?.cancelRequested || ended((branch.currentRun ?? branch.latestRun)?.state ?? '')) this.edge = null;
        } else if (this.edge.kind === 'receive-report') {
          const report = snapshot!.deliveredReports?.find(row => row.childOperationId === this.edge!.receiptOperationId
            && row.executionId === this.edge!.reportExecutionId && row.deliveredCursor === this.edge!.receiptCursor);
          const root = report && branches.find(value => value.threadId === report.parentThreadId && value.branchId === report.parentBranchId);
          if (!report || !root || root.activeRunId !== this.edge.receivingRunId || root.currentRun?.id !== this.edge.receivingRunId
            || root.currentRun.cancelRequested || ended(root.currentRun.state) || root.archived || root.deleted || !isCoordinating(route) || !relations.leadKeys.has(branchKey(branch))
            || relations.roots.get(branchKey({threadId:report.parentThreadId,branchId:report.parentBranchId})) !== this.edge.rootProfileRevision) this.edge = null;
        } else if (this.edge.kind === 'executor-stopped') {
          if (branches.some(value => value.currentRun && ['generating','executing'].includes(value.currentRun.state))
            || branch.currentRun && branch.currentRun.id !== this.edge.runId && !ended(branch.currentRun.state)
            || !snapshot!.stoppedExecutors?.some(row => row.operationId === this.edge!.receiptOperationId
            && row.stoppedCursor === this.edge!.receiptCursor && row.runId === this.edge!.runId
            && branchKey(row) === branchKey(branch)) || !relations.proven.has(branchKey(branch))) this.edge = null;
        } else if (this.edge.kind === 'receive-work') {
          if (!this.edge.rootProfileRevision || relations.roots.get(branchKey(branch)) !== this.edge.rootProfileRevision
            || !isCoordinating(route) || branch.activeRunId !== this.edge.runId || branch.currentRun?.id !== this.edge.runId
            || branch.currentRun.cancelRequested || ended(branch.currentRun.state) || branch.archived || branch.deleted) this.edge = null;
        } else if (!relevant || branch.currentRun && !ended(branch.currentRun.state)) this.edge = null;
      }
      this.initialized = true;
    }
    this.previousRuns = current ? runs : new Map();
    this.previousActiveRuns = current && options.visible && !options.interacting ? new Map(branches.map(branch => [branchKey(branch), branch.activeRunId])) : new Map();
    this.previousCursor = current && options.visible && !options.interacting ? snapshot!.eventCursor : null;
    this.previousRoots = current && options.visible && !options.interacting ? new Map(relations.roots) : new Map();
    // Only observed execution is a working pose. Unsettled effects, preparation,
    // scheduling and waits are not execution; role/ancestry cannot be guessed.
    const retryActive = (branch: ThreadAttentionBranch) => {
      const run = branch.currentRun, retry = run?.retry;
      return !!run && branch.activeRunId === run.id && !run.cancelRequested && ['generating','waiting'].includes(run.state)
        && !!retry && typeof retry.requestId === 'string' && retry.requestId.length > 0 && Number.isSafeInteger(retry.attempt) && retry.attempt > 0
        && Number.isSafeInteger(retry.revision) && retry.revision > 0 && retry.revision <= snapshot!.eventCursor
        && Number.isSafeInteger(retry.scheduledAtMs) && retry.scheduledAtMs >= 0 && Number.isSafeInteger(retry.retryAtMs) && retry.retryAtMs >= retry.scheduledAtMs;
    };
    const workActive = current && options.visible && !options.interacting
      && needsUser.length === 0 && !items.some(item => item.kind === 'cancelling')
      && snapshot!.counts.actionRequired === 0 && snapshot!.counts.unknownEffects === 0
      && branches.some(branch => {
        const run = branch.currentRun, key = branchKey(branch);
        if (!run || branch.activeRunId !== run.id || run.cancelRequested || branch.archived || branch.deleted
          || !['generating', 'executing'].includes(run.state) || retryActive(branch) || !relations.proven.has(key)) return false;
        return route === 'coordination-review' || route === 'agent-companion' && branch.botId === null
          || route === 'bot-coordinator' && typeof branch.botId === 'string' && branch.botId.length > 0;
      });
    // Preparation is only a readiness gesture, not proof of sorting files or producing an artifact.
    const activityAllowed = current && options.visible && !options.interacting && needsUser.length === 0
      && !items.some(item => item.kind === 'cancelling') && snapshot!.counts.actionRequired === 0 && snapshot!.counts.unknownEffects === 0;
    const retryingBranch = activityAllowed && !workActive ? branches.find(branch => relations.proven.has(branchKey(branch))
      && !branch.archived && !branch.deleted && retryActive(branch)
      && (route === 'coordination-review' || route === 'agent-companion' && branch.botId === null || route === 'bot-coordinator' && !!branch.botId)) : undefined;
    const queuedBranch = activityAllowed && !workActive ? branches.find(branch => relations.proven.has(branchKey(branch))
      && !branch.archived && !branch.deleted && hasQueuedRuns(branch)
      && (route === 'coordination-review' || route === 'agent-companion' && branch.botId === null || route === 'bot-coordinator' && !!branch.botId)) : undefined;
    const thinkingRoot = activityAllowed && isCoordinating(route) ? branches.find(branch => {
      const run = branch.currentRun, generation = run?.generation;
      return relations.roots.has(branchKey(branch)) && !branch.archived && !branch.deleted
        && run?.id === branch.activeRunId && !run?.cancelRequested && run?.state === 'generating' && !retryActive(branch)
        && generation?.phase === 'reasoning' && typeof generation.requestId === 'string' && generation.requestId.length > 0
        && Number.isSafeInteger(generation.revision) && generation.revision > 0 && generation.revision <= snapshot!.eventCursor;
    }) : undefined;
    const preparedRoot = activityAllowed && isCoordinating(route) ? branches.find(branch => relations.roots.has(branchKey(branch))
      && !branch.archived && !branch.deleted && branch.currentRun?.id === branch.activeRunId && !branch.currentRun?.cancelRequested
      && ['preparing', 'runnable'].includes(branch.currentRun?.state ?? '')) : undefined;
    const waitingBranch = activityAllowed && !workActive ? branches.find(branch => relations.proven.has(branchKey(branch))
      && !branch.archived && !branch.deleted && branch.currentRun?.id === branch.activeRunId && !branch.currentRun?.cancelRequested
      && branch.currentRun?.state === 'waiting' && (route === 'coordination-review'
        || route === 'agent-companion' && branch.botId === null || route === 'bot-coordinator' && !!branch.botId)) : undefined;
    const activityBranch = retryingBranch ?? thinkingRoot ?? preparedRoot ?? queuedBranch ?? waitingBranch;
    const activityKind = activityBranch === retryingBranch ? 'retry' as const : activityBranch === thinkingRoot ? 'thinking' as const
      : activityBranch === preparedRoot ? 'preparing' as const : activityBranch === queuedBranch ? 'queued' as const : 'waiting' as const;
    const activity = activityBranch ? { kind: activityKind,
      key: JSON.stringify([snapshot!.epoch, activityBranch.threadId, activityBranch.branchId,
        activityKind === 'queued' && hasQueuedRuns(activityBranch) ? 'queued-runs' : activityBranch.currentRun?.id,
        activityKind, activityKind === 'retry' ? [activityBranch.currentRun?.retry?.requestId, activityBranch.currentRun?.retry?.attempt, activityBranch.currentRun?.retry?.revision]
          : activityKind === 'thinking' ? [activityBranch.currentRun?.generation?.requestId, activityBranch.currentRun?.generation?.phase, activityBranch.currentRun?.generation?.revision] : null]),
      subject: identity(activityBranch) } : undefined;
    const workingProjects = portfolio.filter(branch => active(branch) || branches.some(child => projectKey(child) === branchKey(branch) && active(child)));
    const subject = needsUser.length ? this.attentionSubject && cards.get(this.attentionSubject)?.identity : this.edge?.project;
    const attentionItem = needsUser.find(item => projectKey(item) === this.attentionSubject) ?? null;
    const subjectCard = subject ? cards.get(branchKey(subject)) : undefined;
    let subjectRoute = subjectCard && relations.proven.has(subjectCard.key) && !relations.roots.has(subjectCard.key) ? directorProjectRoute(route, subjectCard.botId) : 'unknown' as DirectorInteractionRoute;
    if (this.edge?.kind === 'receive-work' && this.edge.rootProfileRevision && isCoordinating(route)) subjectRoute = route;
    // A nested request retains its exact owner; incomplete/conflicting ownership never borrows the root's authority.
    if (subjectRoute === 'bot-coordinator' && attentionItem
      && cards.get(branchKey(attentionItem))?.botId !== subjectCard?.botId) subjectRoute = 'unknown';
    const inspectionRoute = inspection && relations.proven.has(inspection.key) && !relations.roots.has(inspection.key) ? directorProjectRoute(route, inspection.botId) : 'unknown';
    const verb: DirectorVerb = !current ? health === 'unknown' ? 'unavailable' : 'synchronizing'
      : needsUser.length ? isCoordinating(subjectRoute) ? 'present-attention' : 'notify-attention'
        : this.edge ? this.edge.kind === 'executor-stopped' ? 'executor-stopped' : isCoordinating(subjectRoute) ? this.edge.kind : 'notify-result'
          : branches.some(active) ? 'review-portfolio' : 'available';
    const selected: string[] = [];
    const take = (key: string | null | undefined) => { if (key && candidates.has(key) && !selected.includes(key)) selected.push(key); };
    // Selection is an inspection lens; it changes card visibility, not the director's body verb.
    take(this.attentionSubject); take(this.edge ? branchKey(this.edge.project) : null);
    take(inspected ? projectKey(inspected) : null);
    for (const key of this.order) if (cards.get(key)?.status === 'active' || cards.get(key)?.status === 'settling') take(key);
    for (const key of this.order) take(key);
    const capacity = Number.isFinite(options.cardCapacity) ? Math.max(1, Math.floor(options.cardCapacity)) : 3;
    const visible = selected.slice(0, capacity).map(key => cards.get(key)!);
    return { interactionRoute: route, inspectionRoute, source: snapshot ? { epoch: snapshot.epoch, eventCursor: snapshot.eventCursor } : null, health, body: { workActive, ...(activity ? { activity } : {}), subjectRoute, verb, subject: subject || null, attentionOwner: attentionItem ? identity(attentionItem) : null,
      attentionMode: needsUser.length > 1 ? 'multiple' : needsUser.length ? 'single' : null, attentionItem, edge: this.edge }, cards: visible, overflowCards: Math.max(0, candidates.size - visible.length), inspectedProjectKey: inspected ? projectKey(inspected) : null, inspection,
      counts: current ? { actionRequired: snapshot!.counts.actionRequired, uncertain: snapshot!.counts.unknownEffects,
        activeProjectTasks: workingProjects.filter(branch => relations.leadKeys.has(branchKey(branch))).length } : null,
      coverage: snapshot?.coverage ?? null };
  }
}
