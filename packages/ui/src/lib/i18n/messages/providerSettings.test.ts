import { describe, expect, test } from 'vitest';

import { settingsDict as enSettingsDict } from './en.settings';
import { settingsDict as zhSettingsDict } from './zh-CN.settings';

describe('provider settings messages', () => {
  test('marks custom provider token limits as optional', () => {
    expect(enSettingsDict['settings.providers.page.custom.placeholder.contextLimit']).toContain('optional');
    expect(enSettingsDict['settings.providers.page.custom.placeholder.outputLimit']).toContain('optional');
    expect(zhSettingsDict['settings.providers.page.custom.placeholder.contextLimit']).toContain('可选');
    expect(zhSettingsDict['settings.providers.page.custom.placeholder.outputLimit']).toContain('可选');
  });

  test('requires the custom provider ID without requiring model rows', () => {
    expect(enSettingsDict['settings.providers.page.toast.customProviderRequired']).toContain('Provider ID');
    expect(zhSettingsDict['settings.providers.page.toast.customProviderRequired']).toContain('提供商 ID');
  });
});
