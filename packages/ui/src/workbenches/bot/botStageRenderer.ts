import type { AgentAvatarId } from '@varin/protocol';
import { AGENT_AVATAR_ART } from '@/components/ui/agent-avatar-art';
import type { BotMemberStatus, BotStageEvent, BotStageLead, BotStageMember, BotStageOutcome } from './botStageDirector';
import { BotReactionGrader, type BotReactionInput } from './botStageReactions';
import type { VarinFigureRig, VarinFigureStageLayers } from './varinFigureRig';

/**
 * The Bot panel's stage (docs/design/bot-ui.md §5.7.2, docs/design/varin-figure.md): her team on the
 * window ledge beside her, the cards and reports flying between them, and her graded reactions.
 * It draws into the wide figure's stage layers and runs on the figure's own frames, so it stops with
 * her when hidden or off screen. Without motion it only places the members.
 *
 * Crowding, per side of her: leads peek over the ledge with their hands on it; when that does not fit
 * they sit smaller side by side; what still does not fit goes into a "+n" pile. The pile keeps out, in
 * order, whoever needs you, whoever just had something happen, whoever is working. A lead shows up
 * to three helpers: small heads in front of it when peeking, dots on the ledge when sitting.
 */
export interface BotStageFeed {
  leads: readonly BotStageLead[];
  /** Moments in arrival order; ids only increase, and each plays at most once. */
  events: readonly { id: number; event: BotStageEvent }[];
  /** You are typing to her; reactions stay small. */
  typing: boolean;
}

type Side = 'L' | 'R';
type Mode = 'peek' | 'sit' | 'pile';
const NS = 'http://www.w3.org/2000/svg';
const LEDGE = 1100;
const CENTER = 628;
// Seat widths per density, member sizes, and each side's inner edge next to her hair (figure units).
const SLOT = { peek: 280, sit: 160, chip: 160 } as const;
const SIZE = { peek: 236, sit: 140, pile: 96 } as const;
const INNER: Record<Side, number> = { L: 30, R: 1226 };
const ACTIVE: readonly BotMemberStatus[] = ['preparing', 'thinking', 'replying', 'tool'];
const ACCENT = '#8fb0ea', ACCENT_SOFT = '#c9d6f5', WARN = '#f3b562', PAPER_LINE = '#c6ccdb';
const MARK = 'fill: var(--bot-figure-mark, #8a90a0)';
const BUBBLE = 'fill: var(--bot-figure-bubble, #ffffff)';
const CHIP = 'fill: var(--bot-figure-chip, #ffffff)';
const CHIP_TEXT = 'fill: var(--bot-figure-chip-text, #3a3f4a)';
/** How long a member stays "just had something happen" for focus and the pile. */
const SPOTLIGHT_S = 3;

