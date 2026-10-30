import { COMPANION_PROJECT_VISIBLE_LIMIT, COMPANION_TEAM_VISIBLE_LIMIT,
  type DesktopCompanionPortfolio, type ThreadAttentionItem, type ThreadAttentionSnapshot, type ThreadIdentity, type ThreadSnapshot } from '@varin/application-client';
import type { DirectorPresentation, DirectorProjectCard } from './directorPresentation';
import { directorBranchKey } from './directorProjects';
import { operationPresentation } from './toolPresentation';
import type { ObservationHealth } from './presentation';

type Project = DesktopCompanionPortfolio['projects'][number];
export interface DirectorToolDetail {
  identity: ThreadIdentity;
  runId: string;
  category: NonNullable<Project['detail']>;
  health: 'current' | 'unknown' | 'synchronizing';
}
/** Only admitted operation identity or actual Run phase may add execution detail to a project. */
export function directorToolDetail(snapshot: ThreadSnapshot | undefined, health: ObservationHealth): DirectorToolDetail | null {
  const run = snapshot?.activeRun;
  if (!snapshot || health !== 'current' || !run || run.cancel_requested
    || run.thread_id !== snapshot.identity.threadId || run.branch_id !== snapshot.identity.branchId) return null;
  const categories: Record<string, DirectorToolDetail['category']> = { T01: 'reading', T02: 'editing', T03: 'executing',
    T04: 'searching', T05: 'computing', T06: 'organizing', T07: 'verifying', T08: 'delegating' };
  const observed = new Set(snapshot.operations.filter(operation => operation.run_id === run.id)
    .map(operationPresentation).flatMap(value => value && categories[value.state] ? [categories[value.state]!] : []));
  const category = observed.size === 1 ? [...observed][0] : observed.size > 1 ? undefined
    : run.state === 'generating' ? 'generating' : run.state === 'waiting' ? 'waiting' : undefined;
  return category ? { identity: snapshot.identity, runId: run.id, category, health: 'current' } : null;
}

export interface DirectorPortfolioProjection {
  portfolio: DesktopCompanionPortfolio;
  /** This legend stays in the interactive renderer; full titles and identities stay here; bounded captions may travel to the inert scene. */
  legend: { key: string; label: Project['label']; identity: ThreadIdentity; title: string }[];
  sourceCurrent: boolean;
}
export interface DirectorPortfolioDisplayOptions { hideTaskNames?: boolean; }
/** Display budget only; never interpret the resulting text as markup. */
export function directorProjectCaption(title: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- explicitly remove non-display controls from untrusted task titles
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/gu, ' ').trim();
  const points = Array.from(clean);
  return points.length === 0 ? undefined : points.length <= 24 ? clean : `${points.slice(0, 23).join('')}…`;
}
/** Informational exceptions never acquire permission/question affordances. */
export function directorProjectNotice(items: readonly ThreadAttentionItem[], current: boolean):
  'permission' | 'question' | 'mixed' | 'inspect' | 'unknown' | undefined {
  if (!current) return 'unknown';
  const categories = new Set<'permission' | 'question' | 'inspect'>(items.map(item => {
    if (!item.actionable) return 'inspect';
    switch (item.kind) {
      case 'permission': case 'computer_permission': return 'permission';
      case 'question': case 'mcp_elicitation': return 'question';
      default: return 'inspect';
    }
  }));
  return categories.size > 1 ? 'mixed' : [...categories][0];
}
interface Seat { identityKey: string; token: string; }
interface TeamSeats { keys: string[]; tokens: Map<string, string>; }
const labels = ['A', 'B', 'C'] as const;

/** Read-only bounded mapping. Opaque keys cannot accidentally become runtime execution identities. */
export class DirectorPortfolioProjector {
  private scope = '';
  private serial = 0;
  private seats: (Seat | null)[] = Array(COMPANION_PROJECT_VISIBLE_LIMIT).fill(null);
  private teams = new Map<string, TeamSeats>();

