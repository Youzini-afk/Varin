import type { CompanionPackage, CompanionFrame } from './sequencePackage';
export interface PlaybackAsset extends CompanionPackage {
  entryPose: string; exitPose: string; geometryReference: string;
  kind?: string; action?: string; loop?: [number, number] | null;
}
export interface RouteResult { status: 'ready' | 'blocked'; clips: string[]; reason?: string }
export function route(current: PlaybackAsset | null, target: PlaybackAsset | undefined, assets: PlaybackAsset[]): RouteResult;
export function frameAt(asset: PlaybackAsset, timeMs: number): (CompanionFrame & { pose?: string }) | null;
export class CompanionPlayback {
  constructor(assets: PlaybackAsset[]);
  current: PlaybackAsset | null; timeMs: number; pending: string | null;
  gesture: { released: boolean } | null; worldEvent: { phase: 'lift' | 'landing' | 'clear'; revision: number; packageId: string | null } | null; grab(displayed?: { packageId: string; exposure: number }): boolean; release(displayed?: { packageId: string; exposure: number }): void;
  canDisplay: (id: string) => boolean; loading: string | null; advance(): boolean | undefined; path: string[]; blocker: string | null; hold: boolean;
  request(id: string, options?: { urgent?: boolean }): RouteResult;
  tick(elapsedMs: number): void;
}
export { CompanionPlayback as ReviewPlayback };
