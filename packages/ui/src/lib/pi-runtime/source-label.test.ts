import { describe, expect, test } from 'vitest';
import { piRuntimeSourceLabelKey } from './source-label';

describe('piRuntimeSourceLabelKey', () => {
  test('maps each installation source to a dedicated label key', () => {
    expect(piRuntimeSourceLabelKey('system')).toBe('onboarding.localSetup.runtime.source.system');
    expect(piRuntimeSourceLabelKey('standalone')).toBe('onboarding.localSetup.runtime.source.standalone');
    expect(piRuntimeSourceLabelKey('custom')).toBe('onboarding.localSetup.runtime.source.custom');
    expect(piRuntimeSourceLabelKey('development')).toBe('onboarding.localSetup.runtime.source.development');
    expect(piRuntimeSourceLabelKey('bundled')).toBe('onboarding.localSetup.runtime.source.bundled');
  });
});
