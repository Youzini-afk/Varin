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
  /** followed-task: an ordinary task the associated Bot follows. Following is not dispatch. */
  relation: 'project-task' | 'child-task' | 'followed-task' | 'unclassified-task';
}
export type DirectorInteractionRoute = 'bot-coordinator' | 'agent-companion' | 'unknown' | 'coordination-review';
export type DirectorVerb = 'synchronizing' | 'unavailable' | 'review-portfolio' | 'available'
  | 'present-attention' | 'receive-work' | 'receive-result' | 'present-reply' | 'notify-attention' | 'notify-result';
export interface DirectorEdge {
  key: string;
  /** receive-work: the associated Bot dispatched (or asked again) one of its leads.
   * receive-result: an ordinary task's own Run ended. present-reply: a session of the
   * associated Bot ended its round with output the user can read. A dispatched Agent's
   * Run ending or its report returning is none of these: the Bot has not replied yet. */
  kind: 'receive-work' | 'receive-result' | 'present-reply';
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
  body: { /** Expressive work, never evidence of keyboard/tool execution. */ workActive?: boolean; subjectRoute: DirectorInteractionRoute; verb: DirectorVerb; subject: ThreadIdentity | null; attentionOwner: ThreadIdentity | null; attentionMode: 'single' | 'multiple' | null; attentionItem: ThreadAttentionItem | null; edge: DirectorEdge | null };
  cards: DirectorProjectCard[];
  /** Additional factual cards, not a count of independent business Projects. */
  overflowCards: number;
  inspectedProjectKey: string | null;
  inspection: DirectorProjectCard | null;
  counts: { actionRequired: number; uncertain: number; activeProjectTasks: number } | null;
  coverage: ThreadAttentionSnapshot['coverage'] | null;
}
export interface DirectorObserveOptions {
  visible: boolean; interacting: boolean; cardCapacity: number;
  interactionRoute?: DirectorInteractionRoute;
  /** The Bot the companion speaks for; required for bot-coordinator. */
  botId?: string | null;
}
/** The companion's chosen identity and task ownership are independent. Only work owned by the
 * associated Bot coordinates; unbound and other Bots' work stays a neutral notice. */
export function directorProjectRoute(route: DirectorInteractionRoute, botId: string | null | undefined, associated: string | null | undefined): DirectorInteractionRoute {
  if (route === 'coordination-review') return route;
  if (route === 'agent-companion') return route;
  return route === 'bot-coordinator' && typeof botId === 'string' && botId.length > 0 && botId === associated ? 'bot-coordinator' : 'unknown';
}
const isCoordinating = (route: DirectorInteractionRoute) => route === 'bot-coordinator' || route === 'coordination-review';
const ended = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
const branchKey = (branch: { threadId: string; branchId: string }) => JSON.stringify([branch.threadId, branch.branchId]);
const identity = (branch: { threadId: string; branchId: string }): ThreadIdentity => ({ runtime: 'agent', threadId: branch.threadId, branchId: branch.branchId });
const active = (branch: ThreadAttentionBranch) => branch.hasUnsettledWork || !!(branch.currentRun && !ended(branch.currentRun.state));

/** Prototype: manager body + stable project cards; inspection NEVER makes the body a tool executor.
 * It consumes compact authoritative metadata only. It does not schedule, approve or create reports.
 */
export class CompanionDirector {
  private epoch: number | null = null;
  private route: DirectorInteractionRoute = 'unknown';
  private associated: string | null = null;
  private order: string[] = [];
  private previousRuns = new Map<string, string>();
  private initialized = false;
  private previousCursor: number | null = null;
  private previousRoots = new Map<string,string>();
  private edge: DirectorEdge | null = null;
  private attentionSubject: string | null = null;

  discardTransient(): void { this.edge = null; this.initialized = false; this.previousRuns.clear(); this.previousCursor = null; this.previousRoots.clear(); }
  consumeEdge(key: string): void { if (this.edge?.key === key) this.edge = null; }

