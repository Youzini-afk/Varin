import { isChatContentWidth } from '@varin/application-client';
import { normalizeOutboundNetwork } from '../harness/egress-settings.js';

export type SettingsRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is SettingsRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export interface SettingsHelpersDependencies {
  normalizePathForPersistence(value: unknown): unknown;
  normalizeDirectoryPath?: ((value: unknown) => unknown) | undefined;
  normalizeTunnelBootstrapTtlMs(value: number): number | null;
  normalizeTunnelSessionTtlMs(value: number): number;
  normalizeTunnelProvider(value: string): unknown;
  normalizeTunnelMode(value: string): unknown;
  normalizeOptionalPath(value: string): unknown;
  normalizeManagedRemoteTunnelHostname(value: unknown): unknown;
  normalizeManagedRemoteTunnelPresets(value: unknown): unknown;
  normalizeManagedRemoteTunnelPresetTokens(value: unknown): unknown;
  sanitizeTypographySizesPartial(value: unknown): unknown;
  normalizeStringArray(value: unknown): string[];
  sanitizeModelRefs(value: unknown, limit: number): unknown;
  sanitizeSkillCatalogs(value: unknown): unknown;
  sanitizeProjects(value: unknown): unknown;
}

export const createSettingsHelpers = (dependencies: SettingsHelpersDependencies) => {
  const {
    normalizePathForPersistence,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    sanitizeTypographySizesPartial,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  } = dependencies;

  const PWA_APP_NAME_MAX_LENGTH = 64;
  const STT_SERVER_URL_MAX_LENGTH = 2048;
  const STT_MODEL_MAX_LENGTH = 256;
  const STT_LANGUAGE_MAX_LENGTH = 64;
  const SHORTCUT_OVERRIDE_KEY_MAX_LENGTH = 128;
  const SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH = 128;
  const PWA_ORIENTATION_VALUES = new Set(['system', 'portrait', 'landscape']);
  const MOBILE_KEYBOARD_MODE_VALUES = new Set(['native', 'resize-content']);
  const TERMINAL_SHELL_VALUES = new Set(['auto', 'bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu']);
  const HIDDEN_MODELS_MAX = 1024;
  const RECENT_EFFORTS_MAX_KEYS = 128;
  const RECENT_EFFORTS_MAX_VARIANTS_PER_KEY = 5;

  const sanitizeShortcutOverrides = (value: unknown): Record<string, string> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const result: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      const combo = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!key || !combo) continue;
      result[key.slice(0, SHORTCUT_OVERRIDE_KEY_MAX_LENGTH)] = combo.slice(0, SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH);
    }
    return result;
  };

  const sanitizeRecentEfforts = (value: unknown): Record<string, string[]> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const result: Record<string, string[]> = {};
    const seenKeys = new Set<string>();
    let count = 0;
    for (const [rawKey, rawVariants] of Object.entries(value)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!key || seenKeys.has(key)) continue;
      if (!Array.isArray(rawVariants)) continue;
      const variants: string[] = [];
      const seenVariants = new Set<string>();
      for (const rawVariant of rawVariants) {
        const variant = typeof rawVariant === 'string' ? rawVariant.trim() : '';
        if (!variant || seenVariants.has(variant)) continue;
        seenVariants.add(variant);
        variants.push(variant);
        if (variants.length >= RECENT_EFFORTS_MAX_VARIANTS_PER_KEY) break;
      }
      if (variants.length === 0) continue;
      seenKeys.add(key);
      result[key] = variants;
      count += 1;
      if (count >= RECENT_EFFORTS_MAX_KEYS) break;
    }
    return count > 0 ? result : null;
  };

  const normalizePwaAppName = (
    value: unknown,
    fallback: string | undefined = '',
  ): string | undefined => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, PWA_APP_NAME_MAX_LENGTH);
  };

  const normalizePwaOrientation = (
    value: unknown,
    fallback: string | undefined = 'system',
  ): string | undefined => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim();
    if (PWA_ORIENTATION_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const normalizeMobileKeyboardMode = (
    value: unknown,
    fallback: string | null | undefined = 'native',
  ): string | null | undefined => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim();
    if (MOBILE_KEYBOARD_MODE_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const sanitizeSettingsUpdate = (payload: unknown): SettingsRecord => {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const candidate = payload as SettingsRecord;
    const result: SettingsRecord = {};

    if (candidate.computerVmProviders !== undefined) {
      if (!Array.isArray(candidate.computerVmProviders)) throw new Error('computerVmProviders must be an array');
      const ids = new Set<string>();
      result.computerVmProviders = candidate.computerVmProviders.map((value) => {
        if (!value || typeof value !== 'object') throw new Error('Invalid computer VM provider');
        const provider = value as Record<string, unknown>;
        if (typeof provider.id !== 'string' || !provider.id.trim() || provider.kind !== 'libvirt'
          || typeof provider.uri !== 'string' || !provider.uri.trim() || ids.has(provider.id.trim())) {
          throw new Error('VM providers require a unique id, libvirt kind and connection URI');
        }
        ids.add(provider.id.trim());
        return {
          id: provider.id.trim(), kind: 'libvirt', uri: provider.uri.trim(),
          ...Object.fromEntries(['label', 'storagePool', 'network'].flatMap((key) =>
            typeof provider[key] === 'string' && provider[key].trim() ? [[key, provider[key].trim()]] : [])),
        };
      });
    }

    if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
      result.themeId = candidate.themeId;
    }
    if (typeof candidate.themeVariant === 'string' && (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')) {
      result.themeVariant = candidate.themeVariant;
    }
    if (typeof candidate.useSystemTheme === 'boolean') {
      result.useSystemTheme = candidate.useSystemTheme;
    }
    if (typeof candidate.lightThemeId === 'string' && candidate.lightThemeId.length > 0) {
      result.lightThemeId = candidate.lightThemeId;
    }
    if (typeof candidate.darkThemeId === 'string' && candidate.darkThemeId.length > 0) {
      result.darkThemeId = candidate.darkThemeId;
    }
    if (typeof candidate.splashBgLight === 'string' && candidate.splashBgLight.trim().length > 0) {
      result.splashBgLight = candidate.splashBgLight.trim();
    }
    if (typeof candidate.splashFgLight === 'string' && candidate.splashFgLight.trim().length > 0) {
      result.splashFgLight = candidate.splashFgLight.trim();
    }
    if (typeof candidate.splashBgDark === 'string' && candidate.splashBgDark.trim().length > 0) {
      result.splashBgDark = candidate.splashBgDark.trim();
    }
    if (typeof candidate.splashFgDark === 'string' && candidate.splashFgDark.trim().length > 0) {
      result.splashFgDark = candidate.splashFgDark.trim();
    }
    if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
      const normalized = normalizePathForPersistence(candidate.lastDirectory);
      if (typeof normalized === 'string' && normalized.length > 0) {
        result.lastDirectory = normalized;
      }
    }
    if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
      const normalized = normalizePathForPersistence(candidate.homeDirectory);
      if (typeof normalized === 'string' && normalized.length > 0) {
        result.homeDirectory = normalized;
      }
    }

    if (typeof candidate.desktopLanAccessEnabled === 'boolean') {
      result.desktopLanAccessEnabled = candidate.desktopLanAccessEnabled;
    }
    if (candidate.outboundNetwork !== undefined) {
      result.outboundNetwork = normalizeOutboundNetwork(candidate.outboundNetwork);
    }
    if (typeof candidate.desktopKeepAwakeEnabled === 'boolean') {
      result.desktopKeepAwakeEnabled = candidate.desktopKeepAwakeEnabled;
    }
    if (typeof candidate.desktopMinimizeToTrayEnabled === 'boolean') {
      result.desktopMinimizeToTrayEnabled = candidate.desktopMinimizeToTrayEnabled;
    }
    if (typeof candidate.desktopMacMenuBarEnabled === 'boolean') {
      result.desktopMacMenuBarEnabled = candidate.desktopMacMenuBarEnabled;
    }
    if (typeof candidate.desktopWindowControlsPosition === 'string') {
      const mode = candidate.desktopWindowControlsPosition.trim();
      if (mode === 'right') {
        result.desktopWindowControlsPosition = 'right';
      } else if (mode === 'left') {
        result.desktopWindowControlsPosition = 'left';
      }
    }
    if (typeof candidate.desktopWindowControlsStyle === 'string') {
      const style = candidate.desktopWindowControlsStyle.trim();
      if (style === 'classic' || style === 'traffic-lights') {
        result.desktopWindowControlsStyle = style;
      }
    }
    if (candidate.permissionAutoAccept && typeof candidate.permissionAutoAccept === 'object' && !Array.isArray(candidate.permissionAutoAccept)) {
      const permissionAutoAccept = candidate.permissionAutoAccept as SettingsRecord;
      const sessions: Record<string, boolean> = {};
      const sourceSessions = permissionAutoAccept.sessions;
      if (sourceSessions && typeof sourceSessions === 'object' && !Array.isArray(sourceSessions)) {
        for (const [sessionId, enabled] of Object.entries(sourceSessions)) {
          if (sessionId && typeof enabled === 'boolean') sessions[sessionId] = enabled;
        }
      }
      result.permissionAutoAccept = {
        sessions,
        revision: Number.isSafeInteger(permissionAutoAccept.revision)
          && (permissionAutoAccept.revision as number) >= 0
          ? permissionAutoAccept.revision
          : 0,
      };
    }
    if (typeof candidate.desktopUiPassword === 'string') {
      result.desktopUiPassword = candidate.desktopUiPassword.trim();
    }
    if (Array.isArray(candidate.projects)) {
      const projects = sanitizeProjects(candidate.projects);
      if (projects) {
        result.projects = projects;
      }
    }
    if (typeof candidate.activeProjectId === 'string' && candidate.activeProjectId.length > 0) {
      result.activeProjectId = candidate.activeProjectId;
    } else if (candidate.activeProjectId === null) {
      result.activeProjectId = null;
    }

    if (Array.isArray(candidate.securityScopedBookmarks)) {
      result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
    }
    if (Array.isArray(candidate.pinnedDirectories)) {
      result.pinnedDirectories = normalizeStringArray(
        candidate.pinnedDirectories
          .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => typeof entry === 'string' && entry.length > 0)
      );
    }
    if (Array.isArray(candidate.draftStarters)) {
      const seenStarters = new Set();
      const starters = [];
      for (const entry of candidate.draftStarters) {
        if (!entry || typeof entry !== 'object') continue;
        const type = entry.type === 'command' || entry.type === 'skill' ? entry.type : null;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!type || !name) continue;
        const key = `${type}:${name}`;
        if (seenStarters.has(key)) continue;
        seenStarters.add(key);
        starters.push({ type, name });
      }
      result.draftStarters = starters;
    }
    if (typeof candidate.draftStartersVisible === 'boolean') {
      result.draftStartersVisible = candidate.draftStartersVisible;
    }
    if (typeof candidate.uiFont === 'string' && candidate.uiFont.length > 0) {
      result.uiFont = candidate.uiFont;
    }
    if (typeof candidate.monoFont === 'string' && candidate.monoFont.length > 0) {
      result.monoFont = candidate.monoFont;
    }
    if (typeof candidate.markdownDisplayMode === 'string' && candidate.markdownDisplayMode.length > 0) {
      result.markdownDisplayMode = candidate.markdownDisplayMode;
    }
    if (typeof candidate.githubClientId === 'string') {
      const trimmed = candidate.githubClientId.trim();
      if (trimmed.length > 0) {
        result.githubClientId = trimmed;
      }
    }
    if (typeof candidate.githubScopes === 'string') {
      const trimmed = candidate.githubScopes.trim();
      if (trimmed.length > 0) {
        result.githubScopes = trimmed;
      }
    }
    if (typeof candidate.showReasoningTraces === 'boolean') {
      result.showReasoningTraces = candidate.showReasoningTraces;
    }
    if (typeof candidate.sessionGoalEnabled === 'boolean') {
      result.sessionGoalEnabled = candidate.sessionGoalEnabled;
    }
    if (typeof candidate.sessionGoalDefaultBudgetEnabled === 'boolean') {
      result.sessionGoalDefaultBudgetEnabled = candidate.sessionGoalDefaultBudgetEnabled;
    }
    if (typeof candidate.sessionGoalDefaultBudget === 'number' && Number.isFinite(candidate.sessionGoalDefaultBudget) && candidate.sessionGoalDefaultBudget > 0) {
      result.sessionGoalDefaultBudget = Math.floor(candidate.sessionGoalDefaultBudget);
    }
    if (typeof candidate.collapsibleThinkingBlocks === 'boolean') {
      result.collapsibleThinkingBlocks = candidate.collapsibleThinkingBlocks;
    }
    if (typeof candidate.collapsibleUserMessages === 'boolean') {
      result.collapsibleUserMessages = candidate.collapsibleUserMessages;
    }
    if (typeof candidate.codeBlockLineWrap === 'boolean') {
      result.codeBlockLineWrap = candidate.codeBlockLineWrap;
    }
    if (typeof candidate.showTextJustificationActivity === 'boolean') {
      result.showTextJustificationActivity = candidate.showTextJustificationActivity;
    }
    if (typeof candidate.showDeletionDialog === 'boolean') {
      result.showDeletionDialog = candidate.showDeletionDialog;
    }
    if (typeof candidate.serverPermissionAutoAcceptEnabled === 'boolean') {
      result.serverPermissionAutoAcceptEnabled = candidate.serverPermissionAutoAcceptEnabled;
    }
    if (typeof candidate.nativeNotificationsEnabled === 'boolean') {
      result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
    }
    if (typeof candidate.notificationMode === 'string') {
      const mode = candidate.notificationMode.trim();
      if (mode === 'always' || mode === 'hidden-only') {
        result.notificationMode = mode;
      }
    }
    if (typeof candidate.notifyOnSubtasks === 'boolean') {
      result.notifyOnSubtasks = candidate.notifyOnSubtasks;
    }
    if (typeof candidate.notifyOnCompletion === 'boolean') {
      result.notifyOnCompletion = candidate.notifyOnCompletion;
    }
    if (typeof candidate.notifyOnError === 'boolean') {
      result.notifyOnError = candidate.notifyOnError;
    }
    if (typeof candidate.notifyOnQuestion === 'boolean') {
      result.notifyOnQuestion = candidate.notifyOnQuestion;
    }
    if (candidate.notificationTemplates && typeof candidate.notificationTemplates === 'object') {
      result.notificationTemplates = candidate.notificationTemplates;
    }
    if (typeof candidate.summarizeLastMessage === 'boolean') {
      result.summarizeLastMessage = candidate.summarizeLastMessage;
    }
    if (typeof candidate.summaryThreshold === 'number' && Number.isFinite(candidate.summaryThreshold)) {
      result.summaryThreshold = Math.max(0, Math.round(candidate.summaryThreshold));
    }
    if (typeof candidate.summaryLength === 'number' && Number.isFinite(candidate.summaryLength)) {
      result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
    }
    if (typeof candidate.maxLastMessageLength === 'number' && Number.isFinite(candidate.maxLastMessageLength)) {
      result.maxLastMessageLength = Math.max(10, Math.round(candidate.maxLastMessageLength));
    }
    if (typeof candidate.autoDeleteEnabled === 'boolean') {
      result.autoDeleteEnabled = candidate.autoDeleteEnabled;
    }
    if (typeof candidate.autoSaveEnabled === 'boolean') {
      result.autoSaveEnabled = candidate.autoSaveEnabled;
    }
    if (candidate.sessionRetentionAction === 'archive' || candidate.sessionRetentionAction === 'delete') {
      result.sessionRetentionAction = candidate.sessionRetentionAction;
    }
    if (typeof candidate.checkpointRetentionLimit === 'number' && Number.isFinite(candidate.checkpointRetentionLimit)) {
      result.checkpointRetentionLimit = Math.max(0, Math.round(candidate.checkpointRetentionLimit));
    }
    if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
      const normalizedDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)));
      result.autoDeleteAfterDays = normalizedDays;
    }
    if (
      candidate.recoveryPreference === 'conversation'
      || candidate.recoveryPreference === 'both'
      || candidate.recoveryPreference === 'ask'
    ) {
      result.recoveryPreference = candidate.recoveryPreference;
    }
    if (candidate.tunnelBootstrapTtlMs === null) {
      result.tunnelBootstrapTtlMs = null;
    } else if (typeof candidate.tunnelBootstrapTtlMs === 'number' && Number.isFinite(candidate.tunnelBootstrapTtlMs)) {
      result.tunnelBootstrapTtlMs = normalizeTunnelBootstrapTtlMs(candidate.tunnelBootstrapTtlMs);
    }
    if (typeof candidate.tunnelSessionTtlMs === 'number' && Number.isFinite(candidate.tunnelSessionTtlMs)) {
      result.tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(candidate.tunnelSessionTtlMs);
    }
    if (typeof candidate.tunnelProvider === 'string') {
      const provider = normalizeTunnelProvider(candidate.tunnelProvider);
      if (provider) {
        result.tunnelProvider = provider;
      }
    }
    if (typeof candidate.tunnelMode === 'string') {
      result.tunnelMode = normalizeTunnelMode(candidate.tunnelMode);
    }
    if (candidate.managedLocalTunnelConfigPath === null) {
      result.managedLocalTunnelConfigPath = null;
    } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
      const trimmed = candidate.managedLocalTunnelConfigPath.trim();
      result.managedLocalTunnelConfigPath = trimmed.length > 0 ? normalizeOptionalPath(trimmed) : null;
    }
    if (typeof candidate.managedRemoteTunnelHostname === 'string') {
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.managedRemoteTunnelHostname);
      result.managedRemoteTunnelHostname = hostname;
    }
    if (candidate.managedRemoteTunnelToken === null) {
      result.managedRemoteTunnelToken = null;
    } else if (typeof candidate.managedRemoteTunnelToken === 'string') {
      result.managedRemoteTunnelToken = candidate.managedRemoteTunnelToken.trim();
    }
    const managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(candidate.managedRemoteTunnelPresets);
    if (managedRemoteTunnelPresets) {
      result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
    }
    const managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(candidate.managedRemoteTunnelPresetTokens);
    if (managedRemoteTunnelPresetTokens) {
      result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
    }
    if (typeof candidate.managedRemoteTunnelSelectedPresetId === 'string') {
      const id = candidate.managedRemoteTunnelSelectedPresetId.trim();
      result.managedRemoteTunnelSelectedPresetId = id || undefined;
    }

    const typography = sanitizeTypographySizesPartial(candidate.typographySizes);
    if (typography) {
      result.typographySizes = typography;
    }

    if (typeof candidate.defaultModel === 'string') {
      const trimmed = candidate.defaultModel.trim();
      result.defaultModel = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultVariant === 'string') {
      const trimmed = candidate.defaultVariant.trim();
      result.defaultVariant = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultAgent === 'string') {
      const trimmed = candidate.defaultAgent.trim();
      result.defaultAgent = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.smallModelUseDefault === 'boolean') {
      result.smallModelUseDefault = candidate.smallModelUseDefault;
    }
    if (typeof candidate.smallModelOverride === 'string') {
      const trimmed = candidate.smallModelOverride.trim();
      result.smallModelOverride = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.walkthroughModelOverride === 'string') {
      const trimmed = candidate.walkthroughModelOverride.trim();
      result.walkthroughModelOverride = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultGitIdentityId === 'string') {
      const trimmed = candidate.defaultGitIdentityId.trim();
      result.defaultGitIdentityId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (candidate.followUpBehavior === 'steer' || candidate.followUpBehavior === 'queue') {
      result.followUpBehavior = candidate.followUpBehavior;
    }
    if (typeof candidate.autoCreateWorktree === 'boolean') {
      result.autoCreateWorktree = candidate.autoCreateWorktree;
    }
    if (typeof candidate.gitmojiEnabled === 'boolean') {
      result.gitmojiEnabled = candidate.gitmojiEnabled;
    }
    if (typeof candidate.defaultFileViewerPreview === 'boolean') {
      result.defaultFileViewerPreview = candidate.defaultFileViewerPreview;
    }
    if (typeof candidate.autoUpdateChecksEnabled === 'boolean') {
      result.autoUpdateChecksEnabled = candidate.autoUpdateChecksEnabled;
    }
    if (typeof candidate.zenModel === 'string') {
      const trimmed = candidate.zenModel.trim();
      result.zenModel = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.gitProviderId === 'string') {
      const trimmed = candidate.gitProviderId.trim();
      result.gitProviderId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.gitModelId === 'string') {
      const trimmed = candidate.gitModelId.trim();
      result.gitModelId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.pwaAppName === 'string') {
      result.pwaAppName = normalizePwaAppName(candidate.pwaAppName, undefined);
    }
    if (typeof candidate.pwaOrientation === 'string') {
      result.pwaOrientation = normalizePwaOrientation(candidate.pwaOrientation, undefined);
    }
    if (typeof candidate.mobileKeyboardMode === 'string') {
      const mode = normalizeMobileKeyboardMode(candidate.mobileKeyboardMode, null);
      if (mode) {
        result.mobileKeyboardMode = mode;
      }
    }
    if (typeof candidate.toolCallExpansion === 'string') {
      const mode = candidate.toolCallExpansion.trim();
      if (mode === 'collapsed' || mode === 'activity' || mode === 'detailed' || mode === 'changes') {
        result.toolCallExpansion = mode;
      }
    }
    if (typeof candidate.inputSpellcheckEnabled === 'boolean') {
      result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
    }
    if (typeof candidate.showToolFileIcons === 'boolean') {
      result.showToolFileIcons = candidate.showToolFileIcons;
    }
    if (typeof candidate.showTurnChangedFiles === 'boolean') {
      result.showTurnChangedFiles = candidate.showTurnChangedFiles;
    }
    if (typeof candidate.showExpandedBashTools === 'boolean') {
      result.showExpandedBashTools = candidate.showExpandedBashTools;
    }
    if (typeof candidate.showExpandedEditTools === 'boolean') {
      result.showExpandedEditTools = candidate.showExpandedEditTools;
    }
    if (typeof candidate.timeFormatPreference === 'string') {
      const mode = candidate.timeFormatPreference.trim();
      if (mode === 'auto' || mode === '12h' || mode === '24h') {
        result.timeFormatPreference = mode;
      }
    }
    if (typeof candidate.weekStartPreference === 'string') {
      const mode = candidate.weekStartPreference.trim();
      if (mode === 'auto' || mode === 'sunday' || mode === 'monday') {
        result.weekStartPreference = mode;
      }
    }
    if (typeof candidate.chatRenderMode === 'string') {
      const mode = candidate.chatRenderMode.trim();
      if (mode === 'sorted' || mode === 'live') {
        result.chatRenderMode = mode;
      }
    }
    if (typeof candidate.messageStreamTransport === 'string') {
      const mode = candidate.messageStreamTransport.trim();
      if (mode === 'auto' || mode === 'ws' || mode === 'sse') {
        result.messageStreamTransport = mode;
      }
    }
    if (typeof candidate.activityRenderMode === 'string') {
      const mode = candidate.activityRenderMode.trim();
      if (mode === 'collapsed' || mode === 'summary') {
        result.activityRenderMode = mode;
      }
    }
    if (typeof candidate.mermaidRenderingMode === 'string') {
      const mode = candidate.mermaidRenderingMode.trim();
      if (mode === 'svg' || mode === 'ascii') {
        result.mermaidRenderingMode = mode;
      }
    }
    if (typeof candidate.userMessageRenderingMode === 'string') {
      const mode = candidate.userMessageRenderingMode.trim();
      if (mode === 'markdown' || mode === 'plain') {
        result.userMessageRenderingMode = mode;
      }
    }
    if (typeof candidate.stickyUserHeader === 'boolean') {
      result.stickyUserHeader = candidate.stickyUserHeader;
    }
    if (typeof candidate.promptNavigatorEnabled === 'boolean') {
      result.promptNavigatorEnabled = candidate.promptNavigatorEnabled;
    }
    if (typeof candidate.expandedEditorToolbar === 'boolean') {
      result.expandedEditorToolbar = candidate.expandedEditorToolbar;
    }
    if (isChatContentWidth(candidate.chatContentWidth)) {
      result.chatContentWidth = candidate.chatContentWidth;
    }
    if (typeof candidate.fontSize === 'number' && Number.isFinite(candidate.fontSize)) {
      result.fontSize = Math.max(50, Math.min(200, Math.round(candidate.fontSize)));
    }
    if (typeof candidate.terminalFontSize === 'number' && Number.isFinite(candidate.terminalFontSize)) {
      result.terminalFontSize = Math.max(9, Math.min(52, Math.round(candidate.terminalFontSize)));
    }
    if (typeof candidate.editorFontSize === 'number' && Number.isFinite(candidate.editorFontSize)) {
      result.editorFontSize = Math.max(8, Math.min(32, Math.round(candidate.editorFontSize)));
    }
    if (
      candidate.fileEditorSettings !== undefined
      && typeof candidate.fileEditorSettings === 'object'
      && candidate.fileEditorSettings !== null
      && !Array.isArray(candidate.fileEditorSettings)
    ) {
      result.fileEditorSettings = { ...candidate.fileEditorSettings } as SettingsRecord['fileEditorSettings'];
    }
    if (typeof candidate.terminalShell === 'string') {
      const shell = candidate.terminalShell.trim().toLowerCase();
      if (TERMINAL_SHELL_VALUES.has(shell)) result.terminalShell = shell;
    }
    if (Array.isArray(candidate.terminalLoginShells)) {
      result.terminalLoginShells = [...new Set(candidate.terminalLoginShells
        .filter((shell) => typeof shell === 'string')
        .map((shell) => shell.trim().toLowerCase())
        .filter((shell) => TERMINAL_SHELL_VALUES.has(shell)))];
    }
    if (typeof candidate.padding === 'number' && Number.isFinite(candidate.padding)) {
      result.padding = Math.max(50, Math.min(200, Math.round(candidate.padding)));
    }
    if (typeof candidate.cornerRadius === 'number' && Number.isFinite(candidate.cornerRadius)) {
      result.cornerRadius = Math.max(0, Math.min(32, Math.round(candidate.cornerRadius)));
    }
    if (typeof candidate.inputBarOffset === 'number' && Number.isFinite(candidate.inputBarOffset)) {
      result.inputBarOffset = Math.max(0, Math.min(100, Math.round(candidate.inputBarOffset)));
    }

    const shortcutOverrides = sanitizeShortcutOverrides(candidate.shortcutOverrides);
    if (shortcutOverrides) {
      result.shortcutOverrides = shortcutOverrides;
    }

    const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
    if (favoriteModels) {
      result.favoriteModels = favoriteModels;
    }

    const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
    if (recentModels) {
      result.recentModels = recentModels;
    }

    // Cap at 1024: users with several providers (anthropic, openai, google,
    // bedrock, azure, etc.) each exposing dozens-to-hundreds of models can
    // exceed 256 hidden entries quickly. 1024 covers dense multi-provider
    // setups while still bounding persistence/memory.
    const hiddenModels = sanitizeModelRefs(candidate.hiddenModels, HIDDEN_MODELS_MAX);
    if (hiddenModels) {
      result.hiddenModels = hiddenModels;
    }

    if (Array.isArray(candidate.collapsedModelProviders)) {
      result.collapsedModelProviders = normalizeStringArray(candidate.collapsedModelProviders);
    }

    if (Array.isArray(candidate.recentAgents)) {
      result.recentAgents = normalizeStringArray(candidate.recentAgents);
    }

    const recentEfforts = sanitizeRecentEfforts(candidate.recentEfforts);
    if (recentEfforts) {
      result.recentEfforts = recentEfforts;
    }
    if (typeof candidate.diffLayoutPreference === 'string') {
      const mode = candidate.diffLayoutPreference.trim();
      if (mode === 'dynamic' || mode === 'inline' || mode === 'side-by-side') {
        result.diffLayoutPreference = mode;
      }
    }
    if (typeof candidate.gitChangesViewMode === 'string') {
      const mode = candidate.gitChangesViewMode.trim();
      if (mode === 'flat' || mode === 'tree') {
        result.gitChangesViewMode = mode;
      }
    }
    if (typeof candidate.directoryShowHidden === 'boolean') {
      result.directoryShowHidden = candidate.directoryShowHidden;
    }
    if (typeof candidate.filesViewShowGitignored === 'boolean') {
      result.filesViewShowGitignored = candidate.filesViewShowGitignored;
    }
    if (typeof candidate.openInAppId === 'string') {
      const trimmed = candidate.openInAppId.trim();
      if (trimmed.length > 0) {
        result.openInAppId = trimmed;
      }
    }

    // Message limit — single setting for fetch / trim / Load More chunk
    if (typeof candidate.messageLimit === 'number' && Number.isFinite(candidate.messageLimit)) {
      result.messageLimit = Math.max(10, Math.min(500, Math.round(candidate.messageLimit)));
    }

    const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
    if (skillCatalogs) {
      result.skillCatalogs = skillCatalogs;
    }

    // Varin-owned global behavior prompt.

    if (typeof candidate.dictationEnabled === 'boolean') {
      result.dictationEnabled = candidate.dictationEnabled;
    }
    if (typeof candidate.sttProvider === 'string') {
      const provider = candidate.sttProvider.trim();
      if (provider === 'local' || provider === 'openai-compatible') {
        result.sttProvider = provider;
      }
    }
    if (typeof candidate.sttServerUrl === 'string') {
      const trimmed = candidate.sttServerUrl.trim();
      if (trimmed.length <= STT_SERVER_URL_MAX_LENGTH) {
        result.sttServerUrl = trimmed;
      }
    }
    if (typeof candidate.sttModel === 'string') {
      const trimmed = candidate.sttModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttModel = trimmed;
      }
    }
    if (typeof candidate.sttLocalModel === 'string') {
      const trimmed = candidate.sttLocalModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttLocalModel = trimmed;
      }
    }
    if (typeof candidate.sttLanguage === 'string') {
      const trimmed = candidate.sttLanguage.trim();
      if (trimmed.length <= STT_LANGUAGE_MAX_LENGTH) {
        result.sttLanguage = trimmed;
      }
    }
    // Fork VAD (voice-activity-detection) tuning, preserved across the upstream
    // voice/dictation migration. These drive the local silence detector used by
    // the dictation pipeline (see VoiceSettings / useConfigStore).
    if (typeof candidate.sttSilenceThresholdDb === 'number' && Number.isFinite(candidate.sttSilenceThresholdDb)) {
      result.sttSilenceThresholdDb = candidate.sttSilenceThresholdDb;
    }
    if (typeof candidate.sttSilenceHoldMs === 'number' && Number.isFinite(candidate.sttSilenceHoldMs)) {
      result.sttSilenceHoldMs = Math.max(0, Math.round(candidate.sttSilenceHoldMs));
    }
    if (typeof candidate.sttTranscribeOnStop === 'boolean') {
      result.sttTranscribeOnStop = candidate.sttTranscribeOnStop;
    }

    return result;
  };

  const mergePersistedSettings = (current: SettingsRecord, changes: SettingsRecord): SettingsRecord => {
    const baseBookmarks = Array.isArray(changes.securityScopedBookmarks)
      ? changes.securityScopedBookmarks
      : Array.isArray(current.securityScopedBookmarks)
        ? current.securityScopedBookmarks
        : [];

    const nextTypographySizes = changes.typographySizes
      ? {
          ...(isRecord(current.typographySizes) ? current.typographySizes : {}),
          ...(isRecord(changes.typographySizes) ? changes.typographySizes : {}),
        }
      : current.typographySizes;

    const next = {
      ...current,
      ...changes,
      securityScopedBookmarks: Array.from(
        new Set(
          baseBookmarks.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        )
      ),
      typographySizes: nextTypographySizes
    };

    return next;
  };

  const formatSettingsResponse = (settings: SettingsRecord): SettingsRecord => {
    const sanitized = sanitizeSettingsUpdate(settings);
    delete sanitized.managedRemoteTunnelToken;
    const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);
    const hasManagedRemoteTunnelToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
    const pwaAppName = normalizePwaAppName(settings?.pwaAppName, '');
    const pwaOrientation = normalizePwaOrientation(settings?.pwaOrientation, 'system');
    const mobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode, 'native');

    return {
      ...sanitized,
      hasManagedRemoteTunnelToken,
      ...(pwaAppName ? { pwaAppName } : {}),
      pwaOrientation,
      mobileKeyboardMode,
      securityScopedBookmarks: bookmarks,
      pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
      typographySizes: sanitizeTypographySizesPartial(settings.typographySizes),
      ...(process.env.VARIN_RUNTIME === 'desktop'
        ? {
            desktopLanAccessActive: process.env.VARIN_DESKTOP_LAN_ACCESS_ACTIVE === 'true',
            desktopLanAccessBlockedReason:
              process.env.VARIN_DESKTOP_LAN_ACCESS_BLOCKED_REASON === 'missing-password'
                ? 'missing-password'
                : null,
          }
        : {}),
      showReasoningTraces:
        typeof settings.showReasoningTraces === 'boolean'
          ? settings.showReasoningTraces
          : typeof sanitized.showReasoningTraces === 'boolean'
            ? sanitized.showReasoningTraces
            : false,
      collapsibleThinkingBlocks:
        typeof settings.collapsibleThinkingBlocks === 'boolean'
          ? settings.collapsibleThinkingBlocks
          : typeof sanitized.collapsibleThinkingBlocks === 'boolean'
            ? sanitized.collapsibleThinkingBlocks
            : true,
    };
  };

  return {
    normalizePwaAppName,
    normalizePwaOrientation,
    normalizeMobileKeyboardMode,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    formatSettingsResponse,
  };
};
