import type { BotFigurePose } from './botPresentation';
import type { VarinFigureLayer } from './varinFigureArt';

export type FigurePoint = readonly [number, number];
export type FigureView = readonly [x: number, y: number, width: number, height: number];
export type FigureEye = 'open' | 'closed' | 'happy' | 'squeezeL' | 'squeezeR';
export type FigureMouth = 'smile' | 'smirk' | 'open' | 'grin' | 'o' | 'sleep' | 'yawn' | 'flat' | 'cat' | 'pout';
export type FigureMicroMove = 'wink' | 'nod' | 'tilt' | 'flick' | 'tap' | 'earTwitch';

type Blush = { cx: number; cy: number; rx: number; ry: number };
export interface FigureFace {
  eyeL: FigurePoint;
  eyeR: FigurePoint;
  hl2L: FigurePoint;
  hl2R: FigurePoint;
  browL: FigurePoint;
  browR: FigurePoint;
  browMotion: number;
  blushL: Blush;
  blushR: Blush;
  hasRestBlush: boolean;
  mouth: FigurePoint;
  lash: string;
  lip: string;
  blushBase: string;
  blushHot: string;
  eyeAltWidth: number;
}

export interface FigurePersonality {
  springScale: { body: number; face: number; hand: number };
  dampingMult: number;
  breatheRate: number;
  breatheAmp: number;
  idleFy: number;
  idleEyeY: number;
  idleBlush: number;
  idleMouth: FigureMouth;
  pokeMouth: FigureMouth;
  pokeEyes: FigureEye | 'squeeze';
  pokeBlush: number;
  thinkTilt: number;
  sleepSink: number;
  blinkRange: FigurePoint;
  microPool: readonly FigureMicroMove[];
  typingRate: number;
  lookScale: number;
}

export interface FigureAttachment {
  id: string;
  z: 'back' | 'front';
  pivot: FigurePoint;
  /** Elastic deformation follows the root-to-tip axis inside this bounding box. */
  bend?: boolean;
  tip?: FigurePoint;
  bbox?: readonly [left: number, top: number, right: number, bottom: number];
  layer?: VarinFigureLayer;
  clipIn?: string;
  clipHole?: string;
  /** Original foreground repainted over the moving piece. */
  foregroundClip?: string;
  static?: boolean;
  stiffness: number;
  damping: number;
  gainVy: number;
  gainVrot: number;
  idleAmp: number;
  idleFreq: number;
  stateAngle?: Partial<Record<BotFigurePose | 'poke', number>>;
}

export interface BotFigureArtwork {
  brandAccent: string;
  brandSoft: string;
  viewHead: FigureView;
  anchors: FigureFace & { handFill: string; handShadow: string };
  personality: FigurePersonality;
  layers: {
    back?: VarinFigureLayer;
    face: VarinFigureLayer;
    forehead?: VarinFigureLayer;
    eyeL: VarinFigureLayer;
    eyeR: VarinFigureLayer;
    browL: VarinFigureLayer;
    browR: VarinFigureLayer;
    front: VarinFigureLayer;
  };
  attachments: readonly FigureAttachment[];
}
