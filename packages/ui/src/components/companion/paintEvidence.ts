/** Read-only observations of successful production painter/decoder commits.
 * The last paint receipt is retained even before observation, so an already
 * painted static pose does not need to be replayed to establish readiness. */
export function createCompanionPaintEvidence() {
  type Package = { id: string; frames: readonly unknown[] };
  type Paint = { epoch: string | null; packageId: string; frame: number; at: number };
  let epoch: string | null = null, enabled = false, startedAt: number | null = null;
  let paints = 0, closed = false, releases = 0, lastSuccessfulPaint: Paint | null = null;
  const decoded = new Map<string, { width: number; height: number }>(), live = new Set<string>();
  const expected = new Map<string, number>(), painted = new Map<string, Set<number>>();
  const initialize = () => { paints = 0; releases = 0; live.clear(); decoded.clear(); painted.clear(); };
  return {
    enable() {
      if (!enabled && !closed) { enabled = true; startedAt = performance.now(); initialize(); }
      return { enabled, startedAt, startupHistory: 'not-observed-before-enable' };
    },
    reset(identity: string, packages: readonly Package[]) {
      epoch = identity; closed = false; lastSuccessfulPaint = null; expected.clear();
      for (const item of packages) expected.set(item.id, item.frames.length);
      initialize();
      if (enabled) startedAt = performance.now();
    },
    decoded(file: string, width: number, height: number) {
      if (enabled && !closed && width > 0 && height > 0) { decoded.set(file, { width, height }); live.add(file); }
    },
    released(file: string) { if (enabled && live.delete(file)) releases++; },
    painted(id: string, frame: number) {
      if (closed || !Number.isInteger(frame) || frame < 0 || frame >= (expected.get(id) ?? 0)) return;
      lastSuccessfulPaint = { epoch, packageId: id, frame, at: performance.now() };
      if (!enabled) return;
      const frames = painted.get(id) ?? new Set<number>(); frames.add(frame); painted.set(id, frames); paints++;
    },
    close() { closed = true; },
    snapshot() {
      return { enabled, startedAt, startupHistory: 'not-observed-before-enable', preObservationLiveBitmaps: 'unknown', epoch, paints, closed, releases,
        lastSuccessfulPaint: lastSuccessfulPaint ? { ...lastSuccessfulPaint, source: 'original-painter-successful-commit' } : null,
        observedLiveBitmaps: live.size, decoded: [...decoded].map(([file, size]) => ({ file, ...size })),
        packages: [...expected].map(([id, frames]) => ({ id, expectedFrames: frames, paintedFrames: painted.get(id)?.size ?? 0 })),
        notCovered: [...expected.keys()].filter(id => !painted.has(id)) };
    },
  };
}
