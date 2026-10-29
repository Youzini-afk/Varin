/** Drawing/exposure contract. No application commands or automatic motion synthesis. */
export interface CompanionFrame {
  page: number; rect: [number, number, number, number]; offset: [number, number]; durationMs: number; startMs: number; sha256?: string; pose?: string; phase?: string; exitTo?: string[]; motion?: { renderedPixelSha256?: string; reverseFrom?: { sequence: string; frameIndex: number } };
}
export interface CompanionPackage {
  id: string; canvas: [number, number]; frames: CompanionFrame[]; pages: { file: string }[];
  gesture?: { entrySourceSha256?: string; restoreSourceSha256?: string; grabNext: string[]; releaseNext: string[]; embeddedStool: boolean; settled: boolean; restoreOnRelease: boolean };
  durationMs: number; entryPose?: string; exitPose?: string; geometryReference?: string; loop?: [number, number] | null; kind?: string; action?: string; stage?: string; reviewStatus?: string; warning?: string;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sequence record');
  return value as Record<string, unknown>;
};
const integers = (value: unknown, size: number): number[] => {
  if (!Array.isArray(value) || value.length !== size || !value.every(Number.isSafeInteger)) throw new Error('Invalid sequence coordinates');
  return value as number[];
};
export function readCompanionPackage(value: unknown, review: boolean): CompanionPackage {
  const data = record(value);
  if (typeof data.id !== 'string' || !data.id) throw new Error('Missing sequence identity');
  if (!review && (data.stage !== 'motion-candidate' || data.reviewStatus !== 'accepted')) throw new Error('Artwork has not passed visual review');
  const canvas = integers(data.canvas, 2) as [number, number];
  if (canvas.some(size => size <= 0)) throw new Error('Invalid canvas');
  if (!Array.isArray(data.pages) || !data.pages.length || !Array.isArray(data.frames) || !data.frames.length) throw new Error('Missing sequence images');
  const pages = data.pages.map(value => {
    const page = record(value);
    if (typeof page.file !== 'string' || !/^[^/\\]+\.png$/i.test(page.file)) throw new Error('Expected a local PNG atlas filename');
    return { file: page.file };
  });
  let elapsed = 0;
  const frames = data.frames.map(value => {
    const frame = record(value), rect = integers(frame.rect, 4) as CompanionFrame['rect'], offset = integers(frame.offset, 2) as CompanionFrame['offset'];
    if (typeof frame.page !== 'number' || !Number.isSafeInteger(frame.page) || frame.page < 0 || frame.page >= pages.length || rect.some(n => n < 0) || rect[2] <= 0 || rect[3] <= 0) throw new Error('Invalid atlas region');
    if (offset.some(n => n < 0) || offset[0] + rect[2] > canvas[0] || offset[1] + rect[3] > canvas[1]) throw new Error('Drawing escapes registered canvas');
    if (typeof frame.durationMs !== 'number' || !Number.isFinite(frame.durationMs) || frame.durationMs <= 0) throw new Error('Invalid authored duration');
    const exitTo = frame.exitTo == null ? [] : frame.exitTo;
    if (!Array.isArray(exitTo) || !exitTo.every(value => typeof value === 'string')) throw new Error('Invalid safe exits');
    let motion: CompanionFrame['motion'];
    if (frame.motion != null) {
      const source = record(frame.motion);
      motion = { renderedPixelSha256: typeof source.renderedPixelSha256 === 'string' ? source.renderedPixelSha256 : undefined };
      if (source.reverseFrom != null) {
        const reverse = record(source.reverseFrom);
        if (typeof reverse.sequence !== 'string' || !Number.isSafeInteger(reverse.frameIndex) || (reverse.frameIndex as number) < 0) throw new Error('Invalid authored reverse entry');
        motion.reverseFrom = { sequence: reverse.sequence, frameIndex: reverse.frameIndex as number };
      }
    }
    const result = { sha256: typeof frame.sha256 === 'string' ? frame.sha256 : undefined, phase: typeof frame.phase === 'string' ? frame.phase : undefined, exitTo: exitTo as string[], motion, page: frame.page, rect, offset, durationMs: frame.durationMs, startMs: elapsed, pose: typeof frame.pose === 'string' ? frame.pose : undefined };
    elapsed += frame.durationMs;
    return result;
  });
  let loop: [number, number] | null = null;
  if (data.loop != null && data.loop !== false) {
    loop = integers(data.loop, 2) as [number, number];
    if (loop[0] < 0 || loop[1] <= loop[0] || loop[1] > frames.length) throw new Error('Invalid authored hold loop');
  }
  const entryPose = typeof data.entryPose === 'string' ? data.entryPose : undefined;
  const exitPose = typeof data.exitPose === 'string' ? data.exitPose : undefined;
  const geometryReference = typeof data.geometryReference === 'string' ? data.geometryReference : undefined;
  if (!review && (!entryPose || !exitPose || !geometryReference)) throw new Error('Missing accepted geometry/pose contract');
  let gesture: CompanionPackage['gesture'];
  if (data.gesture != null) {
    const node = record(data.gesture);
    if (!Array.isArray(node.grabNext) || !Array.isArray(node.releaseNext) || ![...node.grabNext,...node.releaseNext].every(id => typeof id === 'string' && id.length > 0)
      || typeof node.embeddedStool !== 'boolean' || typeof node.settled !== 'boolean' || typeof node.restoreOnRelease !== 'boolean' || frames.length !== 1) throw new Error('Invalid authored gesture node');
    gesture = { restoreSourceSha256: typeof node.restoreSourceSha256 === 'string' ? node.restoreSourceSha256 : undefined, entrySourceSha256: typeof node.entrySourceSha256 === 'string' ? node.entrySourceSha256 : undefined, grabNext: node.grabNext as string[], releaseNext: node.releaseNext as string[], embeddedStool: node.embeddedStool, settled: node.settled, restoreOnRelease: node.restoreOnRelease };
  }
  if (!Number.isFinite(elapsed)) throw new Error('Invalid sequence duration');
  return { id: data.id, gesture, canvas, frames, pages, durationMs: elapsed, entryPose, exitPose, geometryReference, loop, kind: typeof data.kind === 'string' ? data.kind : undefined, action: typeof data.action === 'string' ? data.action : undefined,
    stage: typeof data.stage === 'string' ? data.stage : undefined,
    reviewStatus: typeof data.reviewStatus === 'string' ? data.reviewStatus : undefined,
    warning: typeof data.warning === 'string' ? data.warning : undefined };
}
