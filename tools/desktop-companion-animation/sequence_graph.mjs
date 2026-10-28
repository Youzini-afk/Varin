/** Offline production reviewer, not a Host or task-state machine. */
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
export class ReviewPlayback {
  constructor(assets) { this.assets = assets; this.current = null; this.timeMs = 0; this.pending = null; this.path = []; this.blocker = null; this.hold = false; }
  request(id, { urgent = false } = {}) {
    if (this.current?.id === id && !this.pending) return { status: 'ready', clips: [] };
    this.pending = id;
    this.path = []; // Discard stale queued artistic responses, not application events.
    if (urgent) this.hold = true; // Freeze decorative movement; never fake a safe contact transition.
    return this.plan();
  }
  plan() {
    const target = this.assets.find(a => a.id === this.pending);
    const result = route(this.current, target, this.assets);
    this.blocker = result.status === 'blocked' ? result.reason : null;
    if (!this.blocker) {
      if (this.hold && this.current && this.timeMs < this.current.durationMs) {
        const frame = frameAt(this.current, this.timeMs);
        if (frame.pose !== this.current.exitPose) {
          this.blocker = 'Urgent response has no authored exit at the held pose';
          return { status: 'blocked', reason: this.blocker, clips: [] };
        }
        this.timeMs = this.current.durationMs;
      }
      this.path = result.clips;
      if (!this.current || this.timeMs >= this.current.durationMs) this.advance();
    }
    return result;
  }
  advance() {
    if (!this.path.length) return;
    const next = this.assets.find(a => a.id === this.path.shift());
    this.current = next; this.timeMs = 0; this.hold = false;
    if (next.id === this.pending) this.pending = null;
  }
  tick(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('elapsedMs must be finite and non-negative');
    if (!this.current || this.hold) return;
    let nextTime = this.timeMs + elapsedMs;
    if (!this.path.length && !this.pending && Array.isArray(this.current.loop)) {
      const [first, end] = this.current.loop;
      const startMs = this.current.frames[first].startMs;
      const endFrame = this.current.frames[end - 1];
      const endMs = endFrame.startMs + endFrame.durationMs;
      if (nextTime >= endMs) nextTime = startMs + (nextTime - startMs) % (endMs - startMs);
    }
    this.timeMs = Math.min(this.current.durationMs, nextTime);
    if (this.timeMs >= this.current.durationMs && this.path.length) this.advance();
  }
}
