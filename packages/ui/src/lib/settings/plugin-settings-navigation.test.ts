import { describe, expect, test } from 'vitest';
import {
  consumePluginSettingsTarget,
  requestPluginSettingsIntegration,
  requestPluginSettingsTarget,
} from './plugin-settings-navigation';

describe('plugin settings navigation', () => {
  test('hands a requested integration to the next plugin settings page once', () => {
    requestPluginSettingsIntegration('mcp');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'mcp',
      pluginId: 'pi-mcp-adapter',
    });

    requestPluginSettingsTarget('npm:pi-openai-codex-compat@0.0.7-alpha.0');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'openai-codex-compat',
      pluginId: 'npm:pi-openai-codex-compat@0.0.7-alpha.0',
    });

    requestPluginSettingsTarget('pi-observational-memory');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'observational-memory',
      pluginId: 'pi-observational-memory',
    });
    expect(consumePluginSettingsTarget()).toBeNull();
  });

  test('maps adapted packages and preserves unadapted provider ownership', () => {
    requestPluginSettingsTarget('npm:@varin/pi-mcp-adapter@2.29.0-varin.1');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'mcp',
      pluginId: 'npm:@varin/pi-mcp-adapter@2.29.0-varin.1',
    });
    requestPluginSettingsTarget('@cortexkit/pi-magic-context', 'agents');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'magic-context',
      pluginId: '@cortexkit/pi-magic-context',
      section: 'agents',
    });

    requestPluginSettingsTarget('example-agents', 'profiles', 'project:../example-agents');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: null,
      pluginId: 'example-agents',
      packageIdentity: 'project:../example-agents',
      section: 'profiles',
    });

    requestPluginSettingsTarget('pi-workspace-history');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: null,
      pluginId: 'pi-workspace-history',
    });
  });

  test('maps pi-lens to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:pi-lens@4.0.1');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'pi-lens',
      pluginId: 'npm:pi-lens@4.0.1',
    });
  });

  test('maps the scoped AFT package to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:@cortexkit/aft-pi@0.51.2');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'aft',
      pluginId: 'npm:@cortexkit/aft-pi@0.51.2',
    });
  });

  test('maps pi-hermes-memory to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:pi-hermes-memory@0.9.6');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'hermes-memory',
      pluginId: 'npm:pi-hermes-memory@0.9.6',
    });
  });

  test('maps pi-rtk-optimizer to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:pi-rtk-optimizer@0.9.0');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'rtk',
      pluginId: 'npm:pi-rtk-optimizer@0.9.0',
    });
  });
});
