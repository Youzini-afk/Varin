import type { BotFigurePose } from './botPresentation';

/** The work stage depends on presentation capabilities, not a particular character's skeleton. */
export interface BotStageLayers { team: SVGGElement; ledge: SVGGElement; front: SVGGElement; fx: SVGGElement }
export interface BotStageActor {
  readonly stageLayers: BotStageLayers | null;
  readonly viewBox: readonly [number, number, number, number];
  readonly moving: boolean;
  readonly stageLive: boolean;
  readonly current: BotFigurePose;
  readonly move: { name: string; progress: number } | null;
  /** True while the work stage needs another frame; a static character can otherwise sleep. */
  onFrame: ((dt: number) => boolean | void) | null;
  onResize: (() => void) | null;
  onStagePause: (() => void) | null;
  focus: { x: number; y: number } | null;
  handPoint(side: 'L' | 'R'): [number, number];
  lookAt(x: number, y: number, seconds: number, turn: number): void;
  paintAccent(node: Element, name: 'fill' | 'stroke', source: string): void;
  tint(source: string): string;
  wake(): void;
  play(name: string): void;
  cancelStageMove(): void;
}
