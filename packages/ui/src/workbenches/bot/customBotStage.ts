import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import type { BotFigurePose } from './botPresentation';
import type { BotStageActor, BotStageLayers } from './botStageActor';
import type { FigureAccent } from './varinFigurePalette';

/** A neutral stage for imported artwork. Work remains visible without requiring hands or a rig. */
export class CustomBotStage implements BotStageActor {
  readonly stageLayers: BotStageLayers;
  readonly move = null;
  focus: { x: number; y: number } | null = null;
  onFrame: ((dt: number) => boolean | void) | null = null;
  onResize: (() => void) | null = null;
  onStagePause: (() => void) | null = null;
  viewBox: readonly [number, number, number, number] = [34, -24, 1192, 1192];
  private svg: SVGSVGElement;
  private frame: FrameHandle | null = null;
  private last = 0;
  private visible = true;
  private stopped = false;
  private cleanups: (() => void)[] = [];
  private accents: { node: Element; name: string; source: string }[] = [];
  constructor(private host: HTMLElement, public current: BotFigurePose, private accent: FigureAccent, private still: boolean) {
    const svg = this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');
    svg.classList.add('bot-custom-stage'); host.appendChild(svg);
    const group = () => { const node = document.createElementNS(svg.namespaceURI, 'g') as SVGGElement; svg.appendChild(node); return node; };
    this.stageLayers = { team: group(), ledge: group(), front: group(), fx: group() };
    const resize = () => {
      const span = Math.max(1192, 1192 * (host.clientWidth || 216) / (host.clientHeight || 216));
      this.viewBox = [628 - span / 2, -24, span, 1192]; svg.setAttribute('viewBox', this.viewBox.join(' ')); this.onResize?.();
    };
    resize();
    if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(resize); observer.observe(host); this.cleanups.push(() => observer.disconnect()); }
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(entries => { this.visible = entries[0]?.isIntersecting ?? true; this.refresh(); });
      observer.observe(host); this.cleanups.push(() => observer.disconnect());
    }
    const visibility = () => this.refresh(); document.addEventListener('visibilitychange', visibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
    const motion = new MutationObserver(visibility); motion.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] }); this.cleanups.push(() => motion.disconnect());
  }
  get moving() { return !this.still && documentMotionLevel() === 'full' && typeof requestAnimationFrame === 'function'; }
  get stageLive() { return !this.stopped && this.moving && this.visible && !document.hidden && !['sleeping', 'waking', 'offline'].includes(this.current); }
  setState(state: BotFigurePose) { this.current = state; this.refresh(); }
  private refresh() { if (this.stageLive) this.wake(); else { this.frame?.cancel(); this.frame = null; this.last = 0; this.onStagePause?.(); } }
  wake() {
    if (this.frame || !this.stageLive) return;
    this.frame = requestFrame(time => {
      this.frame = null; const dt = this.last ? Math.min((time - this.last) / 1000, .05) : 0; this.last = time;
      if (this.onFrame?.(dt)) this.wake(); else this.last = 0;
    });
  }
  // Imported images have no hand/eye skeleton. Flights use the edge of their presentation area.
  handPoint(side: 'L' | 'R'): [number, number] { return [side === 'L' ? 260 : 996, 1050]; }
  lookAt() {}
  play() {}
  cancelStageMove() {}
  tint(source: string) { return this.accent.tint(source); }
  paintAccent(node: Element, name: 'fill' | 'stroke', source: string) { this.accents.push({ node, name, source }); node.setAttribute(name, this.tint(source)); }
  setAccent(accent: FigureAccent) {
    this.accent = accent; this.accents = this.accents.filter(item => this.svg.contains(item.node));
    for (const item of this.accents) item.node.setAttribute(item.name, this.tint(item.source));
  }
  dispose() { this.stopped = true; this.frame?.cancel(); this.cleanups.forEach(dispose => dispose()); this.svg.remove(); }
}
