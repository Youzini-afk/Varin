import { describe, expect, test } from 'vitest';

import { detectHostedSurface } from './hostedSurface';

const mobileIframeInput = {
  innerWidth: 420,
  screenWidth: 420,
  maxTouchPoints: 5,
  isCoarsePointer: true,
  mobileLayoutPreference: 'new' as const,
};

describe('detectHostedSurface', () => {
  test('forces embedded session chat to desktop even in a narrow touch iframe', () => {
    expect(detectHostedSurface({
      ...mobileIframeInput,
      search: '?piPanel=session-chat&piSessionId=child-123&piDirectory=%2Ftmp%2Fproject',
    })).toBe('desktop');
  });

  test('embedded session chat wins over a mobile surface override', () => {
    expect(detectHostedSurface({
      ...mobileIframeInput,
      search: '?surface=mobile&piPanel=session-chat&piSessionId=child-123',
    })).toBe('desktop');
  });

  test('keeps normal mobile detection for non-embedded pages', () => {
    expect(detectHostedSurface({
      ...mobileIframeInput,
      search: '',
    })).toBe('mobile');
  });

  test('uses the mobile surface for coarse-pointer tablets', () => {
    expect(detectHostedSurface({
      search: '',
      innerWidth: 1024,
      screenWidth: 1024,
      maxTouchPoints: 5,
      isCoarsePointer: true,
      mobileLayoutPreference: 'new',
    })).toBe('mobile');
  });

  test('keeps fine-pointer touch laptops on the desktop surface', () => {
    expect(detectHostedSurface({
      search: '',
      innerWidth: 1024,
      screenWidth: 1024,
      maxTouchPoints: 10,
      isCoarsePointer: false,
      mobileLayoutPreference: 'new',
    })).toBe('desktop');
  });
});
