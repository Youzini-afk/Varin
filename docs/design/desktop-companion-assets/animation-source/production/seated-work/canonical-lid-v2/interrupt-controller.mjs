/** Source-exposure controller. Deliberately no browser, image decoding or fixed FPS assumption. */
export class LidPlayback {
  constructor(sequences, id) {
    this.sequences = new Map(sequences.map(s => [s.id, s]));
    this.sequence = this.sequences.get(id);
    if (!this.sequence) throw new Error(`Unknown lid sequence: ${id}`);
    this.index = 0; this.elapsed = 0; this.finished = false;
  }
  get frame() { return this.sequence.frames[this.index]; }
  get canDrag() { return this.frame.motion?.safeEndpoint === true && this.frame.motion.gripContact === 'closed-lid-rest'; }
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Nonnegative finite delta required');
    this.elapsed += ms;
    while (!this.finished && this.elapsed >= this.frame.durationMs) {
      this.elapsed -= this.frame.durationMs;
      if (this.index + 1 < this.sequence.frames.length) this.index++;
      else { this.finished = true; this.elapsed = 0; }
    }
    return this.frame;
  }
  reverse() {
    const before = this.frame, ref = before.motion?.reverseFrom;
    const next = ref && this.sequences.get(ref.sequence);
    const target = next?.frames[ref.frameIndex];
    if (!target || target.motion.renderedPixelSha256 !== before.motion.renderedPixelSha256)
      throw new Error('No exact-pixel supported reverse entry');
    this.sequence = next; this.index = ref.frameIndex;
    // Preserve the visible exposure; use the reverse exposure's own dwell from now.
    this.elapsed = 0; this.finished = false;
    return this.frame;
  }
  requestClosed() {
    if (this.canDrag) return 'ready';
    if (this.sequence.exitPose !== 'seated-closed-neutral-rest') this.reverse();
    return 'settling';
  }
}
