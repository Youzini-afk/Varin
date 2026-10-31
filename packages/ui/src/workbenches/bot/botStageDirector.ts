import type { ThreadAttentionBranch, ThreadAttentionDelegation, ThreadAttentionRun, ThreadAttentionSnapshot, ThreadAttentionTeamExecution } from '@varin/application-client';
import { agentAvatarForIdentity, type AgentAvatarId } from '@varin/protocol';
import type { BotOwnPose } from './botPresentation';
import { botToolKind } from './botStageTools';

/**
 * The Bot stage's facts (docs/design/bot-ui.md §5.7): who of her team is on the ledge and what each
 * is doing, what her own round is doing, and the moments that just happened. Everything comes from
 * the Host's attention read (one Host-wide, content-free snapshot) plus the open conversation's live
 * tool calls. Moments come only from event cursors inside the window since the previous observation:
 * the first observation of a Bot or store epoch is a baseline, so history is never replayed.
 */

export type BotMemberStatus = 'preparing' | 'thinking' | 'replying' | 'tool' | 'waiting' | 'needs' | 'settling';
export interface BotStageMember {
  /** Branch identity as JSON; stable for the member's lifetime. */
  key: string;
  threadId: string;
  branchId: string;
  title: string;
  avatar: AgentAvatarId;
  status: BotMemberStatus;
}
/** A member her conversation handed work to directly; everyone below it is one of its helpers. */
export interface BotStageLead extends BotStageMember { sessionThreadId: string; subs: BotStageMember[] }
export type BotStageOutcome = 'ok' | 'fail';
export type BotStageEvent =
  | { kind: 'dispatch' | 'continue' | 'leave'; lead: string }
  | { kind: 'sub-dispatch'; lead: string; sub: string }
  | { kind: 'sub-report'; lead: string; sub: string; outcome: BotStageOutcome }
  | { kind: 'lead-report'; lead: string; outcome: BotStageOutcome }
  /** Her conversation committed receipt of the reports waiting on the ledge. */
  | { kind: 'gather'; count: number; outcome: BotStageOutcome }
  /** Something needs the user; `member` is null for her own conversation. */
  | { kind: 'needs' | 'resolved'; member: string | null }
  /** Her round ended with a reply while members still work. */
  | { kind: 'reply'; outcome: BotStageOutcome }
  /** Her round ended with a reply and nobody is left working on the request. */
  | { kind: 'complete'; weight: 'small' | 'large'; outcome: BotStageOutcome };
export interface BotStageView { own: (BotOwnPose & { threadId: string }) | null; leads: BotStageLead[] }

/** The open conversation's current Run as its projection sees it (ThreadConversation `onActivity`). */
export interface BotLiveRound {
  threadId: string;
  branchId: string;
  runId: string | null;
  text: 'thinking' | 'text' | null;
  tools: readonly { name: string; subject: string | null; units: number }[];
}
export interface BotStageObservation {
  snapshot: ThreadAttentionSnapshot | null;
  botId: string | null;
  live: BotLiveRound | null;
  /** The conversation open in the centre; its round is preferred when several reply at once. */
  preferThreadId: string | null;
  /** Wall-clock milliseconds, only for how long a request has been going. */
  now: number;
}

const ENDED = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['accepted', 'preparing', 'runnable', 'generating', 'executing', 'waiting']);
const FAILURES = new Set(['effect_unknown', 'run_failed', 'preparation_failed', 'mcp_error']);
/** A request is large with two leads, any helper, or this long (§5.7.3). */
const LARGE_REQUEST_MS = 120_000;
export const EMPTY_STAGE: BotStageView = { own: null, leads: [] };

const branchKey = (threadId: string, branchId: string) => JSON.stringify([threadId, branchId]);
const activeRun = (branch: ThreadAttentionBranch): ThreadAttentionRun | null =>
  branch.currentRun && ACTIVE.has(branch.currentRun.state) ? branch.currentRun : null;
const outcomeOf = (value: string | null): BotStageOutcome => value === null || value === 'succeeded' ? 'ok' : 'fail';

/** A Run's visible phase; the provider phase counts only once its durable event is inside the read. */
function runPhase(run: ThreadAttentionRun | null, cursor: number): Exclude<BotMemberStatus, 'needs' | 'settling'> | null {
  if (!run || !ACTIVE.has(run.state)) return null;
  if (run.state === 'accepted' || run.state === 'preparing' || run.state === 'runnable') return 'preparing';
  if (run.state === 'waiting') return 'waiting';
  if (run.state === 'executing') return 'tool';
  const phase = run.generation && run.generation.revision <= cursor ? run.generation.phase : null;
  return phase === 'output' ? 'replying' : phase === 'tool-call' ? 'tool' : 'thinking';
}