  project(view: DirectorPresentation, snapshot: ThreadAttentionSnapshot | null, hostGeneration: number,
    details: readonly DirectorToolDetail[] = [], display: DirectorPortfolioDisplayOptions = {}): DirectorPortfolioProjection {
    const scope = JSON.stringify([hostGeneration, view.source?.epoch ?? snapshot?.epoch ?? null]);
    if (scope !== this.scope) { this.scope = scope; this.seats.fill(null); this.teams.clear(); }
    const current = view.health === 'current' && snapshot !== null && view.source !== null
      && view.source.epoch === snapshot.epoch && view.source.eventCursor === snapshot.eventCursor;
    const cards = new Map<string, DirectorProjectCard>();
    for (const card of view.cards) if (!cards.has(card.key)) cards.set(card.key, card);
    const wanted = [...cards.keys()].slice(0, COMPANION_PROJECT_VISIBLE_LIMIT);
    const wantedSet = new Set(wanted);
    this.seats = this.seats.map(seat => seat && wantedSet.has(seat.identityKey) ? seat : null);
    for (const identityKey of wanted) {
      if (this.seats.some(seat => seat?.identityKey === identityKey)) continue;
      const vacant = this.seats.findIndex(seat => seat === null);
      if (vacant >= 0) this.seats[vacant] = { identityKey, token: `project-${++this.serial}` };
    }
    for (const key of this.teams.keys()) if (!wantedSet.has(key)) this.teams.delete(key);
    const items = new Map(snapshot?.items.map(item => [item.key, item]) ?? []);
    const projects: Project[] = [];
    const legend: DirectorPortfolioProjection['legend'] = [];
    const nativeKey = new Map<string, string>();
    for (const [index, seat] of this.seats.entries()) {
      if (!seat) continue;
      const card = cards.get(seat.identityKey)!;
      nativeKey.set(card.key, seat.token);
      const exact = new Set(card.attentionKeys);
      const notice = directorProjectNotice([...exact].flatMap(key => items.has(key) ? [items.get(key)!] : []), current);
      const requestCount = current ? [...exact].filter(key => items.get(key)?.actionable).length : null;
      const uncertainCount = current ? [...exact].filter(key => items.get(key)?.kind === 'effect_unknown').length : null;
      // A child's tool is never relabelled as its root project lead's own tool.
      const detail = current ? details.find(value => value.health === 'current'
        && directorBranchKey(value.identity) === directorBranchKey(card.identity)
        && card.lead.runId !== null && value.runId === card.lead.runId) : undefined;
      const caption = display.hideTaskNames ? undefined : directorProjectCaption(card.title);
      projects.push({ ...(notice ? { notice } : {}), ...(caption ? { caption } : {}), key: seat.token, label: labels[index]!, lead: { avatar: card.lead.avatar, role: card.lead.role },
        status: current ? card.status : 'unknown', requestCount, uncertainCount, ...(detail ? { detail: detail.category } : {}) });
      legend.push({ key: seat.token, label: labels[index]!, identity: card.identity, title: card.title });
    }
    const inspectedKey = view.inspectedProjectKey ? nativeKey.get(view.inspectedProjectKey) ?? null : null;
    const subjectKey = view.body.subject ? nativeKey.get(directorBranchKey(view.body.subject)) ?? null : null;
    const mode: DesktopCompanionPortfolio['mode'] = !current ? 'overview' : ['present-attention', 'notify-attention'].includes(view.body.verb) ? 'attention'
      : view.body.verb === 'receive-work' ? 'intake' : ['receive-result', 'notify-result', 'present-reply'].includes(view.body.verb) ? 'result'
        : inspectedKey ? 'inspection' : 'overview';
    const portfolio: DesktopCompanionPortfolio = { mode, projects, inspectedKey, subjectKey,
      overflowCards: current ? view.overflowCards + Math.max(0, cards.size - wanted.length) : null };
    // Every visible lead owns only its own exact direct roster, independent of inspection.
    if (current) portfolio.teams = [];
    for (const identityKey of current ? wanted : []) {
      const card = cards.get(identityKey)!;
      const projectKey = nativeKey.get(identityKey)!;
      const children = new Map(card.children.map(child => [child.key, child]));
      const team = this.teams.get(identityKey) ?? { keys: [], tokens: new Map<string, string>() };
      team.keys = team.keys.filter(key => children.has(key));
      for (const key of children.keys()) if (team.keys.length < COMPANION_TEAM_VISIBLE_LIMIT && !team.keys.includes(key)) team.keys.push(key);
      for (const key of team.tokens.keys()) if (!team.keys.includes(key)) team.tokens.delete(key);
      for (const key of team.keys) if (!team.tokens.has(key)) team.tokens.set(key, `agent-${++this.serial}`);
      this.teams.set(identityKey, team);
      portfolio.teams!.push({ projectKey, members: team.keys.map(key => {
        const child = children.get(key)!;
        return { key: team.tokens.get(key)!, avatar: child.avatar, state: child.state };
      }), overflowCount: Math.max(0, children.size - team.keys.length) });
    }
    return { portfolio, legend, sourceCurrent: current };
  }
}
