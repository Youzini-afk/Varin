/** Shared artwork playback only. Never a Host or execution state machine. */
export function coverage(catalog, assets) {
  return catalog.states.map(state => ({ ...state, actions: state.requires.map(action => {
    const candidates = assets.filter(asset => asset.action === action);
    const accepted = candidates.filter(usable);
    return { action, status: accepted.length ? 'accepted' : candidates.length ? 'candidate' : 'missing', candidates: candidates.map(a => a.id) };
  }) }));
}

function usable(asset) {
  return asset && asset.reviewStatus === 'accepted' && asset.stage === 'motion-candidate'
    && asset.entryPose && asset.exitPose && asset.frames?.length;
}

/** Route only across explicitly authored, visually accepted pose matches. No implicit fade. */
export function route(current, target, assets) {
  if (!usable(target)) return { status: 'blocked', reason: 'Target is missing or not visually accepted', clips: [] };
  if (!current) return { status: 'ready', clips: [target.id] };
  if (!usable(current)) return { status: 'blocked', reason: 'Current material has no validated exit contract', clips: [] };
  if (!current.geometryReference || current.geometryReference !== target.geometryReference) {
    return { status: 'blocked', reason: 'Shared geometry reference missing or different; do not normalize whole-body proportions', clips: [] };
  }
  if (JSON.stringify(current.canvas) !== JSON.stringify(target.canvas)) {
    return { status: 'blocked', reason: 'Registered canvas mismatch; explicit registration required', clips: [] };
  }
  const bridges = assets.filter(a => usable(a) && a.kind === 'bridge' && a.geometryReference === current.geometryReference && JSON.stringify(a.canvas) === JSON.stringify(current.canvas));
  const queue = [{ pose: current.exitPose, clips: [] }], visited = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (node.pose === target.entryPose) return { status: 'ready', clips: [...node.clips, target.id] };
    if (visited.has(node.pose)) continue;
    visited.add(node.pose);
    for (const bridge of bridges) if (bridge.entryPose === node.pose) queue.push({ pose: bridge.exitPose, clips: [...node.clips, bridge.id] });
  }
  return { status: 'blocked', reason: 'No authored matching-pose connection; keep current drawing and report missing connection', clips: [] };
}

export function frameAt(asset, timeMs) {
  if (!asset.frames?.length) return null;
  const bounded = Math.max(0, Math.min(timeMs, asset.durationMs));
  return asset.frames.find(frame => bounded < frame.startMs + frame.durationMs) ?? asset.frames.at(-1);
}

/** Latest presentation request wins; it never sends application commands. */
export class CompanionPlayback {
  constructor(assets) { this.assets = assets; this.current = null; this.timeMs = 0; this.pending = null; this.path = []; this.blocker = null; this.hold = false; this.canDisplay = () => true; this.loading = null; this.nextStartMs = 0; }
  request(id, { urgent = false } = {}) {
    this.loading = null; this.nextStartMs = 0;
    if (this.current?.id === id) {
      this.pending = null; this.path = []; this.hold = false; this.blocker = null;
      return { status: 'ready', clips: [] };
    }
    this.pending = id;
    this.path = []; // Latest artistic intent wins, not application events.
    this.hold = false;
    return this.plan();
  }
  target() { return this.assets.find(a => a.id === this.pending); }
  /** Only explicitly authored safe drawings may exit before a clip's end. */
  leaveSafeDrawing() {
    if (!this.pending || !this.current) return false;
    const frame = frameAt(this.current, this.timeMs);
    const target = this.target();
    for (const pose of frame?.exitTo ?? []) {
      if (pose !== frame.pose) continue;
      const result = route({ ...this.current, exitPose: pose }, target, this.assets);
      if (result.status === 'ready' && result.clips[0] !== this.current.id) {
        this.path = [...result.clips]; this.blocker = null; this.advance(); return true;
      }
    }
    return false;
  }
  reverseIfAuthored() {
    const frame = this.current && frameAt(this.current, this.timeMs);
    const ref = frame?.motion?.reverseFrom;
    const reverse = ref && this.assets.find(a => a.id === ref.sequence && usable(a) && a.geometryReference === this.current.geometryReference && JSON.stringify(a.canvas) === JSON.stringify(this.current.canvas));
    const reverseFrame = reverse?.frames[ref.frameIndex];
    if (!reverseFrame || !frame.motion.renderedPixelSha256 || reverseFrame.motion?.renderedPixelSha256 !== frame.motion.renderedPixelSha256) return false;
    const forwardRoute = route(this.current, this.target(), this.assets);
    const reversedRoute = route(reverse, this.target(), this.assets);
    if (reversedRoute.status !== 'ready' || (forwardRoute.status === 'ready' && reversedRoute.clips.length >= forwardRoute.clips.length)) return false;
    // Start at the same actual pixels; never rewind or synthesize intermediate motion.
    this.path = [reverse.id, ...reversedRoute.clips]; this.nextStartMs = reverseFrame.startMs; this.blocker = null;
    this.advance();
    return true;
  }
  plan() {
    const result = route(this.current, this.target(), this.assets);
    this.blocker = result.status === 'blocked' ? result.reason : null;
    if (this.leaveSafeDrawing() || this.reverseIfAuthored()) return { status: 'ready', clips: [...this.path] };
    if (this.blocker) { this.hold = true; return result; }
    this.path = [...result.clips];
    if (!this.current || this.timeMs >= this.current.durationMs) this.advance();
    return result;
  }
  advance() {
    if (!this.path.length) return;
    const nextId = this.path[0];
    if (!this.canDisplay(nextId)) { this.loading = nextId; return false; }
    this.loading = null; this.path.shift();
    const next = this.assets.find(a => a.id === nextId);
    this.current = next; this.timeMs = this.nextStartMs; this.nextStartMs = 0; this.hold = false;
    if (next.id === this.pending) this.pending = null;
    return true;
  }
  tick(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('elapsedMs must be finite and non-negative');
    let remaining = elapsedMs;
    while (this.current && !this.hold && !this.loading && remaining > 0) {
      // Check every entered exposure, not only the final frame after a slow display tick.
      if (this.leaveSafeDrawing()) continue;
      const frame = frameAt(this.current, this.timeMs);
      const boundary = Math.min(this.current.durationMs, frame.startMs + frame.durationMs);
      const step = Math.min(remaining, Math.max(0, boundary - this.timeMs));
      this.timeMs += step; remaining -= step;
      if (this.timeMs < boundary) break;
      if (!this.path.length && !this.pending && Array.isArray(this.current.loop)) {
        const [first, end] = this.current.loop;
        const endFrame = this.current.frames[end - 1];
        const endMs = endFrame.startMs + endFrame.durationMs;
        if (this.timeMs >= endMs) {
          const startMs = this.current.frames[first].startMs;
          this.timeMs = startMs;
          // Whole hold cycles have no transitions; preserve the remainder without busy looping.
          remaining %= endMs - startMs;
          continue;
        }
      }
      if (this.timeMs >= this.current.durationMs) {
        if (this.path.length) this.advance();
        else break;
      }
    }
  }
}

// Existing offline reviewers share the same implementation.
export { CompanionPlayback as ReviewPlayback };