interface Episode { startedAt: number; leads: Set<string>; subs: Set<string>; failed: boolean }
interface Baseline {
  epoch: number;
  botId: string;
  cursor: number;
  leads: Set<string>;
  /** Items that need the user or report a failure: key → member key (null for her own conversation). */
  items: Map<string, { member: string | null; actionable: boolean }>;
  /** Each conversation's active Run id. */
  runs: Map<string, string | null>;
}

export class BotStageDirector {
  private baseline: Baseline | null = null;
  private readonly order = new Map<string, number>();
  private seq = 0;
  private readonly episodes = new Map<string, Episode>();
  /** Reports that reached a conversation's ledge and were not yet taken in. */
  private readonly inbox = new Map<string, { count: number; failed: boolean }>();
  private lastView: BotStageView | null = null;

  reset(): void {
    this.baseline = null;
    this.lastView = null;
    this.order.clear();
    this.episodes.clear();
    this.inbox.clear();
  }

  observe({ snapshot, botId, live, preferThreadId, now }: BotStageObservation): { view: BotStageView; events: BotStageEvent[] } {
    if (!snapshot || !botId) { this.reset(); return { view: EMPTY_STAGE, events: [] }; }
    const previous = this.baseline && this.baseline.botId === botId && this.baseline.epoch === snapshot.epoch ? this.baseline : null;
    if (!previous) this.reset();
    // A late read of the same epoch never moves the stage backwards.
    if (previous && snapshot.eventCursor < previous.cursor) return { view: this.lastView ?? EMPTY_STAGE, events: [] };
    const cursor = snapshot.eventCursor;
    const branches = new Map(snapshot.branches.map(branch => [branchKey(branch.threadId, branch.branchId), branch]));
    const roots = snapshot.branches.filter(branch => branch.botId === botId && branch.botSessionThreadId === branch.threadId && !branch.deleted);
    const rootKeys = new Set(roots.map(root => branchKey(root.threadId, root.branchId)));

    // Exact delegation relations inside this Bot's family; a child with two parents stays out.
    const parentOf = new Map<string, string>(), ambiguous = new Set<string>();
    const relations: { row: ThreadAttentionDelegation; child: string; parent: string }[] = [];
    for (const row of snapshot.delegations) {
      const child = branchKey(row.childThreadId, row.childBranchId), parent = branchKey(row.parentThreadId, row.parentBranchId);
      const childBranch = branches.get(child), parentBranch = branches.get(parent);
      if (!childBranch || !parentBranch || child === parent || childBranch.parentThreadId !== row.parentThreadId) continue;
      if (childBranch.botId !== botId || parentBranch.botId !== botId) continue;
      const known = parentOf.get(child);
      if (known && known !== parent) ambiguous.add(child); else parentOf.set(child, parent);
      relations.push({ row, child, parent });
    }
    const leadOf = new Map<string, string>(), rootOf = new Map<string, string>();
    for (const child of parentOf.keys()) {
      const seen = new Set<string>();
      let current = child;
      while (!seen.has(current) && !ambiguous.has(current)) {
        seen.add(current);
        const parent = parentOf.get(current);
        if (!parent) break;
        if (rootKeys.has(parent)) { leadOf.set(child, current); rootOf.set(current, parent); break; }
        current = parent;
      }
    }

    const executions = new Map<string, ThreadAttentionTeamExecution[]>();
    for (const row of snapshot.teamExecutions) {
      const key = branchKey(row.childThreadId, row.childBranchId);
      executions.set(key, [...executions.get(key) ?? [], row]);
    }
    const items = new Map<string, { member: string | null; actionable: boolean }>();
    const needing = new Set<string>();
    for (const item of snapshot.items) {
      if (!item.actionable && !FAILURES.has(item.kind)) continue;
      const key = branchKey(item.threadId, item.branchId);
      if (!rootKeys.has(key) && !leadOf.has(key)) continue;
      items.set(item.key, { member: rootKeys.has(key) ? null : key, actionable: item.actionable });
      needing.add(key);
    }
    const isLive = (key: string): boolean => {
      const branch = branches.get(key);
      return Boolean(branch && (activeRun(branch) || (executions.get(key) ?? []).some(row => !ENDED.has(row.state)) || needing.has(key)));
    };
    const member = (key: string): BotStageMember => {
      const branch = branches.get(key)!, rows = executions.get(key) ?? [];
      const avatar = agentAvatarForIdentity(branch.threadId, branch.avatar ?? rows.find(row => row.avatar)?.avatar);
      let status: BotMemberStatus | null = needing.has(key) ? 'needs' : runPhase(branch.currentRun, cursor);
      if (!status) {
        const live = rows.filter(row => !ENDED.has(row.state));
        status = live.some(row => row.activity === 'running') ? 'thinking' : live.some(row => row.activity === 'waiting') ? 'waiting'
          : live.some(row => row.activity === 'preparing') ? 'preparing' : 'settling';
      }
      return { key, threadId: branch.threadId, branchId: branch.branchId, title: branch.title, avatar, status };
    };

    // Seats keep the order members arrived in; members of one read arrive in dispatch order.
    const accepted = new Map(relations.map(({ row, child }) => [child, row.acceptedCursor ?? 0]));
    const liveKeys = [...leadOf.keys()].filter(isLive).sort((a, b) => (accepted.get(a) ?? 0) - (accepted.get(b) ?? 0));
    for (const key of liveKeys) if (!this.order.has(key)) this.order.set(key, ++this.seq);
    const byOrder = (a: string, b: string) => this.order.get(a)! - this.order.get(b)!;
    const leadKeys = new Set<string>();
    for (const key of liveKeys) leadKeys.add(leadOf.get(key)!);
    const leads: BotStageLead[] = [...leadKeys].filter(key => branches.has(key)).sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0)).map(key => ({
      ...member(key),
      sessionThreadId: branches.get(rootOf.get(key)!)!.threadId,
      subs: liveKeys.filter(sub => sub !== key && leadOf.get(sub) === key).sort(byOrder).map(member),
    }));
    for (const key of [...this.order.keys()]) if (!liveKeys.includes(key)) this.order.delete(key);

    const own = this.ownRound(roots, live, preferThreadId, cursor, leads);
    const events: BotStageEvent[] = [];
    for (const root of roots) {
      const key = branchKey(root.threadId, root.branchId);
      if (activeRun(root) && !this.episodes.has(key)) this.episodes.set(key, { startedAt: now, leads: new Set(), subs: new Set(), failed: false });
    }
    const deliveries = (snapshot.deliveredReports ?? []).map(row => ({ parent: branchKey(row.parentThreadId, row.parentBranchId), cursor: row.deliveredCursor }))
      .filter(row => rootKeys.has(row.parent));
    if (previous) this.moments(previous, { cursor, roots, relations, leadOf, rootOf, items, leads, deliveries, now }, events);
    this.baseline = {
      epoch: snapshot.epoch, botId, cursor, leads: new Set(leads.map(lead => lead.key)), items,
      runs: new Map(roots.map(root => [branchKey(root.threadId, root.branchId), activeRun(root)?.id ?? null])),
    };
    this.lastView = { own, leads };
    return { view: this.lastView, events };
  }

  private ownRound(roots: ThreadAttentionBranch[], live: BotLiveRound | null, prefer: string | null, cursor: number, leads: BotStageLead[]): BotStageView['own'] {
    const replying = roots.filter(root => activeRun(root));
    const root = replying.find(candidate => candidate.threadId === prefer) ?? replying[0];
    if (!root) return null;
    const run = activeRun(root)!;
    const team = leads.some(lead => lead.sessionThreadId === root.threadId);
    let phase = runPhase(run, cursor)!;
    const base = { threadId: root.threadId, tool: null, subject: null, count: 0 };
    if (phase === 'waiting') return { ...base, phase: team ? 'team' : 'thinking' };
    const seen = live && live.threadId === root.threadId && live.branchId === root.branchId && (!live.runId || live.runId === run.id) ? live : null;
    if (seen) {
      const tools = seen.tools.flatMap(tool => { const kind = botToolKind(tool.name); return kind ? [{ ...tool, kind }] : []; });
      const last = tools.at(-1);
      if (last?.kind === 'team') return { ...base, phase: 'team' };
      if (last) {
        const same = tools.filter(tool => tool.kind === last.kind), count = same.reduce((sum, tool) => sum + tool.units, 0);
        return { ...base, phase: 'tool', tool: last.kind, count, subject: count === 1 ? last.subject : null };
      }
      // Between calls the Run may still be executing; the conversation shows no tool, so neither does she.
      if (phase === 'tool') phase = seen.text === 'text' ? 'replying' : team ? 'waiting' : 'thinking';
      else if (phase !== 'preparing' && seen.text) phase = seen.text === 'text' ? 'replying' : 'thinking';
      if (phase === 'waiting') return { ...base, phase: 'team' };
    }
    if (phase === 'tool') return { ...base, phase: 'tool', tool: 'other', count: 1 };
    return { ...base, phase };
  }

  private moments(previous: Baseline, now: {
    cursor: number; roots: ThreadAttentionBranch[]; relations: { row: ThreadAttentionDelegation; child: string; parent: string }[];
    leadOf: Map<string, string>; rootOf: Map<string, string>; items: Map<string, { member: string | null; actionable: boolean }>; leads: BotStageLead[];
    deliveries: { parent: string; cursor: number }[]; now: number;
  }, events: BotStageEvent[]): void {
    const inside = (value: number | null) => value !== null && value > previous.cursor && value <= now.cursor;
    const episode = (lead: string) => this.episodes.get(now.rootOf.get(lead) ?? '');
    const happened: { at: number; event: BotStageEvent }[] = [];
    for (const { row, child } of [...now.relations]) {
      const lead = now.leadOf.get(child);
      if (!lead) continue;
      const isLead = lead === child;
      if (inside(row.acceptedCursor)) {
        happened.push({ at: row.acceptedCursor!, event: isLead ? { kind: 'dispatch', lead } : { kind: 'sub-dispatch', lead, sub: child } });
        if (isLead) episode(lead)?.leads.add(lead); else episode(lead)?.subs.add(child);
      }
      const continuedByRoot = now.roots.some(root => root.threadId === row.continuedByThreadId);
      if (isLead && continuedByRoot && inside(row.continuedCursor)) happened.push({ at: row.continuedCursor!, event: { kind: 'continue', lead } });
      if (inside(row.reportCursor)) {
        const outcome = outcomeOf(row.reportOutcome);
        if (outcome === 'fail') { const current = episode(lead); if (current) current.failed = true; }
        if (isLead) {
          const root = now.rootOf.get(lead)!, pending = this.inbox.get(root) ?? { count: 0, failed: false };
          this.inbox.set(root, { count: pending.count + 1, failed: pending.failed || outcome === 'fail' });
          happened.push({ at: row.reportCursor!, event: { kind: 'lead-report', lead, outcome } });
        } else happened.push({ at: row.reportCursor!, event: { kind: 'sub-report', lead, sub: child, outcome } });
      }
    }
    happened.sort((a, b) => a.at - b.at);
    events.push(...happened.map(entry => entry.event));
    // Taking in reports: a committed receipt by one of her conversations' Runs, once per conversation.
    for (const root of now.roots) {
      const key = branchKey(root.threadId, root.branchId);
      if (!now.deliveries.some(row => row.parent === key && inside(row.cursor))) continue;
      const pending = this.inbox.get(key) ?? { count: 0, failed: false };
      this.inbox.delete(key);
      events.push({ kind: 'gather', count: Math.max(1, pending.count), outcome: pending.failed ? 'fail' : 'ok' });
    }
    for (const [key, item] of now.items) if (!previous.items.has(key)) events.push({ kind: 'needs', member: item.member });
    for (const [key, item] of previous.items) if (!now.items.has(key) && item.actionable) events.push({ kind: 'resolved', member: item.member });
    const present = new Set(now.leads.map(lead => lead.key));
    for (const lead of previous.leads) if (!present.has(lead)) events.push({ kind: 'leave', lead });
    // Her round ended: a reply. Nobody left working on that conversation's request: it is complete.
    for (const root of now.roots) {
      const key = branchKey(root.threadId, root.branchId), was = previous.runs.get(key);
      if (!was || activeRun(root)?.id === was) continue;
      const latest = root.latestRun;
      const working = now.leads.some(lead => lead.sessionThreadId === root.threadId);
      const current = this.episodes.get(key);
      if (latest?.id === was && latest.state === 'completed' && latest.visibleOutput === true) {
        const outcome: BotStageOutcome = current?.failed ? 'fail' : 'ok';
        if (working) events.push({ kind: 'reply', outcome });
        else {
          const large = Boolean(current && (current.leads.size >= 2 || current.subs.size > 0 || now.now - current.startedAt >= LARGE_REQUEST_MS));
          events.push({ kind: 'complete', weight: large ? 'large' : 'small', outcome });
        }
      }
      if (!working && !activeRun(root)) this.episodes.delete(key);
    }
  }
}