const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ramp = (x: number, a: number, b: number): number => clamp((x - a) / (b - a));
const ease = (u: number): number => (u < .5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const shade = (color: string, k = .86): string => `#${[1, 3, 5].map(i => Math.round(parseInt(color.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  parent.appendChild(node);
  return node;
};
const attr = (node: Element, name: string, value: string | number): void => {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
};
function avatar(id: AgentAvatarId, parent: Element): SVGGElement {
  const art = AGENT_AVATAR_ART[id], g = el('g', {}, parent);
  if (art.accent) el('path', { d: art.accent.path, fill: art.accent.color }, g);
  el('path', { d: art.body, fill: art.color }, g);
  el('path', { d: art.eyes, fill: '#202326' }, g);
  if (art.eyeStroke) el('path', { d: art.eyeStroke, fill: 'none', stroke: '#202326', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
  return g;
}

interface Seat {
  key: string;
  lead: Seat | null;
  avatar: AgentAvatarId;
  color: string;
  status: BotMemberStatus;
  side: Side;
  order: number;
  /** False while the dispatched card is still on its way. */
  arrived: boolean;
  enter: number;
  leave: number;
  leaving: boolean;
  spot: number;
  x: number | null;
  s: number;
  tx: number;
  ts: number;
  peek: number;
  bump: number;
  mode: Mode;
  pileIndex: number;
  g: SVGGElement;
  body: SVGGElement;
  mark?: SVGGElement;
  markStatus?: BotMemberStatus;
  ring?: SVGCircleElement;
  caret?: SVGRectElement;
  hands?: SVGCircleElement[];
  pip?: SVGCircleElement;
  count?: SVGTextElement;
}
interface Flight { node: SVGGElement; kind: 'card' | 'plane' | 'envelope'; from: [number, number]; to: () => [number, number]; t: number; dur: number; lift: number; scale: number; follow: boolean; arrive?: (flight: Flight, animate: boolean) => void; keep?: boolean; report?: { session: string; gathered: boolean } }
interface Letter { node: SVGGElement; session: string; outcome: BotStageOutcome; x: number; y: number; r: number; gather: number | null; done: boolean }

export class BotStageRenderer {
  private readonly team: SVGGElement;
  private readonly ledge: SVGGElement;
  private readonly pileLayer: SVGGElement;
  private readonly piles: Record<Side, { g: SVGGElement; chip: SVGGElement; text: SVGTextElement; dot: SVGCircleElement }>;
  private readonly inboxG: SVGGElement;
  private readonly inboxBadge: SVGGElement;
  private readonly inboxText: SVGTextElement;
  private readonly fx: SVGGElement;
  private readonly card: SVGGElement;
  private readonly seats = new Map<string, Seat>();
  private readonly grader = new BotReactionGrader();
  private pileOf: Record<Side, { x: number; members: Seat[] } | null> = { L: null, R: null };
  private flights: Flight[] = [];
  private letters: Letter[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private t = 0;
  private seq = 0;
  private lastEvent = -1;
  private typing = false;
  private dirty = true;
  private layoutAt = 0;
  private started = false;
  private disposed = false;

  constructor(private readonly rig: VarinFigureRig) {
    const layers: VarinFigureStageLayers | null = rig.stageLayers;
    if (!layers) throw new Error('The stage needs the wide figure');
    this.team = el('g', {}, layers.team);
    this.ledge = el('g', {}, layers.ledge);
    const pileLayer = this.pileLayer = el('g', {}, layers.ledge);
    this.inboxG = el('g', {}, layers.ledge);
    this.fx = el('g', {}, layers.fx);
    const pile = () => {
      const g = el('g', { opacity: 0 }, pileLayer), chip = el('g', {}, g);
      el('rect', { x: -70, y: -36, width: 140, height: 72, rx: 36, style: CHIP, stroke: PAPER_LINE, 'stroke-width': 3 }, chip);
      const text = el('text', { x: 0, y: 21, 'text-anchor': 'middle', 'font-size': 58, 'font-weight': 700, style: CHIP_TEXT, 'font-family': 'system-ui, sans-serif' }, chip);
      const dot = el('circle', { cx: 58, cy: -30, r: 16, fill: WARN, opacity: 0 }, chip);
      return { g, chip, text, dot };
    };
    this.piles = { L: pile(), R: pile() };
    this.inboxBadge = el('g', { opacity: 0, transform: 'translate(700 1030)' }, this.inboxG);
    el('circle', { r: 32, fill: '#ffffff', stroke: PAPER_LINE, 'stroke-width': 4 }, this.inboxBadge);
    this.inboxText = el('text', { y: 17, 'text-anchor': 'middle', 'font-size': 46, 'font-weight': 700, fill: '#3a3f4a', 'font-family': 'system-ui, sans-serif' }, this.inboxBadge);
    // The card she holds up when she presents a reply to you.
    this.card = el('g', { opacity: 0 }, layers.front);
    el('rect', { x: -110, y: -74, width: 220, height: 148, rx: 18, fill: '#ffffff', stroke: '#d6d9e4', 'stroke-width': 5 }, this.card);
    rig.paintAccent(el('rect', { x: -80, y: -46, width: 110, height: 14, rx: 7, fill: ACCENT }, this.card), 'fill', ACCENT);
    for (const [y, width] of [[-14, 160], [12, 130], [38, 150]]) rig.paintAccent(el('rect', { x: -80, y, width, height: 12, rx: 6, fill: ACCENT_SOFT }, this.card), 'fill', ACCENT_SOFT);
    rig.onFrame = dt => this.frame(dt);
    rig.onResize = () => { this.dirty = true; if (!this.rig.stageLive) this.snap(); };
    rig.onStagePause = () => this.snap();
  }

  dispose(): void {
    this.disposed = true;
    this.rig.onFrame = null;
    this.rig.onResize = null;
    this.rig.onStagePause = null;
    this.rig.focus = null;
    for (const group of [this.team, this.ledge, this.pileLayer, this.inboxG, this.fx, this.card]) group.remove();
    this.seats.clear();
    this.flights = [];
    this.letters = [];
    this.timers = [];
  }

  /** New roster and moments from the director. */
  update(feed: BotStageFeed): void {
    if (this.disposed) return;
    this.typing = feed.typing;
    const fresh = feed.events.filter(entry => entry.id > this.lastEvent);
    if (fresh.length) this.lastEvent = fresh[fresh.length - 1]!.id;
    // Moments only play while she is visibly moving; otherwise the roster is simply placed.
    const playing = this.started && this.rig.stageLive;
    const incoming = new Set<string>();
    if (playing) for (const { event } of fresh) {
      if (event.kind === 'dispatch') incoming.add(event.lead);
      if (event.kind === 'sub-dispatch') incoming.add(event.sub);
    }
    this.roster(feed.leads, incoming, playing);
    this.started = true;
    if (playing) for (const { event } of fresh) this.play(event);
    this.dirty = true;
    if (!this.rig.stageLive) this.snap();
    else this.rig.wake();
  }

  // ------------------------------------------------------------ roster
  private roster(leads: readonly BotStageLead[], incoming: ReadonlySet<string>, animate: boolean): void {
    const present = new Set<string>();
    for (const lead of leads) {
      const seat = this.seat(lead, null, incoming, animate);
      present.add(lead.key);
      for (const sub of lead.subs) { this.seat(sub, seat, incoming, animate); present.add(sub.key); }
    }
    for (const seat of this.seats.values()) if (!present.has(seat.key) && !seat.leaving) {
      seat.leaving = true; seat.bump = 1;
      if (!animate || !this.rig.moving) this.remove(seat);
    }
  }

  private seat(member: BotStageMember, lead: Seat | null, incoming: ReadonlySet<string>, animate: boolean): Seat {
    const known = this.seats.get(member.key);
    if (known && !known.leaving) { if (known.status !== member.status) this.setStatus(known, member.status); return known; }
    if (known) this.remove(known);
    const counts = { L: 0, R: 0 };
    for (const other of this.seats.values()) if (!other.lead && !other.leaving) counts[other.side] += 1;
    const art = AGENT_AVATAR_ART[member.avatar], arrived = !incoming.has(member.key);
    const g = el('g', {}, lead ? this.ledge : this.team);
    const seat: Seat = {
      key: member.key, lead, avatar: member.avatar, color: art.color, status: member.status, side: lead?.side ?? (counts.R <= counts.L ? 'R' : 'L'), order: ++this.seq,
      arrived, enter: arrived && !animate ? 1 : 0, leave: 0, leaving: false, spot: animate ? this.t + SPOTLIGHT_S : 0,
      x: null, s: lead ? 60 : SIZE.peek, tx: CENTER, ts: SIZE.peek, peek: 1, bump: 0, mode: 'peek', pileIndex: 0, g, body: avatar(member.avatar, g),
    };
    if (lead) seat.pip = el('circle', { r: 19, fill: art.color, stroke: shade(art.color, .7), 'stroke-width': 5, opacity: 0 }, this.ledge);
    else {
      seat.mark = el('g', {}, g);
      seat.hands = [0, 1].map(() => el('circle', { r: 30, fill: shade(art.color), opacity: 0 }, this.ledge));
      this.setStatus(seat, member.status);
    }
    this.seats.set(member.key, seat);
    this.dirty = true;
    return seat;
  }

  private remove(seat: Seat): void {
    seat.g.remove(); seat.pip?.remove(); seat.count?.remove();
    for (const hand of seat.hands ?? []) hand.remove();
    this.seats.delete(seat.key);
    for (const sub of [...this.seats.values()]) if (sub.lead === seat) this.remove(sub);
    this.dirty = true;
  }

  private leads(): Seat[] { return [...this.seats.values()].filter(seat => !seat.lead); }
  private subsOf(lead: Seat): Seat[] { return [...this.seats.values()].filter(seat => seat.lead === lead).sort((a, b) => a.order - b.order); }

  /** The small mark above a lead's head says what it is doing; needs you is a badge with a ring. */
  private setStatus(seat: Seat, status: BotMemberStatus): void {
    seat.status = status;
    const mark = seat.mark;
    if (!mark || seat.markStatus === status) return;
    seat.markStatus = status;
    mark.replaceChildren();
    seat.ring = undefined; seat.caret = undefined;
    if (status === 'thinking') [-22, 0, 22].forEach((x, i) => el('circle', { cx: x, cy: -i * 6, r: 10, style: MARK }, mark));
    else if (status === 'replying') {
      el('rect', { x: -36, y: -16, width: 72, height: 32, rx: 16, style: BUBBLE }, mark);
      seat.caret = el('rect', { x: -24, y: -6, width: 10, height: 12, rx: 3, style: MARK }, mark);
    } else if (status === 'tool') el('path', { d: 'M0 -26 Q4 -4 26 0 Q4 4 0 26 Q-4 4 -26 0 Q-4 -4 0 -26 Z', fill: this.rig.tint(ACCENT) }, mark);
    else if (status === 'waiting') el('path', { d: 'M-16 -24 H16 L0 0 L16 24 H-16 L0 0 Z', style: MARK }, mark);
    else if (status === 'preparing') {
      el('rect', { x: -36, y: -16, width: 72, height: 32, rx: 16, style: BUBBLE }, mark);
      [-16, 0, 16].forEach(x => el('circle', { cx: x, cy: 0, r: 6, style: MARK }, mark));
    } else if (status === 'needs') {
      seat.ring = el('circle', { r: 30, fill: 'none', stroke: WARN, 'stroke-width': 6 }, mark);
      el('circle', { r: 30, fill: WARN }, mark);
      el('rect', { x: -5, y: -18, width: 10, height: 22, rx: 5, fill: '#3a2a12' }, mark);
      el('circle', { cx: 0, cy: 13, r: 5.5, fill: '#3a2a12' }, mark);
    }
    this.dirty = true;
  }

  private rank(seat: Seat): number {
    const group = seat.status === 'needs' ? 0 : seat.spot > this.t ? 1 : ACTIVE.includes(seat.status) ? 2 : 3;
    return group - (seat.mode !== 'pile' ? .5 : 0);
  }

  private layout(): void {
    this.dirty = false;
    const [vx, , vw] = this.rig.viewBox;
    for (const side of ['L', 'R'] as const) {
      const dir = side === 'L' ? -1 : 1, inner = INNER[side];
      const room = Math.abs((side === 'L' ? vx + 50 : vx + vw - 50) - inner);
      const leads = this.leads().filter(seat => seat.side === side && !seat.leaving).sort((a, b) => a.order - b.order);
      let mode: Mode = 'peek', visible = leads;
      if (leads.length * SLOT.peek > room) {
        mode = 'sit';
        if (leads.length * SLOT.sit > room) {
          const fits = Math.max(1, Math.floor((room - SLOT.chip) / SLOT.sit));
          const kept = new Set([...leads].sort((a, b) => this.rank(a) - this.rank(b) || a.order - b.order).slice(0, fits));
          visible = leads.filter(seat => kept.has(seat));
        }
      }
      visible.forEach((seat, i) => { seat.mode = mode; seat.tx = inner + dir * (i + .5) * SLOT[mode]; seat.ts = SIZE[mode]; });
      const piled = leads.filter(seat => !visible.includes(seat)), px = inner + dir * (visible.length * SLOT[mode] + SLOT.chip / 2);
      piled.forEach((seat, i) => { seat.mode = 'pile'; seat.tx = px + [0, -40, 40][Math.min(i, 2)]!; seat.ts = SIZE.pile; seat.pileIndex = i; });
      this.pileOf[side] = piled.length ? { x: px, members: piled } : null;
    }
  }

  // ------------------------------------------------------------ geometry
  private bottomOf(seat: Seat): number { return seat.mode === 'peek' ? LEDGE + .27 * seat.s : LEDGE + 2; }
  private catchPoint(seat: Seat): [number, number] {
    if (seat.lead) return [seat.x ?? seat.lead.x ?? seat.lead.tx, LEDGE - 30];
    const pile = this.pileOf[seat.side];
    if (seat.mode === 'pile' && pile) return [pile.x, LEDGE - 60];
    return [seat.x ?? seat.tx, this.bottomOf(seat) - seat.s * .55];
  }
  private herHand(side: Side): [number, number] { const [x, y] = this.rig.handPoint(side); return [x, y - 80]; }
  private later(seconds: number, fn: () => void): void { this.timers.push({ at: this.t + seconds, fn }); }

  // ------------------------------------------------------------ moments
  private play(event: BotStageEvent): void {
    const lead = 'lead' in event ? this.seats.get(event.lead) : undefined;
    switch (event.kind) {
      case 'dispatch': {
        if (!lead) return;
        lead.spot = this.t + SPOTLIGHT_S;
        this.layout();
        this.rig.play(lead.side === 'L' ? 'throwL' : 'throwR');
        this.later(.42, () => this.fly('card', this.herHand(lead.side), () => this.catchPoint(lead), { dur: .75, lift: 260, follow: true,
          arrive: () => { lead.arrived = true; lead.spot = this.t + SPOTLIGHT_S; this.dirty = true; } }));
        return;
      }
      case 'continue': {
        if (!lead) return;
        lead.spot = this.t + SPOTLIGHT_S; this.dirty = true;
        this.rig.play(lead.side === 'L' ? 'throwL' : 'throwR');
        this.later(.42, () => this.fly('plane', this.herHand(lead.side), () => this.catchPoint(lead), { dur: .7, lift: 160, follow: true, arrive: () => { lead.bump = 1; } }));
        return;
      }
      case 'sub-dispatch': {
        const sub = this.seats.get(event.sub);
        if (!lead || !sub) { if (sub) sub.arrived = true; return; }
        this.fly('card', this.catchPoint(lead), () => [sub.x ?? lead.x ?? lead.tx, LEDGE - 40], { dur: .55, lift: 90, scale: .45, arrive: () => { sub.arrived = true; } });
        this.react({ kind: 'sub-dispatch', outcome: 'ok' }, lead);
        return;
      }
      case 'sub-report': {
        const sub = this.seats.get(event.sub);
        if (lead && sub) this.fly('envelope', this.catchPoint(sub), () => this.catchPoint(lead), { dur: .55, lift: 90, scale: .42, outcome: event.outcome, arrive: () => { lead.bump = 1; } });
        this.react({ kind: 'sub-report', outcome: event.outcome }, lead);
        return;
      }
      case 'lead-report': {
        if (!lead) return;
        lead.spot = this.t + SPOTLIGHT_S; this.dirty = true;
        this.fly('envelope', this.catchPoint(lead), () => [CENTER, 1066], { dur: .8, lift: 240, outcome: event.outcome, reportSession: event.session, arrive: (flight, animate) => {
          flight.keep = true; this.inboxG.appendChild(flight.node);
          const gathered = flight.report?.gathered === true;
          this.letters.push({ node: flight.node, session: event.session, outcome: event.outcome, x: CENTER, y: 1066, r: -8 + Math.random() * 16, gather: gathered ? 0 : null, done: false });
          if (animate && !gathered) this.react({ kind: 'lead-report', outcome: event.outcome }, lead);
        } });
        return;
      }
      case 'gather': {
        for (const letter of this.letters) if (letter.session === event.session && letter.gather === null) letter.gather = 0;
        for (const flight of this.flights) if (flight.report?.session === event.session) flight.report.gathered = true;
        this.react({ kind: 'gather', outcome: event.outcome });
        return;
      }
      case 'needs': {
        const member = event.member ? this.seats.get(event.member) : undefined;
        const shown = member?.lead ?? member;
        if (!shown) return;
        shown.spot = this.t + 2 * SPOTLIGHT_S; this.layout();
        this.later(.05, () => this.rig.play(shown.side === 'L' ? 'pointL' : 'pointR'));
        return;
      }
      case 'resolved': {
        const member = event.member ? this.seats.get(event.member) : undefined;
        this.react({ kind: 'resolved', outcome: 'ok' }, member?.lead ?? member);
        return;
      }
      case 'leave': this.react({ kind: 'leave', outcome: 'ok' }, lead); return;
      case 'reply': this.react({ kind: 'reply', outcome: event.outcome }); return;
      case 'complete': this.react({ kind: 'complete', outcome: event.outcome, weight: event.weight }); return;
    }
  }

  /** §5.7.3: grade the result, then perform only what the grade allows. */
  private react(input: BotReactionInput, at?: Seat): void {
    const urgent = this.rig.current === 'waiting' || [...this.seats.values()].some(seat => seat.status === 'needs' && !seat.leaving);
    const { level } = this.grader.grade(input, { now: performance.now() / 1000, urgent, typing: this.typing });
    const fail = input.outcome === 'fail';
    if (level === 0) return;
    if (level === 1) {
      const [x, y] = at ? this.catchPoint(at) : input.kind === 'reply' || input.kind === 'complete' ? [CENTER, 760] : [CENTER, 1070];
      this.rig.lookAt(x, y, .9, .8);
      return;
    }
    if (level === 2) this.rig.play(fail ? 'concern' : input.kind === 'gather' ? 'gather' : 'ack');
    else if (level === 3) this.rig.play(fail ? 'presentSerious' : 'present');
    else this.rig.play('cheerLite');
  }

  private fly(kind: Flight['kind'], from: [number, number], to: () => [number, number], options: { dur: number; lift: number; scale?: number; follow?: boolean; outcome?: BotStageOutcome; reportSession?: string; arrive?: Flight['arrive'] }): void {
    const node = el('g', {}, this.fx);
    if (kind === 'card') {
      el('rect', { x: -46, y: -32, width: 92, height: 64, rx: 10, fill: this.rig.tint(ACCENT) }, node);
      el('path', { d: 'M-46 0 H46', stroke: '#ffffff', 'stroke-width': 5, opacity: .8 }, node);
    } else if (kind === 'plane') {
      el('path', { d: 'M-46 18 L50 -4 L-30 -28 L-20 -4 Z', fill: '#ffffff', stroke: this.rig.tint(ACCENT), 'stroke-width': 5, 'stroke-linejoin': 'round' }, node);
      el('path', { d: 'M-20 -4 L50 -4', stroke: this.rig.tint(ACCENT), 'stroke-width': 4 }, node);
    } else {
      el('rect', { x: -48, y: -32, width: 96, height: 64, rx: 8, fill: '#ffffff', stroke: PAPER_LINE, 'stroke-width': 4 }, node);
      el('path', { d: 'M-46 -28 L0 6 L46 -28', fill: 'none', stroke: PAPER_LINE, 'stroke-width': 4, 'stroke-linejoin': 'round' }, node);
      if (options.outcome) el('circle', { cx: 40, cy: -26, r: 14, fill: options.outcome === 'fail' ? '#e3a04c' : '#7cc79a' }, node);
    }
    attr(node, 'opacity', 0);
    this.flights.push({ node, kind, from, to, t: 0, dur: options.dur, lift: options.lift, scale: options.scale ?? 1, follow: Boolean(options.follow), arrive: options.arrive,
      report: options.reportSession === undefined ? undefined : { session: options.reportSession, gathered: false } });
  }

  // ------------------------------------------------------------ frames
  private frame(dt: number): void {
    if (this.disposed || !this.rig.stageLive) return;
    this.t += dt;
    for (const timer of this.timers.splice(0)) { if (timer.at <= this.t) timer.fn(); else this.timers.push(timer); }
    if (this.dirty || this.t - this.layoutAt > .5) { this.layout(); this.layoutAt = this.t; }
    this.drawSeats(clamp(dt * 7), dt, true);
    this.drawFlights(dt);
    this.drawLetters(dt);
    this.drawCard();
    const focus = this.leads().filter(seat => !seat.leaving && seat.mode !== 'pile').sort((a, b) => b.spot - a.spot)[0];
    this.rig.focus = focus ? (([x, y]) => ({ x, y }))(this.catchPoint(focus)) : null;
  }

  /** Without frames (still, reduced motion, hidden): place everyone where they belong. */
  private snap(): void {
    this.rig.cancelStageMove();
    this.timers = [];
    for (const seat of [...this.seats.values()]) if (seat.leaving) this.remove(seat);
    for (const flight of this.flights) { flight.arrive?.(flight, false); if (!flight.keep) flight.node.remove(); }
    this.flights = [];
    for (const seat of this.seats.values()) { seat.arrived = true; seat.enter = 1; seat.bump = 0; }
    this.layout();
    this.drawSeats(1, 0, false);
    this.drawLetters(0);
    attr(this.card, 'opacity', 0);
    const focus = this.leads().filter(seat => seat.mode !== 'pile').sort((a, b) => b.spot - a.spot)[0];
    this.rig.focus = focus ? (([x, y]) => ({ x, y }))(this.catchPoint(focus)) : null;
  }

  private drawSeats(k: number, dt: number, moving: boolean): void {
    for (const seat of [...this.seats.values()]) {
      if (seat.leaving) { seat.leave = Math.min(1, seat.leave + dt * 1.6); if (seat.leave >= 1 || !moving) { this.remove(seat); continue; } }
      if (seat.arrived) seat.enter = moving ? Math.min(1, seat.enter + dt * 3.2) : 1;
      if (seat.lead) this.drawSub(seat, k); else this.drawLead(seat, k, dt, moving);
    }
    for (const side of ['L', 'R'] as const) {
      const pile = this.pileOf[side], parts = this.piles[side];
      attr(parts.g, 'opacity', pile ? 1 : 0);
      if (!pile) continue;
      attr(parts.chip, 'transform', `translate(${pile.x.toFixed(1)} ${LEDGE + 8})`);
      parts.text.textContent = `+${pile.members.length}`;
      attr(parts.dot, 'opacity', pile.members.some(seat => seat.status === 'needs') ? 1 : 0);
    }
  }

  private drawLead(seat: Seat, k: number, dt: number, moving: boolean): void {
    if (seat.x === null) { seat.x = seat.tx; seat.s = seat.ts; seat.peek = seat.mode === 'peek' ? 1 : 0; }
    seat.x += (seat.tx - seat.x) * k; seat.s += (seat.ts - seat.s) * k;
    seat.peek += ((seat.mode === 'peek' ? 1 : 0) - seat.peek) * k;
    seat.bump = Math.max(0, seat.bump - dt * 3);
    const helpers = this.subsOf(seat).filter(sub => !sub.leaving).length, cap = this.subCap(seat, helpers);
    this.subCount(seat, seat.mode !== 'pile' && !seat.leaving && helpers > cap, helpers - cap);
    const hidden = seat.mode === 'pile' && seat.pileIndex > 2;
    const bottom = lerp(LEDGE + 2, LEDGE + .27 * seat.s, seat.peek) + (1 - ease(seat.enter)) * seat.s * .95 + ease(seat.leave) * seat.s - 26 * Math.sin(Math.PI * seat.bump);
    const bob = moving && ACTIVE.includes(seat.status) && seat.mode !== 'pile' ? 5 * Math.sin(this.t * 2.4 + seat.order) : 0;
    attr(seat.body, 'transform', `translate(${(seat.x - seat.s / 2).toFixed(1)} ${(bottom - seat.s * 60 / 64 + bob).toFixed(1)}) scale(${(seat.s / 64).toFixed(4)})`);
    attr(seat.g, 'opacity', hidden ? 0 : 1);
    if (seat.mark) {
      attr(seat.mark, 'opacity', seat.mode !== 'pile' && seat.enter > .8 && !seat.leaving ? 1 : 0);
      attr(seat.mark, 'transform', `translate(${(seat.x + seat.s * .36).toFixed(1)} ${(bottom - seat.s * .9 + bob).toFixed(1)}) scale(${Math.max(.7, seat.s / SIZE.peek).toFixed(3)})`);
    }
    if (seat.ring) { const ph = moving ? (this.t % 1.4) / 1.4 : .3; attr(seat.ring, 'r', (30 + ph * 26).toFixed(1)); attr(seat.ring, 'opacity', (.7 * (1 - ph)).toFixed(3)); }
    if (seat.caret) attr(seat.caret, 'x', moving ? (-24 + ((this.t * 40) % 40)).toFixed(1) : -8);
    const hands = seat.peek * ease(seat.enter) * (1 - seat.leave) * (hidden ? 0 : 1);
    seat.hands?.forEach((hand, i) => {
      attr(hand, 'cx', (seat.x! + (i ? 1 : -1) * seat.s * .42).toFixed(1));
      attr(hand, 'cy', (LEDGE - 4 - 10 * Math.sin(Math.PI * seat.bump)).toFixed(1));
      attr(hand, 'r', (seat.s * .13).toFixed(1));
      attr(hand, 'opacity', hands.toFixed(3));
    });
  }

  // Peek seats show up to three heads; sit seats are 160 wide: three dots, or two dots and a count.
  private subCap(lead: Seat, helpers: number): number { return lead.mode === 'peek' ? 3 : helpers > 3 ? 2 : 3; }

  private drawSub(seat: Seat, k: number): void {
    const lead = seat.lead!, subs = this.subsOf(lead).filter(sub => !sub.leaving || sub === seat), i = subs.indexOf(seat);
    const show = lead.mode !== 'pile' && !lead.leaving && lead.x !== null, peek = lead.mode === 'peek';
    const helpers = subs.filter(sub => !sub.leaving).length, cap = this.subCap(lead, helpers), shown = Math.min(helpers, cap), over = helpers > cap;
    const leadX = lead.x ?? lead.tx;
    // Peek: little heads on the ledge in front of their lead. Sit: overlapping dots on the ledge face,
    // centred under the lead; with a count they shift left so dots and count stay inside one seat.
    const tx = peek ? leadX + [-.22, .22, 0][Math.min(i, 2)]! * lead.s : leadX + (Math.min(i, shown - 1) - (shown - 1) / 2) * 30 - (over ? 24 : 0);
    if (seat.x === null) seat.x = tx;
    seat.x += (tx - seat.x) * k;
    const pop = ease(seat.enter) * (1 - ease(seat.leave)), size = lead.s * .3 * pop;
    attr(seat.body, 'transform', `translate(${(seat.x - size / 2).toFixed(1)} ${(LEDGE + 2 - size * 60 / 64).toFixed(1)}) scale(${Math.max(.001, size / 64).toFixed(4)})`);
    attr(seat.g, 'opacity', show && peek && i < cap ? 1 : 0);
    if (seat.pip) {
      attr(seat.pip, 'cx', seat.x.toFixed(1)); attr(seat.pip, 'cy', LEDGE + 20); attr(seat.pip, 'r', (19 * pop).toFixed(1));
      attr(seat.pip, 'opacity', show && !peek && i < cap ? 1 : 0);
      attr(seat.pip, 'stroke', seat.status === 'needs' ? WARN : shade(seat.color, .7));
    }
  }

  private subCount(lead: Seat, show: boolean, extra: number): void {
    if (!lead.count && !show) return;
    if (!lead.count) lead.count = el('text', { 'text-anchor': 'start', 'font-weight': 700, style: CHIP_TEXT, 'font-family': 'system-ui, sans-serif' }, this.ledge);
    const peek = lead.mode === 'peek', x = lead.x ?? lead.tx;
    lead.count.textContent = `+${extra}`;
    attr(lead.count, 'font-size', peek ? 50 : 46);
    attr(lead.count, 'x', (peek ? x + .36 * lead.s : x + 14).toFixed(1));
    attr(lead.count, 'y', peek ? LEDGE - 6 : LEDGE + 35);
    attr(lead.count, 'opacity', show ? 1 : 0);
  }

  private drawFlights(dt: number): void {
    this.flights = this.flights.filter(flight => {
      flight.t += dt;
      const u = Math.min(1, flight.t / flight.dur), e = ease(u), to = flight.to();
      const cx = (flight.from[0] + to[0]) / 2, cy = Math.min(flight.from[1], to[1]) - flight.lift;
      const x = (1 - e) ** 2 * flight.from[0] + 2 * (1 - e) * e * cx + e * e * to[0];
      const y = (1 - e) ** 2 * flight.from[1] + 2 * (1 - e) * e * cy + e * e * to[1];
      const right = to[0] > flight.from[0];
      const spin = flight.kind === 'card' ? 360 * e * (right ? 1 : -1) : flight.kind === 'plane' ? (right ? 0 : 180) + 10 * Math.sin(u * 9) : 8 * Math.sin(u * 7);
      const s = flight.scale * (u < .15 ? .4 + 4 * u : 1);
      attr(flight.node, 'opacity', 1);
      attr(flight.node, 'transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${spin.toFixed(1)}) scale(${flight.kind === 'plane' && !right ? `${s.toFixed(3)} ${(-s).toFixed(3)}` : s.toFixed(3)})`);
      if (flight.follow) this.rig.lookAt(x, y, .25, .9);
      if (u < 1) return true;
      flight.arrive?.(flight, true);
      if (!flight.keep) flight.node.remove();
      return false;
    });
  }

  private drawLetters(dt: number): void {
    this.letters.forEach((letter, i) => {
      if (letter.gather !== null) {
        letter.gather += dt;
        const u = dt ? clamp((letter.gather - .35) / .6) : 1, x = lerp(letter.x, CENTER, ease(u)), y = lerp(letter.y, 1010, ease(u));
        attr(letter.node, 'transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(letter.r * (1 - u)).toFixed(1)}) scale(${(.9 * (1 - .6 * u)).toFixed(3)})`);
        attr(letter.node, 'opacity', (1 - ramp(u, .6, 1)).toFixed(3));
        if (u >= 1) letter.done = true;
        return;
      }
      const behind = this.letters.length - 1 - i, tx = CENTER - 30 + Math.min(behind, 2) * 22, ty = 1072 - Math.min(behind, 2) * 12, k = dt ? clamp(dt * 8) : 1;
      letter.x += (tx - letter.x) * k; letter.y += (ty - letter.y) * k;
      attr(letter.node, 'transform', `translate(${letter.x.toFixed(1)} ${letter.y.toFixed(1)}) rotate(${letter.r.toFixed(1)}) scale(.9)`);
      attr(letter.node, 'opacity', behind > 2 ? 0 : 1);
    });
    for (const letter of this.letters) if (letter.done) letter.node.remove();
    this.letters = this.letters.filter(letter => !letter.done);
    const waiting = this.letters.filter(letter => letter.gather === null).length;
    attr(this.inboxBadge, 'opacity', waiting > 3 ? 1 : 0);
    this.inboxText.textContent = String(waiting);
  }

  private drawCard(): void {
    const move = this.rig.move, on = move && (move.name === 'present' || move.name === 'presentSerious');
    const opacity = on ? ramp(move.progress, .12, .25) * (1 - ramp(move.progress, .85, .97)) : 0;
    attr(this.card, 'opacity', opacity.toFixed(3));
    if (!opacity) return;
    const [lx, ly] = this.rig.handPoint('L'), [rx, ry] = this.rig.handPoint('R');
    attr(this.card, 'transform', `translate(${((lx + rx) / 2).toFixed(1)} ${((ly + ry) / 2 - 92).toFixed(1)}) rotate(-2)`);
  }
}