  observe(snapshot: ThreadAttentionSnapshot | null, health: 'current' | 'unknown' | 'synchronizing',
    inspected: ThreadIdentity | null, options: DirectorObserveOptions): DirectorPresentation {
    const requested = options.interactionRoute ?? 'unknown';
    // Coordination speaks for one explicit Bot; without one it cannot be presumed.
    const route = requested === 'bot-coordinator' && !options.botId ? 'unknown' : requested;
    const associated = route === 'bot-coordinator' ? options.botId ?? null : null;
    if (snapshot?.epoch !== this.epoch || route !== this.route || associated !== this.associated) {
      this.route = route; this.associated = associated;
      this.epoch = snapshot?.epoch ?? null; this.order = []; this.previousRuns.clear();
      this.initialized = false; this.edge = null; this.attentionSubject = null; this.previousCursor = null; this.previousRoots.clear();
    }
    const current = health === 'current' && snapshot !== null;
    const items = snapshot?.items ?? [];
    const branches = snapshot?.branches ?? [];
    const cards = new Map<string, DirectorProjectCard>();
    const relations = snapshot ? directorProjectRelations(snapshot) : {projectForBranch:new Map<string,string>(),roots:new Map<string,string>(),leadKeys:new Set<string>(),proven:new Set<string>()};
    const { projectForBranch } = relations;
    const projectKey = (value: { threadId: string; branchId: string }) => projectForBranch.get(branchKey(value)) ?? branchKey(value);
    const projectRoute = (botId: string | null | undefined) => directorProjectRoute(route, botId, associated);
    // Explicit follows of the associated Bot, from the same Catalog cut as ownership.
    const followed = new Set((snapshot?.follows ?? []).filter(row => associated !== null && row.botId === associated).map(projectKey));
    const owned = (branch: ThreadAttentionBranch) => associated !== null && branch.botId === associated;
    for (const branch of branches) {
      const pending = items.filter(item => projectKey(item) === branchKey(branch) || branchKey(item) === branchKey(branch));
      const childWork = branches.some(child => branchKey(child) !== branchKey(branch) && projectKey(child) === branchKey(branch) && active(child));
      const status: DirectorProjectCard['status'] = !current ? 'unknown' : pending.some(item => item.actionable) ? 'needs-user'
        : pending.some(item => item.kind === 'effect_unknown') ? 'uncertain'
          : branch.currentRun && !ended(branch.currentRun.state) ? 'active' : branch.hasUnsettledWork || childWork ? 'settling'
            : branch.latestRun && ended(branch.latestRun.state) ? 'result' : 'available';
      const key = branchKey(branch);
      cards.set(key, { key, identity: identity(branch), title: branch.title, botId: branch.botId,
        lead: { role: relations.leadKeys.has(key) ? 'project-lead' : relations.proven.has(key) && !relations.roots.has(key) ? 'child-agent' : 'task', identity: branch.threadId, avatar: agentAvatarForIdentity(branch.threadId, branch.avatar),
          runId: branch.activeRunId, state: branch.currentRun?.state ?? null }, status,
        attentionKeys: pending.map(item => item.key), children: relations.proven.has(key) && !relations.roots.has(key) ? directorChildMembers((snapshot?.teamExecutions ?? []).filter(row => relations.proven.has(branchKey({threadId:row.childThreadId,branchId:row.childBranchId})) && projectKey({threadId:row.childThreadId,branchId:row.childBranchId}) === projectKey(branch)), identity(branch)) : [], relation: followed.has(key) && !owned(branch) && projectKey(branch) === key ? 'followed-task' : relations.leadKeys.has(key) ? 'project-task' : relations.proven.has(key) && !relations.roots.has(key) ? 'child-task' : 'unclassified-task' });
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
      if (!current || !this.initialized || !ended(run.state) || !previous || ended(previous)) continue;
      // The associated Bot's own session replied publicly. A quiet round ends without readable
      // output and stays quiet; a failure is presented through its own attention item.
      if (relations.roots.has(branchKey(branch))) {
        if ((route === 'coordination-review' || owned(branch)) && run.state === 'completed' && run.id === branch.latestRun?.id && branch.latestRun.visibleOutput === true)
          newEdges.push({ key: JSON.stringify([snapshot!.epoch, runKey, 'present-reply']), kind: 'present-reply', project: identity(branch), runId: run.id, outcome: 'completed', workRemains: active(branch) });
        continue;
      }
      // Only an ordinary top-level task's own Run end is a result beat. Bot-owned work reports
      // to its Bot first, and children/tools never drive the manager's body.
      if (branch.botId === null && projectKey(branch) === branchKey(branch))
        newEdges.push({ key: JSON.stringify([snapshot!.epoch, runKey, 'receive-result']), kind: 'receive-result', project: identity(branch), runId: run.id, outcome: run.state as 'completed' | 'failed' | 'cancelled', workRemains: active(branch) });
    }
    if (current && this.initialized && this.previousCursor !== null && snapshot!.eventCursor >= this.previousCursor) {
      const session = (threadId: string | null, botId: string | null) => threadId !== null && branches.some(value => value.threadId === threadId
        && value.botSessionThreadId === threadId && value.botId === botId);
      for (const delegation of snapshot!.delegations) {
        const rootKey = branchKey({threadId:delegation.parentThreadId,branchId:delegation.parentBranchId});
        const childKey = branchKey({threadId:delegation.childThreadId,branchId:delegation.childBranchId});
        const child = branches.find(branch => branchKey(branch) === childKey);
        const execution = snapshot!.teamExecutions.find(row => row.childOperationId === delegation.operationId);
        const rootRevision = relations.roots.get(rootKey);
        if (!rootRevision || this.previousRoots.get(rootKey) !== rootRevision || !relations.leadKeys.has(childKey) || !child
          || !isCoordinating(projectRoute(child.botId))
          || execution && ended(execution.state) || child.currentRun?.cancelRequested || ended((child.currentRun ?? child.latestRun)?.state ?? '')) continue;
        // The first dispatch, or the same Agent asked again by a session of the same Bot.
        // A user continuing it in the workbench is not the Bot handing it over.
        const fresh = (cursor: number | null) => cursor !== null && cursor > this.previousCursor! && cursor <= snapshot!.eventCursor;
        const cursor = fresh(delegation.continuedCursor) && session(delegation.continuedByThreadId, child.botId ?? null) ? delegation.continuedCursor
          : fresh(delegation.acceptedCursor) ? delegation.acceptedCursor : null;
        if (cursor === null) continue;
        newEdges.push({key:JSON.stringify([snapshot!.epoch,delegation.operationId,cursor,'receive-work']),kind:'receive-work',
          project:identity(child),runId:child.currentRun?.id ?? null,dispatchOperationId:delegation.operationId,outcome:null,workRemains:true});
      }
    }
    if (!current || !options.visible || options.interacting) {
      this.edge = null; this.initialized = false;
    } else {
      if (needsUser.length) this.edge = null;
      else if (newEdges.length) this.edge = newEdges[0]!; // One replaceable beat, never a backlog.
      if (this.edge) {
        const card = cards.get(branchKey(this.edge.project));
        const branch = branches.find(value => branchKey(value) === branchKey(this.edge!.project));
        const relevant = branch && [branch.currentRun, branch.latestRun].some(run => run?.id === this.edge!.runId);
        if (!card || !branch) this.edge = null;
        else if (this.edge.kind === 'receive-work') {
          const delegation = snapshot?.delegations.find(row => row.operationId === this.edge!.dispatchOperationId);
          const execution = snapshot?.teamExecutions.find(row => row.childOperationId === this.edge!.dispatchOperationId);
          if (!delegation || execution && ended(execution.state) || !relations.leadKeys.has(branchKey(branch)) || !isCoordinating(projectRoute(card.botId))
            || branch.currentRun?.cancelRequested || ended((branch.currentRun ?? branch.latestRun)?.state ?? '')) this.edge = null;
        } else if (!relevant || branch.currentRun && !ended(branch.currentRun.state)) this.edge = null;
      }
      this.initialized = true;
    }
    this.previousRuns = current ? runs : new Map();
    this.previousCursor = current && options.visible && !options.interacting ? snapshot!.eventCursor : null;
    this.previousRoots = current && options.visible && !options.interacting ? new Map(relations.roots) : new Map();
    // Only observed execution is a working pose. Unsettled effects, preparation,
    // scheduling and waits are not execution; role/ancestry cannot be guessed.
    // As a Bot she types only for her own session rounds; dispatched Agents work on their cards.
    const workActive = current && options.visible && !options.interacting
      && needsUser.length === 0 && !items.some(item => item.kind === 'cancelling')
      && snapshot!.counts.actionRequired === 0 && snapshot!.counts.unknownEffects === 0
      && branches.some(branch => {
        const run = branch.currentRun, key = branchKey(branch);
        if (!run || branch.activeRunId !== run.id || run.cancelRequested || branch.archived || branch.deleted
          || !['generating', 'executing'].includes(run.state)) return false;
        if (route === 'bot-coordinator') return owned(branch) && branch.botSessionThreadId === branch.threadId;
        return relations.proven.has(key) && (route === 'coordination-review' || route === 'agent-companion' && branch.botId === null);
      });
    const workingProjects = portfolio.filter(branch => active(branch) || branches.some(child => projectKey(child) === branchKey(branch) && active(child)));
    const subject = needsUser.length ? this.attentionSubject && cards.get(this.attentionSubject)?.identity : this.edge?.project;
    const attentionItem = needsUser.find(item => projectKey(item) === this.attentionSubject) ?? null;
    const subjectCard = subject ? cards.get(branchKey(subject)) : undefined;
    // The public reply belongs to the associated Bot's own session, checked when the beat was taken.
    let subjectRoute = !needsUser.length && this.edge?.kind === 'present-reply' ? route
      : subjectCard && relations.proven.has(subjectCard.key) && !relations.roots.has(subjectCard.key) ? projectRoute(subjectCard.botId) : 'unknown' as DirectorInteractionRoute;
    // A nested request retains its exact owner; incomplete/conflicting ownership never borrows the root's authority.
    if (subjectRoute === 'bot-coordinator' && attentionItem
      && cards.get(branchKey(attentionItem))?.botId !== subjectCard?.botId) subjectRoute = 'unknown';
    const inspectionRoute = inspection && relations.proven.has(inspection.key) && !relations.roots.has(inspection.key) ? projectRoute(inspection.botId) : 'unknown';
    const verb: DirectorVerb = !current ? health === 'unknown' ? 'unavailable' : 'synchronizing'
      : needsUser.length ? isCoordinating(subjectRoute) ? 'present-attention' : 'notify-attention'
        : this.edge ? isCoordinating(subjectRoute) ? this.edge.kind : 'notify-result'
          : branches.some(active) ? 'review-portfolio' : 'available';
    const selected: string[] = [];
    const take = (key: string | null | undefined) => { if (key && candidates.has(key) && !selected.includes(key)) selected.push(key); };
    // Selection is an inspection lens; it changes card visibility, not the director's body verb.
    take(this.attentionSubject); take(this.edge ? branchKey(this.edge.project) : null);
    take(inspected ? projectKey(inspected) : null);
    // As a Bot, its own and followed work come before unrelated tasks; order is otherwise stable.
    const related = (key: string) => route !== 'bot-coordinator' || followed.has(key) || cards.get(key)?.botId === associated;
    const working = (key: string) => cards.get(key)?.status === 'active' || cards.get(key)?.status === 'settling';
    for (const key of this.order) if (related(key) && working(key)) take(key);
    for (const key of this.order) if (working(key)) take(key);
    for (const key of this.order) if (related(key)) take(key);
    for (const key of this.order) take(key);
    const capacity = Number.isFinite(options.cardCapacity) ? Math.max(1, Math.floor(options.cardCapacity)) : 3;
    const visible = selected.slice(0, capacity).map(key => cards.get(key)!);
    return { interactionRoute: route, inspectionRoute, source: snapshot ? { epoch: snapshot.epoch, eventCursor: snapshot.eventCursor } : null, health, body: { workActive, subjectRoute, verb, subject: subject || null, attentionOwner: attentionItem ? identity(attentionItem) : null,
      attentionMode: needsUser.length > 1 ? 'multiple' : needsUser.length ? 'single' : null, attentionItem, edge: this.edge }, cards: visible, overflowCards: Math.max(0, candidates.size - visible.length), inspectedProjectKey: inspected ? projectKey(inspected) : null, inspection,
      counts: current ? { actionRequired: snapshot!.counts.actionRequired, uncertain: snapshot!.counts.unknownEffects,
        activeProjectTasks: workingProjects.filter(branch => relations.leadKeys.has(branchKey(branch))).length } : null,
      coverage: snapshot?.coverage ?? null };
  }
}
