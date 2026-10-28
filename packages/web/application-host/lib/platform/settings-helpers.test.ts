import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import { configuredVmProviders } from '../computer/vm-provider.js';
import { normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider } from '../tunnels/types.js';

// Use the real sanitizers as the Host does. Identity stubs used to hide whether
// a preference survived the composed write/read boundary.
const helpers = createSettingsHelpers({
  ...createSettingsNormalizationRuntime({ os: { homedir: () => '/home/testuser' }, path: path.posix,
    processLike: { platform: 'linux', env: {} }, realpathSync: value => value,
    tunnelBootstrapTtlDefaultMs: 600000, tunnelBootstrapTtlMinMs: 60000, tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000, tunnelSessionTtlMinMs: 3600000, tunnelSessionTtlMaxMs: 604800000,
  }),
  normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider,
});
const roundTrip = (update: Record<string, unknown>, current: Record<string, unknown> = {}) =>
  helpers.formatSettingsResponse(helpers.mergePersistedSettings(current, helpers.sanitizeSettingsUpdate(update)));
afterEach(() => vi.unstubAllEnvs());

it('preserves explicit false preferences instead of replacing them with defaults', () => {
  expect(helpers.formatSettingsResponse({})).toMatchObject({ showReasoningTraces: true, collapsibleThinkingBlocks: true });
  const flags = { showReasoningTraces: false, collapsibleThinkingBlocks: false, draftStartersVisible: false,
    desktopLanAccessEnabled: false, desktopKeepAwakeEnabled: false, desktopMinimizeToTrayEnabled: false,
    desktopMacMenuBarEnabled: false, serverPermissionAutoAcceptEnabled: false };
  expect(roundTrip(flags, { themeId: 'existing' })).toMatchObject({ ...flags, themeId: 'existing' });
  expect(helpers.sanitizeSettingsUpdate({ collapsibleThinkingBlocks: 'true', draftStartersVisible: 'false',
    desktopLanAccessEnabled: 1, serverPermissionAutoAcceptEnabled: 'true' })).toEqual({});
});

it('keeps user presentation and recovery choices through the composed settings boundary', () => {
  const choices = { motionPreference: 'off', recoveryPreference: 'both', messageStreamTransport: 'sse',
    mobileKeyboardMode: 'resize-content', desktopWindowControlsPosition: 'left', desktopWindowControlsStyle: 'traffic-lights' };
  expect(roundTrip(choices)).toMatchObject(choices);
  expect(helpers.sanitizeSettingsUpdate({ motionPreference: 'none', recoveryPreference: 'files', messageStreamTransport: 'websocket',
    mobileKeyboardMode: 'fixed-layout', desktopWindowControlsPosition: 'center', desktopWindowControlsStyle: 'macos' })).toEqual({});
  expect(roundTrip({ motionPreference: ' reduced ', mobileKeyboardMode: ' resize-content ' }))
    .toMatchObject({ motionPreference: 'reduced', mobileKeyboardMode: 'resize-content' });
});

it('preserves fill-pane width and custom dimensions without accepting malformed sizes', () => {
  for (const chatContentWidth of [0, 960, 1088, 2560]) expect(roundTrip({ chatContentWidth })).toMatchObject({ chatContentWidth });
  for (const chatContentWidth of [-1, 1.5, Infinity, NaN, '960', null, true]) {
    expect(helpers.sanitizeSettingsUpdate({ chatContentWidth })).toEqual({});
  }
});

it('keeps explicit empty selections and shortcut resets distinct from omitted changes', () => {
  expect(roundTrip({ activeProjectId: null, shortcutOverrides: {} }, { activeProjectId: 'workspace', shortcutOverrides: { new_chat: 'mod+n' } }))
    .toMatchObject({ activeProjectId: null, shortcutOverrides: {} });
  expect(roundTrip({ activeProjectId: 'workspace', shortcutOverrides: { new_chat: '__unassigned__', open_settings: 'mod+comma', invalid: 123, empty: '' } }))
    .toMatchObject({ activeProjectId: 'workspace', shortcutOverrides: { new_chat: '__unassigned__', open_settings: 'mod+comma' } });
});

it('normalizes shell selection without accepting an executable path or shell command', () => {
  expect(roundTrip({ terminalShell: ' ZSH ', terminalLoginShells: [' ZSH ', 'bash', 'zsh', '/bin/fish', 42] }))
    .toMatchObject({ terminalShell: 'zsh', terminalLoginShells: ['zsh', 'bash'] });
  expect(helpers.sanitizeSettingsUpdate({ terminalShell: 'zsh -c whoami' })).toEqual({});
  expect(helpers.sanitizeSettingsUpdate({ terminalShell: '/bin/zsh' })).toEqual({});
  expect(roundTrip({ terminalLoginShells: [] }, { terminalLoginShells: ['bash'] })).toMatchObject({ terminalLoginShells: [] });
});

