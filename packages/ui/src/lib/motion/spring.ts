import { requestFrame, type FrameHandle } from './frame';
import { SPRINGS, springCoefficients, type SpringCoefficients, type SpringToken } from './tokens';

/**
 * A frame-driven spring for values motion components cannot own, such as a
 * scroll position that a virtual list also reads and writes. The target can
 * move every frame; the value carries its velocity into each new target.
 */
export interface SpringState {
  position: number;
  velocity: number;
}

/** Critically damped at `zeta = 1`: the fastest approach without overshoot. */
export const omegaSpring = (omega: number, zeta = 1): SpringCoefficients => ({
  stiffness: omega * omega,
  damping: 2 * zeta * omega,
});

export const tokenSpring = (token: SpringToken): SpringCoefficients => springCoefficients(SPRINGS[token]);

const SUBSTEP_SECONDS = 0.004;
/** A long frame (or a hidden tab) is integrated as this much time at most. */
export const MAX_FRAME_SECONDS = 0.05;
const FIRST_FRAME_SECONDS = 1 / 60;

/** Semi-implicit Euler in 4ms substeps; stable for every token stiffness. */
export function stepSpring(
  state: SpringState,
  target: number,
  { stiffness, damping }: SpringCoefficients,
  seconds: number,
): SpringState {
  const elapsed = Math.min(Math.max(0, seconds), MAX_FRAME_SECONDS);
  const steps = Math.max(1, Math.ceil(elapsed / SUBSTEP_SECONDS));
  const step = elapsed / steps;
  let { position, velocity } = state;
  for (let index = 0; index < steps; index += 1) {
    velocity += (-stiffness * (position - target) - damping * velocity) * step;
    position += velocity * step;
  }
  return { position, velocity };
}

export const springAtRest = (
  state: SpringState,
  target: number,
  restDelta: number,
  restSpeed: number,
): boolean => Math.abs(state.position - target) < restDelta && Math.abs(state.velocity) < restSpeed;

type Frame = FrameHandle;

const stepListeners = new Set<() => void>();

/**
 * Called after any spring has written its value for this frame. Code that
 * follows something a spring moves, such as a message flying onto a row the
 * timeline scroll spring is carrying, reads it here in the same frame instead
 * of one frame late.
 */
export function onSpringStep(listener: () => void): () => void {
  stepListeners.add(listener);
  return () => { stepListeners.delete(listener); };
}

export interface SpringDriverOptions {
  value?: number;
  spring: SpringCoefficients;
  /** Distance from the target that counts as arrived. */
  restDelta?: number;
  /** Speed (units per second) that counts as stopped. */
  restSpeed?: number;
  /** Called once per frame with the new value, and on `jump`. */
  onUpdate: (value: number) => void;
  /** Called when the value comes to rest at its target. */
  onRest?: (value: number) => void;
}

export class SpringDriver {
  private state: SpringState;
  private goal: number;
  private coefficients: SpringCoefficients;
  private readonly restDelta: number;
  private readonly restSpeed: number;
  private readonly onUpdate: (value: number) => void;
  private readonly onRest?: (value: number) => void;
  private frame: Frame | null = null;
  private lastTime: number | null = null;

  constructor(options: SpringDriverOptions) {
    const value = options.value ?? 0;
    this.state = { position: value, velocity: 0 };
    this.goal = value;
    this.coefficients = options.spring;
    this.restDelta = options.restDelta ?? 0.5;
    this.restSpeed = options.restSpeed ?? 4;
    this.onUpdate = options.onUpdate;
    this.onRest = options.onRest;
  }

  get value(): number { return this.state.position; }
  get velocity(): number { return this.state.velocity; }
  get target(): number { return this.goal; }
  get active(): boolean { return this.frame !== null; }

  configure(spring: SpringCoefficients): this {
    this.coefficients = spring;
    return this;
  }

  /** Move toward `target`, keeping the current velocity. */
  to(target: number): void {
    this.goal = target;
    if (this.frame) return;
    this.lastTime = null;
    this.frame = requestFrame(this.tick);
  }

  /** Place the value without motion and notify `onUpdate`. */
  jump(value: number): void {
    this.halt();
    this.state = { position: value, velocity: 0 };
    this.goal = value;
    this.onUpdate(value);
  }

  /** Adopt an externally changed value while at rest. */
  sync(value: number): void {
    if (this.active) return;
    this.state = { position: value, velocity: 0 };
    this.goal = value;
  }

  /** Move value and target together, e.g. when the content under a scroll shifts. */
  shift(delta: number): void {
    this.state = { ...this.state, position: this.state.position + delta };
    this.goal += delta;
  }

  /** Stop where the value is now. */
  stop(): void {
    this.halt();
    this.state = { position: this.state.position, velocity: 0 };
    this.goal = this.state.position;
  }

  private halt(): void {
    this.frame?.cancel();
    this.frame = null;
    this.lastTime = null;
  }

  private tick = (time: number): void => {
    const seconds = this.lastTime === null ? FIRST_FRAME_SECONDS : (time - this.lastTime) / 1000;
    this.lastTime = time;
    const next = stepSpring(this.state, this.goal, this.coefficients, seconds);
    const resting = springAtRest(next, this.goal, this.restDelta, this.restSpeed);
    this.state = resting ? { position: this.goal, velocity: 0 } : next;
    // Keep the frame marked active while notifying, so `stop()` inside the
    // callback cancels the next frame instead of racing it.
    this.frame = { cancel: () => undefined };
    this.onUpdate(this.state.position);
    for (const listener of stepListeners) listener();
    if (!this.frame) return;
    // `onUpdate` may have moved the target; only a still-reached target rests.
    if (resting && springAtRest(this.state, this.goal, this.restDelta, this.restSpeed)) {
      this.frame = null;
      this.lastTime = null;
      this.onRest?.(this.state.position);
      return;
    }
    this.frame = requestFrame(this.tick);
  };
}
