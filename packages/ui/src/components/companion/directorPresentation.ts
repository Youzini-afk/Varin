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
  lead: { role: 'project-lead' | 'child-agent'; identity: string; avatar: AgentAvatarId; runId: string | null; state: string | null };
  status: 'needs-user' | 'uncertain' | 'active' | 'settling' | 'result' | 'available' | 'unknown';
  attentionKeys: string[];
  children: DirectorChildMember[];
  relation: 'project-task' | 'child-task';
}
export type DirectorInteractionRoute = 'bot-coordinator' | 'agent-companion' | 'unknown' | 'coordination-review';
export type DirectorVerb = 'synchronizing' | 'unavailable' | 'review-portfolio' | 'available'
  | 'present-attention' | 'receive-work' | 'receive-result' | 'notify-attention' | 'notify-result';
export interface DirectorEdge {
  key: string;
  kind: 'receive-work' | 'receive-result';
  project: ThreadIdentity;
  runId: string;
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
  body: { subjectRoute: DirectorInteractionRoute; verb: DirectorVerb; subject: ThreadIdentity | null; attentionOwner: ThreadIdentity | null; attentionMode: 'single' | 'multiple' | null; attentionItem: ThreadAttentionItem | null; edge: DirectorEdge | null };
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
const active = (branch: ThreadAttentionBranch) => branch.hasUnsettledWork || !!(branch.currentRun && !ended(branch.currentRun.state));

/** Prototype: manager body + stable project cards; inspection NEVER makes the body a tool executor.
 * It consumes compact authoritative metadata only. It does not schedule, approve or create reports.
 */
export class CompanionDirector {
  private epoch: number | null = null;
  private route: DirectorInteractionRoute = 'unknown';
  private order: string[] = [];
  private previousRuns = new Map<string, string>();
  private initialized = false;
  private edge: DirectorEdge | null = null;
  private attentionSubject: string | null = null;

  discardTransient(): void { this.edge = null; this.initialized = false; this.previousRuns.clear(); }
  consumeEdge(key: string): void { if (this.edge?.key === key) this.edge = null; }

