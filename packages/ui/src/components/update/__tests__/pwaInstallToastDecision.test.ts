import { describe, expect, test } from 'vitest';
import { shouldShowPwaInstallToast } from '../pwaInstallToastDecision';

describe('shouldShowPwaInstallToast', () => {
  test('returns true when nothing blocks the toast', () => {
    expect(shouldShowPwaInstallToast({
      dismissed: null,
      sessionShown: null,
      hasActiveToast: false,
    })).toBe(true);
  });

  test('honors persistent, session, and active-toast deduplication', () => {
    expect(shouldShowPwaInstallToast({
      dismissed: 'true',
      sessionShown: null,
      hasActiveToast: false,
    })).toBe(false);
    expect(shouldShowPwaInstallToast({
      dismissed: null,
      sessionShown: 'true',
      hasActiveToast: false,
    })).toBe(false);
    expect(shouldShowPwaInstallToast({
      dismissed: null,
      sessionShown: null,
      hasActiveToast: true,
    })).toBe(false);
  });

  test('treats non-true storage values as unset', () => {
    expect(shouldShowPwaInstallToast({
      dismissed: 'false',
      sessionShown: '0',
      hasActiveToast: false,
    })).toBe(true);
  });
});
