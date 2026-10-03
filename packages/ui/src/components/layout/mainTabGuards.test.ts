import { describe, expect, test } from 'vitest';
import { shouldResetDesktopMainTabToChat } from './mainTabGuards';

describe('desktop main tab guard', () => {
  test('keeps dedicated desktop overlay tabs open', () => {
    expect(shouldResetDesktopMainTabToChat('terminal', false)).toBe(false);
    expect(shouldResetDesktopMainTabToChat('diagram', false)).toBe(false);
  });

  test('keeps mobile tabs under the mobile tab system', () => {
    expect(shouldResetDesktopMainTabToChat('git', true)).toBe(false);
  });

  test('still resets desktop tabs that are not exposed in the desktop header', () => {
    expect(shouldResetDesktopMainTabToChat('git', false)).toBe(true);
    expect(shouldResetDesktopMainTabToChat('files', false)).toBe(true);
    expect(shouldResetDesktopMainTabToChat('diff', false)).toBe(true);
    expect(shouldResetDesktopMainTabToChat('context', false)).toBe(true);
  });
});
