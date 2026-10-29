import { requestFrame, type FrameHandle } from './frame';

/** Long navigation crosses only the viewport, without cloning live HTML or capturing the whole app. */
export class ScrollTravel {
  private animation: Animation | undefined;
  private frame: FrameHandle | undefined;
  private generation = 0;
  private running = false;
  constructor(private readonly viewport: HTMLElement) {}
  get active(): boolean { return this.running; }

  stop(): void {
    ++this.generation;
    this.running = false;
    this.frame?.cancel(); this.frame = undefined;
    this.animation?.cancel(); this.animation = undefined;
  }

  start(place: () => void): void {
    this.stop();
    const generation = this.generation;
    this.running = true;
    const leave = this.viewport.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-12px)' }],
      { duration: 90, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    this.animation = leave;
    void leave.finished.then(() => {
      if (generation !== this.generation) return;
      place();
      // The destination's virtual rows get their layout turn before they enter.
      this.frame = requestFrame(() => {
        this.frame = undefined;
        if (generation !== this.generation) return;
        leave.cancel();
        const arrive = this.viewport.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
        this.animation = arrive;
        void arrive.finished.then(() => { if (generation === this.generation) this.stop(); }, () => undefined);
      });
    }, () => undefined);
  }
}
