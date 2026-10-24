import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_SECONDS, SpringDriver, omegaSpring, springAtRest, stepSpring, tokenSpring } from './spring';
import { springCoefficients, SPRINGS } from './tokens';

const FRAME = 1 / 60;

function run(target: (t: number) => number, seconds: number, omega = 14) {
  let state = { position: 0, velocity: 0 };
  let peak = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    state = stepSpring(state, target(t), omegaSpring(omega), FRAME);
    peak = Math.max(peak, state.position);
  }
  return { state, peak };
}

describe('stepSpring', () => {
  it('approaches a fixed target without overshoot when critically damped', () => {
    const { state, peak } = run(() => 400, 0.7);
    expect(peak).toBeLessThanOrEqual(400);
    expect(400 - state.position).toBeLessThan(0.5);
  });

  it('trails a steadily moving target by 2v/ω', () => {
    const speed = 210;
    const { state } = run(t => speed * t, 2);
    const lag = speed * 2 - state.position;
    expect(lag).toBeGreaterThan(speed * 2 / 14 - 4);
    expect(lag).toBeLessThan(speed * 2 / 14 + 4);
  });

  it('integrates a long frame as at most MAX_FRAME_SECONDS', () => {
    const coefficients = omegaSpring(14);
    const long = stepSpring({ position: 0, velocity: 0 }, 100, coefficients, 2);
    const capped = stepSpring({ position: 0, velocity: 0 }, 100, coefficients, MAX_FRAME_SECONDS);
    expect(long.position).toBeCloseTo(capped.position, 6);
  });

  it('uses the shared token coefficients', () => {
    expect(tokenSpring('travel')).toEqual(springCoefficients(SPRINGS.travel));
    expect(springAtRest({ position: 99.8, velocity: 1 }, 100, 0.5, 4)).toBe(true);
    expect(springAtRest({ position: 99.8, velocity: 9 }, 100, 0.5, 4)).toBe(false);
  });
});

describe('SpringDriver', () => {
  let frames = new Map<number, (time: number) => void>();
  let nextId = 0;
  let now = 0;
  const flush = (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      now += 1000 / 60;
      const pending = [...frames.values()];
      frames = new Map();
      for (const frame of pending) frame(now);
    }
  };

  beforeEach(() => {
    frames = new Map();
    nextId = 0;
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      nextId += 1;
      frames.set(nextId, callback);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames.delete(handle); });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves toward a retargeted value and rests there once', () => {
    const values: number[] = [];
    const rest = vi.fn();
    const spring = new SpringDriver({ spring: omegaSpring(14), onUpdate: value => values.push(value), onRest: rest });
    spring.to(200);
    flush(10);
    expect(spring.active).toBe(true);
    spring.to(300);
    flush(80);
    expect(rest).toHaveBeenCalledTimes(1);
    expect(spring.value).toBe(300);
    expect(spring.active).toBe(false);
    // Monotonic: following a growing target never scrolls backwards.
    expect(values.every((value, index) => index === 0 || value >= values[index - 1]!)).toBe(true);
  });

  it('stops from inside its own update without scheduling another frame', () => {
    const spring: SpringDriver = new SpringDriver({ spring: omegaSpring(14), onUpdate: value => { if (value > 50) spring.stop(); } });
    spring.to(400);
    flush(40);
    expect(spring.active).toBe(false);
    expect(frames.size).toBe(0);
    expect(spring.target).toBe(spring.value);
  });

  it('carries an external shift without losing the remaining distance', () => {
    const spring = new SpringDriver({ spring: omegaSpring(14), onUpdate: () => undefined });
    spring.to(100);
    flush(5);
    const remaining = spring.target - spring.value;
    spring.shift(40);
    expect(spring.target).toBe(140);
    expect(spring.target - spring.value).toBeCloseTo(remaining, 6);
  });

  it('jumps and syncs without motion', () => {
    const update = vi.fn();
    const spring = new SpringDriver({ spring: omegaSpring(14), onUpdate: update });
    spring.jump(80);
    expect(update).toHaveBeenCalledWith(80);
    spring.sync(120);
    expect(spring.value).toBe(120);
    expect(spring.active).toBe(false);
  });
});