  observe(snapshot: ThreadAttentionSnapshot | null, health: 'current' | 'unknown' | 'synchronizing',
    inspected: ThreadIdentity | null, options: { visible: boolean; interacting: boolean; cardCapacity: number; interactionRoute?: DirectorInteractionRoute }): DirectorPresentation {
    const route = options.interactionRoute ?? 'unknown';
    if (snapshot?.epoch !== this.epoch || route !== this.route) {
      this.route = route;
      this.epoch = snapshot?.epoch ?? null; this.order = []; this.previousRuns.clear();
      this.initialized = false; this.edge = null; this.attentionSubject = null;
    }
    const current = health === 'current' && snapshot !== null;
    const items = snapshot?.items ?? [];
    const branches = snapshot?.branches ?? [];
    const cards = new Map<string, DirectorProjectCard>();
    const projectForBranch = snapshot ? directorProjectRelations(snapshot).projectForBranch : new Map<string, string>();
    const projectKey = (value: { threadId: string; branchId: string }) => projectForBranch.get(branchKey(value)) ?? branchKey(value);
    for (const branch of branches) {
      const pending = items.filter(item => projectKey(item) === branchKey(branch) || branchKey(item) === branchKey(branch));
      const childWork = branches.some(child => branchKey(child) !== branchKey(branch) && projectKey(child) === branchKey(branch) && active(child));
      const status: DirectorProjectCard['status'] = !current ? 'unknown' : pending.some(item => item.actionable) ? 'needs-user'
        : pending.some(item => item.kind === 'effect_unknown') ? 'uncertain'
          : branch.currentRun && !ended(branch.currentRun.state) ? 'active' : branch.hasUnsettledWork || childWork ? 'settling'
            : branch.latestRun && ended(branch.latestRun.state) ? 'result' : 'available';
      const key = branchKey(branch);
      cards.set(key, { key, identity: identity(branch), title: branch.title, botId: branch.botId,
        lead: { role: branch.parentThreadId ? 'child-agent' : 'project-lead', identity: branch.threadId, avatar: agentAvatarForIdentity(branch.threadId, branch.avatar),
          runId: branch.activeRunId, state: branch.currentRun?.state ?? null }, status,
        attentionKeys: pending.map(item => item.key), children: directorChildMembers(snapshot?.teamExecutions ?? [], identity(branch)), relation: branch.parentThreadId ? 'child-task' : 'project-task' });
    }
    const inspection = inspected ? cards.get(branchKey(inspected)) ?? null : null;
    // Without exact parent-branch/execution facts, never attach a child to a guessed project branch.
    const portfolio = branches.filter(branch => projectKey(branch) === branchKey(branch) && (!branch.parentThreadId
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
      // Only top-level task Runs drive the manager's intake/result beat, never every child/tool.
      if (current && this.initialized && !branch.parentThreadId) {
        const kind = ended(run.state) && previous && !ended(previous) ? 'receive-result'
          : isCoordinating(directorProjectRoute(route, branch.botId)) && previous === undefined && ['accepted', 'preparing', 'runnable'].includes(run.state) ? 'receive-work' : null;
        if (kind) newEdges.push({ key: JSON.stringify([snapshot!.epoch, runKey, kind]), kind, project: identity(branch), runId: run.id, outcome: kind === 'receive-result' ? run.state as 'completed' | 'failed' | 'cancelled' : null, workRemains: active(branch) });
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
        const edgeRun = branch && [branch.currentRun, branch.latestRun].find(run => run?.id === this.edge!.runId);
        if (!card || !relevant || (this.edge.kind === 'receive-work' && !isCoordinating(directorProjectRoute(route, card.botId)))
          || (this.edge.kind === 'receive-result' && branch?.currentRun && !ended(branch.currentRun.state))
          || (this.edge.kind === 'receive-work' && edgeRun && !['accepted', 'preparing', 'runnable'].includes(edgeRun.state))) this.edge = null;
      }
      this.initialized = true;
    }
    this.previousRuns = current ? runs : new Map();
    const workingProjects = portfolio.filter(branch => active(branch) || branches.some(child => projectKey(child) === branchKey(branch) && active(child)));
    const subject = needsUser.length ? this.attentionSubject && cards.get(this.attentionSubject)?.identity : this.edge?.project;
    const attentionItem = needsUser.find(item => projectKey(item) === this.attentionSubject) ?? null;
    const subjectCard = subject ? cards.get(branchKey(subject)) : undefined;
    let subjectRoute = subjectCard ? directorProjectRoute(route, subjectCard.botId) : 'unknown' as DirectorInteractionRoute;
    // A nested request retains its exact owner; incomplete/conflicting ownership never borrows the root's authority.
    if (subjectRoute === 'bot-coordinator' && attentionItem
      && cards.get(branchKey(attentionItem))?.botId !== subjectCard?.botId) subjectRoute = 'unknown';
    const inspectionRoute = inspection ? directorProjectRoute(route, inspection.botId) : 'unknown';
    const verb: DirectorVerb = !current ? health === 'unknown' ? 'unavailable' : 'synchronizing'
      : needsUser.length ? isCoordinating(subjectRoute) ? 'present-attention' : 'notify-attention'
        : this.edge ? isCoordinating(subjectRoute) ? this.edge.kind : 'notify-result'
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
    return { interactionRoute: route, inspectionRoute, source: snapshot ? { epoch: snapshot.epoch, eventCursor: snapshot.eventCursor } : null, health, body: { subjectRoute, verb, subject: subject || null, attentionOwner: attentionItem ? identity(attentionItem) : null,
      attentionMode: needsUser.length > 1 ? 'multiple' : needsUser.length ? 'single' : null, attentionItem, edge: this.edge }, cards: visible, overflowCards: Math.max(0, candidates.size - visible.length), inspectedProjectKey: inspected ? projectKey(inspected) : null, inspection,
      counts: current ? { actionRequired: snapshot!.counts.actionRequired, uncertain: snapshot!.counts.unknownEffects,
        activeProjectTasks: workingProjects.filter(branch => !branch.parentThreadId).length } : null,
      coverage: snapshot?.coverage ?? null };
  }
}