it('preserves VM configuration through the consumer and allows explicitly clearing it', () => {
  const providers = [{ id: 'hv1', kind: 'libvirt', uri: 'qemu+ssh://host/system', storagePool: 'data' }];
  expect(configuredVmProviders(roundTrip({ computerVmProviders: providers }))).toEqual(providers);
  expect(roundTrip({ computerVmProviders: [] }, { computerVmProviders: providers })).toMatchObject({ computerVmProviders: [] });
});

it('keeps permission decisions boolean and allows clearing the desktop password', () => {
  expect(roundTrip({ permissionAutoAccept: { sessions: { root: true, child: false, invalid: 'true' } } }))
    .toMatchObject({ permissionAutoAccept: { sessions: { root: true, child: false }, revision: 0 } });
  expect(roundTrip({ desktopUiPassword: ' secret ' })).toMatchObject({ desktopUiPassword: 'secret' });
  expect(helpers.mergePersistedSettings({ desktopUiPassword: 'old' }, helpers.sanitizeSettingsUpdate({ desktopUiPassword: '' })))
    .toMatchObject({ desktopUiPassword: '' });
});

it('keeps local and remote speech preferences usable without reviving the retired WASM pipeline', () => {
  expect(roundTrip({ sttProvider: 'local', sttServerUrl: ' https://stt.example.test ', sttModel: ' whisper-large ',
    sttLocalModel: ' moonshine ', sttLanguage: ' en ', sttSilenceThresholdDb: -45.5, sttSilenceHoldMs: 1234.6, sttTranscribeOnStop: true }))
    .toMatchObject({ sttProvider: 'local', sttServerUrl: 'https://stt.example.test', sttModel: 'whisper-large',
      sttLocalModel: 'moonshine', sttLanguage: 'en', sttSilenceThresholdDb: -45.5, sttSilenceHoldMs: 1235, sttTranscribeOnStop: true });
  expect(roundTrip({ sttProvider: 'openai-compatible' })).toMatchObject({ sttProvider: 'openai-compatible' });
  expect(helpers.sanitizeSettingsUpdate({ sttProvider: 'wasm', wasmSttModel: 'moonshine' })).toEqual({});
});

it('projects actual desktop LAN availability separately from persisted intent', () => {
  vi.stubEnv('VARIN_RUNTIME', 'desktop'); vi.stubEnv('VARIN_DESKTOP_LAN_ACCESS_ACTIVE', 'false');
  vi.stubEnv('VARIN_DESKTOP_LAN_ACCESS_BLOCKED_REASON', 'missing-password');
  expect(roundTrip({ desktopLanAccessEnabled: true }))
    .toMatchObject({ desktopLanAccessEnabled: true, desktopLanAccessActive: false, desktopLanAccessBlockedReason: 'missing-password' });
});

it('retains previously dropped model-picker preferences together and supports clearing selections', () => {
  const preferences = { hiddenModels: [{ providerID: 'anthropic', modelID: 'claude-opus-4' }], collapsedModelProviders: ['anthropic'],
    recentAgents: ['build', 'plan'], recentEfforts: { 'anthropic/claude-opus-4': ['high', 'default'] },
    favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }], recentModels: [{ providerID: 'openai', modelID: 'gpt-5' }] };
  expect(roundTrip(preferences, { themeId: 'existing' })).toMatchObject({ ...preferences, themeId: 'existing' });
  expect(roundTrip({ hiddenModels: [], favoriteModels: [], collapsedModelProviders: [], recentAgents: [] }, preferences))
    .toMatchObject({ hiddenModels: [], favoriteModels: [], collapsedModelProviders: [], recentAgents: [] });
  expect(helpers.sanitizeSettingsUpdate({ hiddenModels: 'not-an-array', collapsedModelProviders: null, recentAgents: 42,
    recentEfforts: { 'anthropic/claude-opus-4': 'high', '': ['high'], empty: [123, ''] } })).toEqual({});
  expect(helpers.sanitizeSettingsUpdate({ hiddenModels: [{ providerID: 'anthropic' }, { modelID: 'gpt-5' }, null, { providerID: ' ', modelID: 'x' }] }))
    .toEqual({ hiddenModels: [] });
});
