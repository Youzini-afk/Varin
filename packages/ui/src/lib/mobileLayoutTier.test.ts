import { describe, expect, test } from 'vitest';

import { getMobileLayoutInfo } from './mobileLayoutTier';

describe('getMobileLayoutInfo', () => {
  test('classifies a portrait phone', () => {
    const info = getMobileLayoutInfo({
      width: 390,
      height: 844,
      deviceType: 'mobile',
      hasTouchInput: true,
    });

    expect(info.tier).toBe('phone-portrait');
    expect(info.prefersSidePanels).toBe(false);
  });

  test('classifies a landscape phone', () => {
    const info = getMobileLayoutInfo({
      width: 844,
      height: 390,
      deviceType: 'mobile',
      hasTouchInput: true,
    });

    expect(info.tier).toBe('phone-landscape');
    expect(info.isLandscape).toBe(true);
  });

  test('classifies tablet portrait by device type', () => {
    const info = getMobileLayoutInfo({
      width: 820,
      height: 1180,
      deviceType: 'tablet',
      hasTouchInput: true,
    });

    expect(info.tier).toBe('tablet-portrait');
    expect(info.prefersSidePanels).toBe(true);
  });

  test('classifies large touch layouts as tablet landscape', () => {
    const info = getMobileLayoutInfo({
      width: 1366,
      height: 1024,
      deviceType: 'desktop',
      hasTouchInput: true,
    });

    expect(info.tier).toBe('tablet-landscape');
    expect(info.isTabletLandscape).toBe(true);
  });
});
