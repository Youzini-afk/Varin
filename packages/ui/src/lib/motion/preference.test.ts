import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMotionLevel, isMotionPreference, resolveMotionLevel } from './preference';
import { currentMotionLevel, prefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useUIStore } from '@/stores/useUIStore';

afterEach(() => {
  vi.unstubAllGlobals();
  useUIStore.setState({ motionPreference: 'full' });
});

const stubSystemReduced = (matches: boolean) => vi.stubGlobal('window', {
  matchMedia: () => ({ matches, addEventListener() {}, removeEventListener() {} }),
});

describe('motion preference', () => {
  it('lowers full to reduced when the system asks for it, and keeps explicit choices', () => {
    expect(resolveMotionLevel('full', false)).toBe('full');
    expect(resolveMotionLevel('full', true)).toBe('reduced');
    expect(resolveMotionLevel('reduced', false)).toBe('reduced');
    expect(resolveMotionLevel('off', true)).toBe('off');
  });

  it('accepts only known values', () => {
    expect(isMotionPreference('reduced')).toBe(true);
    expect(isMotionPreference('none')).toBe(false);
    expect(isMotionPreference(undefined)).toBe(false);
  });

  it('writes the level CSS reads', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyMotionLevel('off', root);
    expect(root.dataset.motion).toBe('off');
  });

  it('makes existing reduced-motion readers follow the Appearance choice', () => {
    stubSystemReduced(false);
    expect(prefersReducedMotion()).toBe(false);
    useUIStore.getState().setMotionPreference('reduced');
    expect(currentMotionLevel()).toBe('reduced');
    expect(prefersReducedMotion()).toBe(true);
    useUIStore.getState().setMotionPreference('full');
    stubSystemReduced(true);
    expect(currentMotionLevel()).toBe('reduced');
  });
});
