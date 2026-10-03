import { DEFAULT_CHAT_CONTENT_WIDTH, isChatContentWidth } from '@varin/application-client';
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { SidebarSection } from '@/constants/sidebar';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { getContextRailMode } from '@/lib/surfaces/registry';
import { SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '@/lib/typography';
import type { ShortcutCombo } from '@/lib/shortcuts';
import type { DraftStarterRef } from '@/lib/draftStarters';
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { getStoredMobileKeyboardMode, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getRuntimeKey } from '@varin/application-client';
import type { TerminalShell } from '@varin/application-client';
import type { RecoveryPreference } from '@varin/protocol';
import {
  DEFAULT_FILE_EDITOR_SETTINGS,
  normalizeFileEditorSettings,
  type FileEditorSettings,
  type FileEditorSettingsPatch,
} from '@/lib/file-editor-settings';

export type MainTab = 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files' | 'context' | 'diagram';
export type PendingDiffScope = 'working' | 'staged';
export type ContextPanelMode = 'diff' | 'walkthrough' | 'file' | 'context' | 'recovery' | 'plan' | 'chat' | 'preview' | 'browser' | 'git' | 'pr' | 'notes' | 'terminal' | 'computer';
export type MermaidRenderingMode = 'svg' | 'ascii';
export type UserMessageRenderingMode = 'markdown' | 'plain';
export type ChatRenderMode = 'sorted' | 'live';
export type ActivityRenderMode = 'collapsed' | 'summary';
export type SessionRetentionAction = 'archive' | 'delete';
export type TimeFormatPreference = 'auto' | '12h' | '24h';
export type WeekStartPreference = 'auto' | 'sunday' | 'monday';
export type DesktopWindowControlsPosition = 'left' | 'right';
export type DesktopWindowControlsStyle = 'classic' | 'traffic-lights';
export type FileEditorKeymap = 'default' | 'vim';

function normalizeFileEditorKeymap(value: unknown): FileEditorKeymap {
  return value === 'vim' ? 'vim' : 'default';
}

type ContextPanelTab = {
  id: string;
  mode: ContextPanelMode;
  targetPath: string | null;
  targetDirectory: string | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: PendingDiffScope | null;
  touchedAt: number;
};

type ContextPanelTabDescriptor = {
  mode: ContextPanelMode;
  targetPath?: string | null;
  targetDirectory?: string | null;
  dedupeKey?: string | null;
  label?: string | null;
  sessionTitleFallback?: string | null;
  readOnly?: boolean;
  stagedDiff?: boolean;
  diffScope?: PendingDiffScope | null;
};

type ContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  tabs: ContextPanelTab[];
  activeTabId: string | null;
  // Manual per-surface widths (px), populated only by user resize; surfaces
  // without an entry fall back to their registry defaultWidthFraction.
  widthByMode: Partial<Record<ContextPanelMode, number>>;
  touchedAt: number;
};

type PendingFileNavigation = {
  path: string;
  line: number;
  column: number;
};

export type MainTabGuard = (nextTab: MainTab) => boolean;
export type EventStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'paused'
  | 'offline'
  | 'error';

const EMPTY_NOTIFICATION_TEMPLATES = {
  completion: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  subtask: { title: '', message: '' },
} as const;

const CONTEXT_PANEL_DEFAULT_WIDTH = 380;
const CONTEXT_PANEL_MIN_WIDTH = 380;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_MAX_TABS = 12;
const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 256;
const activeMainTabByRuntime = new Map<string, MainTab>();

const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim();
  return key || 'default';
};

// Shared with rail/panel consumers so contextPanelByDirectory lookups agree on keys.
export const normalizeContextPanelDirectoryKey = (value: string): string => normalizeDirectoryPath(value);

const normalizeDirectoryPath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampContextPanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const normalizeContextTargetPath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/');
};

const normalizeContextTabLabel = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > CONTEXT_PANEL_MAX_LABEL_LENGTH
    ? trimmed.slice(0, CONTEXT_PANEL_MAX_LABEL_LENGTH)
    : trimmed;
};

const normalizePendingDiffScope = (value: unknown): PendingDiffScope | null => {
  return value === 'working' || value === 'staged' ? value : null;
};

const buildDefaultContextPanelTabDedupeKey = (mode: ContextPanelMode, targetPath: string | null): string => {
  if (mode === 'file') {
    return targetPath || mode;
  }

  if (mode === 'preview' || mode === 'browser') {
    return targetPath || mode;
  }

  return mode;
};

const normalizeContextPanelTabDedupeKey = (
  mode: ContextPanelMode,
  targetPath: string | null,
  dedupeKey: string | null | undefined,
): string => {
  if (mode === 'diff') {
    return mode;
  }

  if (typeof dedupeKey === 'string') {
    const trimmed = dedupeKey.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return buildDefaultContextPanelTabDedupeKey(mode, targetPath);
};

const buildContextPanelTabID = (mode: ContextPanelMode, dedupeKey: string): string => {
  return dedupeKey === mode ? mode : `${mode}:${dedupeKey}`;
};

const createContextPanelTab = (descriptor: ContextPanelTabDescriptor): ContextPanelTab => {
  const normalizedTargetPath = normalizeContextTargetPath(descriptor.targetPath);
  const dedupeKey = normalizeContextPanelTabDedupeKey(
    descriptor.mode,
    normalizedTargetPath,
    descriptor.dedupeKey,
  );
  return {
    id: buildContextPanelTabID(descriptor.mode, dedupeKey),
    mode: descriptor.mode,
    targetPath: normalizedTargetPath,
    targetDirectory: normalizeDirectoryPath(descriptor.targetDirectory?.trim() ?? '') || null,
    dedupeKey,
    label: normalizeContextTabLabel(descriptor.label),
    sessionTitleFallback: normalizeContextTabLabel(descriptor.sessionTitleFallback),
    readOnly: descriptor.readOnly === true,
    stagedDiff: descriptor.stagedDiff === true,
    diffScope: normalizePendingDiffScope(descriptor.diffScope) ?? (descriptor.stagedDiff === true ? 'staged' : 'working'),
    touchedAt: Date.now(),
  };
};

const clampContextPanelTabs = (tabs: ContextPanelTab[], maxTabs: number, activeTabId: string | null): ContextPanelTab[] => {
  if (tabs.length <= maxTabs) {
    return tabs;
  }

  const tabsByTouch = [...tabs].sort((a, b) => a.touchedAt - b.touchedAt);
  const removable = tabsByTouch.filter((tab) => tab.id !== activeTabId);
  const removeCount = tabs.length - maxTabs;
  if (removeCount <= 0 || removable.length === 0) {
    return tabs.slice(-maxTabs);
  }

  const removeSet = new Set(removable.slice(0, removeCount).map((tab) => tab.id));
  return tabs.filter((tab) => !removeSet.has(tab.id));
};

const sanitizeContextPanelTabs = (tabs: unknown): ContextPanelTab[] => {
  if (!Array.isArray(tabs)) {
    return [];
  }

  const result: ContextPanelTab[] = [];
  const seen = new Set<string>();

  for (const entry of tabs) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const candidate = entry as {
      mode?: unknown;
      targetPath?: unknown;
      targetDirectory?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
      sessionTitleFallback?: unknown;
      readOnly?: unknown;
      stagedDiff?: unknown;
      diffScope?: unknown;
      touchedAt?: unknown;
    };

    if (candidate.mode !== 'diff' && candidate.mode !== 'walkthrough' && candidate.mode !== 'file' && candidate.mode !== 'context' && candidate.mode !== 'recovery' && candidate.mode !== 'plan' && candidate.mode !== 'chat' && candidate.mode !== 'preview' && candidate.mode !== 'browser' && candidate.mode !== 'git' && candidate.mode !== 'pr' && candidate.mode !== 'notes' && candidate.mode !== 'terminal' && candidate.mode !== 'computer') {
      continue;
    }

    const targetPath = normalizeContextTargetPath(typeof candidate.targetPath === 'string' ? candidate.targetPath : null);
    const dedupeKey = normalizeContextPanelTabDedupeKey(
      candidate.mode,
      targetPath,
      typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
    );
    const id = buildContextPanelTabID(candidate.mode, dedupeKey);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push({
      id,
      mode: candidate.mode,
      targetPath,
      dedupeKey,
      targetDirectory: normalizeDirectoryPath(typeof candidate.targetDirectory === 'string' ? candidate.targetDirectory.trim() : '') || null,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
      sessionTitleFallback: normalizeContextTabLabel(typeof candidate.sessionTitleFallback === 'string' ? candidate.sessionTitleFallback : null),
      readOnly: candidate.readOnly === true,
      stagedDiff: candidate.stagedDiff === true,
      diffScope: normalizePendingDiffScope(candidate.diffScope) ?? (candidate.stagedDiff === true ? 'staged' : 'working'),
      touchedAt: typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
        ? candidate.touchedAt
        : Date.now(),
    });
  }

  return result;
};

const resolveActiveContextPanelTabID = (tabs: ContextPanelTab[], activeTabId: string | null): string | null => {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  if (tabs.length === 0) {
    return null;
  }

  return tabs[tabs.length - 1].id;
};

const touchContextPanelState = (prev?: ContextPanelDirectoryState): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    const activeTabId = resolveActiveContextPanelTabID(tabs, prev.activeTabId);
    return {
      ...prev,
      tabs,
      activeTabId,
      touchedAt: Date.now(),
    };
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    widthByMode: {},
    touchedAt: Date.now(),
  };
};

const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
): ContextPanelDirectoryState => {
  const nextTab = createContextPanelTab(descriptor);
  // Replace the empty editor/preview launcher when its first resource opens.
  const baseTabs = (nextTab.mode === 'file' || nextTab.mode === 'preview') && nextTab.targetPath
    ? current.tabs.filter((tab) => !(tab.mode === nextTab.mode && !tab.targetPath))
    : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  const tabs = existingIndex === -1
    ? [...baseTabs, nextTab]
    : baseTabs.map((tab, index) => (index === existingIndex
      ? {
          ...tab,
          mode: nextTab.mode,
          targetPath: nextTab.targetPath || tab.targetPath,
          targetDirectory: nextTab.targetDirectory,
          dedupeKey: nextTab.dedupeKey,
          label: nextTab.label,
          sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
          stagedDiff: nextTab.stagedDiff,
          diffScope: nextTab.diffScope,
          readOnly: nextTab.readOnly,
          touchedAt: Date.now(),
        }
      : tab));

  const activeTabId = nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return {
    ...current,
    isOpen: true,
    tabs: clampedTabs,
    activeTabId: resolveActiveContextPanelTabID(clampedTabs, activeTabId),
    touchedAt: Date.now(),
  };
};

const closeContextPanelTab = (
  current: ContextPanelDirectoryState,
  tabID: string,
): ContextPanelDirectoryState => {
  const closedTab = current.tabs.find((tab) => tab.id === tabID) ?? null;
  const nextTabs = current.tabs.filter((tab) => tab.id !== tabID);

  if (current.activeTabId !== tabID) {
    return {
      ...current,
      tabs: nextTabs,
      activeTabId: resolveActiveContextPanelTabID(nextTabs, current.activeTabId),
      isOpen: nextTabs.length > 0 ? current.isOpen : false,
      touchedAt: Date.now(),
    };
  }

  // Closing the active tab stays inside the active surface: activate the most
  // recent remaining tab of the same mode, and when it was the last one just
  // close the panel instead of jumping to another surface.
  const sameModeTabs = closedTab ? nextTabs.filter((tab) => tab.mode === closedTab.mode) : [];
  const nextSameModeTab = sameModeTabs.length > 0
    ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
    : null;

  return {
    ...current,
    tabs: nextTabs,
    activeTabId: nextSameModeTab?.id ?? resolveActiveContextPanelTabID(nextTabs, null),
    isOpen: nextSameModeTab ? current.isOpen : false,
    touchedAt: Date.now(),
  };
};

const reorderContextPanelTabs = (
  current: ContextPanelDirectoryState,
  activeTabID: string,
  overTabID: string,
): ContextPanelDirectoryState => {
  if (activeTabID === overTabID) {
    return current;
  }

  const fromIndex = current.tabs.findIndex((tab) => tab.id === activeTabID);
  const toIndex = current.tabs.findIndex((tab) => tab.id === overTabID);
  if (fromIndex === -1 || toIndex === -1) {
    return current;
  }

  const tabs = [...current.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return current;
  }

  tabs.splice(toIndex, 0, moved);

  return {
    ...current,
    tabs,
    touchedAt: Date.now(),
  };
};

const clampContextPanelRoots = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  maxRoots: number
): Record<string, ContextPanelDirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) {
    return byDirectory;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, ContextPanelDirectoryState> = {};
  for (const [directory, state] of entries.slice(0, maxRoots)) {
    next[directory] = state;
  }
  return next;
};

interface UIStore {

  theme: 'light' | 'dark' | 'system';
  isMultiRunLauncherOpen: boolean;
  multiRunLauncherPrefillPrompt: string;
  isSidebarOpen: boolean;
  sidebarWidth: number;
  hasManuallyResizedLeftSidebar: boolean;
  contextPanelByDirectory: Record<string, ContextPanelDirectoryState>;
  contextRailOrder: string[];
  isContextRailOpen: boolean;
  agentWorkbenchProfileByHost: Record<string, string>;
  contextEditorTreeVisible: boolean;
  contextEditorTreeWidth: number;
  notesPanelHeight: number;
  todoPanelHeight: number;
  isSessionSwitcherOpen: boolean;
  isSessionDropdownOpen: boolean;
  activeMainTab: MainTab;
  mainTabGuard: MainTabGuard | null;
  sidebarOpenBeforeFullscreenTab: boolean | null;
  pendingDiffFile: string | null;
  pendingDiffStaged: boolean;
  pendingDiffScope: PendingDiffScope | null;
  pendingDiagramFile: string | null;
  pendingFileNavigation: PendingFileNavigation | null;
  pendingFileFocusPath: string | null;
  isMobile: boolean;
  isCommandPaletteOpen: boolean;
  isHelpDialogOpen: boolean;
  isAboutDialogOpen: boolean;
  isVarinDiagnosticsDialogOpen: boolean;
  isSessionCreateDialogOpen: boolean;
  isScheduledTasksDialogOpen: boolean;
  isArchivePageOpen: boolean;
  worktreesPageProjectId: string | null;
  isSettingsDialogOpen: boolean;
  isNewWorktreeDialogOpen: boolean;
  isModelSelectorOpen: boolean;
  sidebarSection: SidebarSection;

  // Settings IA (new shell)
  settingsPage: string;
  settingsHasOpenedOnce: boolean;
  settingsProjectsSelectedId: string | null;
  settingsRemoteInstancesSelectedId: string | null;
  eventStreamStatus: EventStreamStatus;
  eventStreamHint: string | null;
  showReasoningTraces: boolean;
  sessionGoalEnabled: boolean;
  sessionGoalDefaultBudgetEnabled: boolean;
  sessionGoalDefaultBudget: number;
  collapsibleThinkingBlocks: boolean;
  chatRenderMode: ChatRenderMode;
  activityRenderMode: ActivityRenderMode;
  showDeletionDialog: boolean;
  serverPermissionAutoAcceptEnabled: boolean;
  autoDeleteEnabled: boolean;
  /** Global file-editor autosave. */
  autoSaveEnabled: boolean;
  autoDeleteAfterDays: number;
  sessionRetentionAction: SessionRetentionAction;
  recoveryPreference: RecoveryPreference;
  autoDeleteLastRunAt: number | null;
  messageLimit: number;
  fontSize: number;
  // Global draft welcome starters; null = unset (use the default built-in set).
  globalDraftStarters: DraftStarterRef[] | null;
  draftStartersVisible: boolean;
  terminalFontSize: number;
  terminalShell: TerminalShell;
  terminalLoginShells: TerminalShell[];
  editorFontSize: number;
  fileEditorSettings: FileEditorSettings;
  uiFont: UiFontOption;
  monoFont: MonoFontOption;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;
  mobileKeyboardMode: MobileKeyboardMode;

  favoriteModels: Array<{ providerID: string; modelID: string }>;
  hiddenModels: Array<{ providerID: string; modelID: string }>;
  providerOrder: string[];
  collapsedModelProviders: string[];
  recentModels: Array<{ providerID: string; modelID: string }>;
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;

  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
  diffWrapLines: boolean;
  walkthroughTocWidth: number;
  gitChangesViewMode: 'flat' | 'tree';
  isTimelineDialogOpen: boolean;
  isPromptNavigatorPanelOpen: boolean;
  isImagePreviewOpen: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnSubtasks: boolean;
  // Desktop dock badge showing the count of sessions with unseen activity (macOS).
  dockBadgeEnabled: boolean;

  // Event toggles (which events trigger notifications)
  notifyOnCompletion: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;

  // Per-event notification templates
  notificationTemplates: {
    completion: { title: string; message: string };
    error: { title: string; message: string };
    question: { title: string; message: string };
    subtask: { title: string; message: string };
  };

  // Summarization settings
  summarizeLastMessage: boolean;
  summaryThreshold: number;   // chars — messages longer than this get summarized
  summaryLength: number;      // chars — target length for summary
  maxLastMessageLength: number; // chars — truncate {last_message} when summarization is off

  showTerminalQuickKeysOnDesktop: boolean;
  persistChatDraft: boolean;
  inputSpellcheckEnabled: boolean;
  chatContentWidth: number;
  codeBlockLineWrap: boolean;
  showToolFileIcons: boolean;
  showTurnChangedFiles: boolean;
  showExpandedBashTools: boolean;
  showExpandedEditTools: boolean;
  timeFormatPreference: TimeFormatPreference;
  weekStartPreference: WeekStartPreference;
  desktopWindowControlsPosition: DesktopWindowControlsPosition;
  desktopWindowControlsStyle: DesktopWindowControlsStyle;
  mermaidRenderingMode: MermaidRenderingMode;
  userMessageRenderingMode: UserMessageRenderingMode;
  collapsibleUserMessages: boolean;
  stickyUserHeader: boolean;
  promptNavigatorEnabled: boolean;
  expandedEditorToolbar: boolean;
  mobileSessionPanelOpen: boolean;
  mobileSessionFilterProjectId: string | null;
  isExpandedInput: boolean;
  shortcutOverrides: Record<string, ShortcutCombo>;
  fileEditorKeymap: FileEditorKeymap;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setContextRailOrder: (order: string[]) => void;
  toggleContextRail: () => void;
  rememberAgentWorkbenchProfile: (hostId: string, profileId: string) => void;
  toggleContextEditorTree: () => void;
  setContextEditorTreeWidth: (width: number) => void;
  openContextSurface: (directory: string, mode: ContextPanelMode) => void;
  openContextPanelTab: (directory: string, tab: ContextPanelTabDescriptor) => void;
  openContextDiff: (directory: string, filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  openContextFile: (directory: string, filePath: string) => void;
  openContextFileAtLine: (directory: string, filePath: string, line: number, column?: number, resourceDirectory?: string) => void;
  openContextOverview: (directory: string) => void;
  openContextPlan: (directory: string) => void;
  openContextPreview: (directory: string, url: string) => void;
  openContextBrowser: (directory: string, url?: string) => void;
  setContextPanelTabTargetPath: (directory: string, tabID: string, targetPath: string) => void;
  setActiveContextPanelTab: (directory: string, tabID: string) => void;
  reorderContextPanelTabs: (directory: string, activeTabID: string, overTabID: string) => void;
  closeContextPanelTab: (directory: string, tabID: string) => void;
  closeContextPanel: (directory: string) => void;
  toggleContextPanel: (directory: string) => void;
  toggleContextPanelExpanded: (directory: string) => void;
  setContextPanelWidth: (directory: string, mode: ContextPanelMode, width: number) => void;
  setNotesPanelHeight: (height: number) => void;
  setTodoPanelHeight: (height: number) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setSessionDropdownOpen: (open: boolean) => void;
  setActiveMainTab: (tab: MainTab) => void;
  prepareForRuntimeSwitch: (runtimeKey?: string | null) => void;
  restoreForRuntimeSwitch: (runtimeKey?: string | null) => void;
  setMainTabGuard: (guard: MainTabGuard | null) => void;
  setPendingDiffFile: (filePath: string | null, staged?: boolean, scope?: PendingDiffScope | null) => void;
  setPendingDiagramFile: (filePath: string | null) => void;
  setPendingFileNavigation: (navigation: PendingFileNavigation | null) => void;
  setPendingFileFocusPath: (path: string | null) => void;
  navigateToDiff: (filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  consumePendingDiffFile: () => string | null;
  navigateToDiagram: (filePath: string) => void;
  consumePendingDiagramFile: () => string | null;
  setIsMobile: (isMobile: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleHelpDialog: () => void;
  setHelpDialogOpen: (open: boolean) => void;
  setAboutDialogOpen: (open: boolean) => void;
  setVarinDiagnosticsDialogOpen: (open: boolean) => void;
  setSessionCreateDialogOpen: (open: boolean) => void;
  setScheduledTasksDialogOpen: (open: boolean) => void;
  setArchivePageOpen: (open: boolean) => void;
  setWorktreesPageProjectId: (projectId: string | null) => void;
  /** Close every full-page surface (Scheduled, Archive, Worktrees, Multi-run). */
  closeMainSurfaces: () => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setNewWorktreeDialogOpen: (open: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
  applyTheme: () => void;
  setSidebarSection: (section: SidebarSection) => void;
  setSettingsPage: (slug: string) => void;
  setSettingsProjectsSelectedId: (projectId: string | null) => void;
  setSettingsRemoteInstancesSelectedId: (instanceId: string | null) => void;
  setEventStreamStatus: (status: EventStreamStatus, hint?: string | null) => void;
  setShowReasoningTraces: (value: boolean) => void;
  setSessionGoalEnabled: (value: boolean) => void;
  setSessionGoalDefaultBudgetEnabled: (value: boolean) => void;
  setSessionGoalDefaultBudget: (value: number) => void;
  setCollapsibleThinkingBlocks: (value: boolean) => void;
  setChatRenderMode: (value: ChatRenderMode) => void;
  setActivityRenderMode: (value: ActivityRenderMode) => void;
  setShowDeletionDialog: (value: boolean) => void;
  setServerPermissionAutoAcceptEnabled: (value: boolean) => void;
  setAutoDeleteEnabled: (value: boolean) => void;
  setAutoSaveEnabled: (value: boolean) => void;
  setAutoDeleteAfterDays: (days: number) => void;
  setSessionRetentionAction: (value: SessionRetentionAction) => void;
  setRecoveryPreference: (value: RecoveryPreference) => void;
  setAutoDeleteLastRunAt: (timestamp: number | null) => void;
  setMessageLimit: (value: number) => void;
  setFontSize: (size: number) => void;
  setGlobalDraftStarters: (refs: DraftStarterRef[]) => void;
  setDraftStartersVisible: (value: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  setTerminalLoginShells: (shells: TerminalShell[]) => void;
  setEditorFontSize: (size: number) => void;
  updateFileEditorSettings: (patch: FileEditorSettingsPatch) => void;
  resetFileEditorSettings: () => void;
  setUiFont: (font: UiFontOption) => void;
  setMonoFont: (font: MonoFontOption) => void;
  setPadding: (size: number) => void;
  setCornerRadius: (radius: number) => void;
  setInputBarOffset: (offset: number) => void;
  setMobileKeyboardMode: (mode: MobileKeyboardMode) => void;
  applyTypography: () => void;
  applyPadding: () => void;
  toggleFavoriteModel: (providerID: string, modelID: string) => void;
  reorderFavoriteModel: (
    activeProviderID: string,
    activeModelID: string,
    overProviderID: string,
    overModelID: string,
  ) => void;
  setProviderOrder: (orderedProviderIDs: string[]) => void;
  toggleHiddenModel: (providerID: string, modelID: string) => void;
  isHiddenModel: (providerID: string, modelID: string) => boolean;
  hideAllModels: (providerID: string, modelIDs: string[]) => void;
  showAllModels: (providerID: string) => void;
  toggleModelProviderCollapsed: (providerID: string) => void;
  setModelProvidersCollapsed: (providerIDs: string[], collapsed: boolean) => void;
  isFavoriteModel: (providerID: string, modelID: string) => boolean;
  addRecentModel: (providerID: string, modelID: string) => void;
  addRecentAgent: (agentName: string) => void;
  addRecentEffort: (providerID: string, modelID: string, variant: string | undefined) => void;
  setDiffLayoutPreference: (mode: 'dynamic' | 'inline' | 'side-by-side') => void;
  setDiffFileLayout: (filePath: string, mode: 'inline' | 'side-by-side') => void;
  setDiffWrapLines: (wrap: boolean) => void;
  setWalkthroughTocWidth: (width: number) => void;
  setGitChangesViewMode: (mode: 'flat' | 'tree') => void;
  setMultiRunLauncherOpen: (open: boolean) => void;
  setTimelineDialogOpen: (open: boolean) => void;
  setPromptNavigatorPanelOpen: (open: boolean) => void;
  togglePromptNavigatorPanel: () => void;
  setImagePreviewOpen: (open: boolean) => void;
  setNativeNotificationsEnabled: (value: boolean) => void;
  setNotificationMode: (mode: 'always' | 'hidden-only') => void;
  setShowTerminalQuickKeysOnDesktop: (value: boolean) => void;
  setNotifyOnSubtasks: (value: boolean) => void;
  setDockBadgeEnabled: (value: boolean) => void;
  setNotifyOnCompletion: (value: boolean) => void;
  setNotifyOnError: (value: boolean) => void;
  setNotifyOnQuestion: (value: boolean) => void;
  setNotificationTemplates: (
    templates: UIStore['notificationTemplates'] | ((current: UIStore['notificationTemplates']) => UIStore['notificationTemplates']),
  ) => void;
  setSummarizeLastMessage: (value: boolean) => void;
  setSummaryThreshold: (value: number) => void;
  setSummaryLength: (value: number) => void;
  setMaxLastMessageLength: (value: number) => void;
  setPersistChatDraft: (value: boolean) => void;
  setInputSpellcheckEnabled: (value: boolean) => void;
  setChatContentWidth: (value: number) => void;
  setCodeBlockLineWrap: (value: boolean) => void;
  setShowToolFileIcons: (value: boolean) => void;
  setShowTurnChangedFiles: (value: boolean) => void;
  setShowExpandedBashTools: (value: boolean) => void;
  setShowExpandedEditTools: (value: boolean) => void;
  setTimeFormatPreference: (value: TimeFormatPreference) => void;
  setWeekStartPreference: (value: WeekStartPreference) => void;
  setDesktopWindowControlsPosition: (value: DesktopWindowControlsPosition) => void;
  setDesktopWindowControlsStyle: (value: DesktopWindowControlsStyle) => void;
  setMermaidRenderingMode: (value: MermaidRenderingMode) => void;
  setUserMessageRenderingMode: (value: UserMessageRenderingMode) => void;
  setCollapsibleUserMessages: (value: boolean) => void;
  setStickyUserHeader: (value: boolean) => void;
  setPromptNavigatorEnabled: (value: boolean) => void;
  setExpandedEditorToolbar: (value: boolean) => void;
  setMobileSessionPanelOpen: (value: boolean) => void;
  setMobileSessionFilterProjectId: (value: string | null) => void;
  viewPagerPage: 'left' | 'center' | 'right';
  setViewPagerPage: (page: 'left' | 'center' | 'right') => void;
  toggleExpandedInput: () => void;
  setExpandedInput: (value: boolean) => void;
  openMultiRunLauncher: () => void;
  openMultiRunLauncherWithPrompt: (prompt: string) => void;
  setShortcutOverride: (actionId: string, combo: ShortcutCombo) => void;
  clearShortcutOverride: (actionId: string) => void;
  resetAllShortcutOverrides: () => void;
  setFileEditorKeymap: (value: FileEditorKeymap) => void;
}


export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set, get) => ({

        theme: 'system',
        isMultiRunLauncherOpen: false,
        multiRunLauncherPrefillPrompt: '',
        isSidebarOpen: true,
        sidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
        hasManuallyResizedLeftSidebar: false,
        contextPanelByDirectory: {},
        contextRailOrder: [],
        isContextRailOpen: false,
        agentWorkbenchProfileByHost: {},
        contextEditorTreeVisible: true,
        contextEditorTreeWidth: 240,
        notesPanelHeight: 112,
        todoPanelHeight: 259,
        isSessionSwitcherOpen: false,
        isSessionDropdownOpen: false,
        activeMainTab: 'chat',
        mainTabGuard: null,
        sidebarOpenBeforeFullscreenTab: null,
        pendingDiffFile: null,
        pendingDiffStaged: false,
        pendingDiffScope: null,
        pendingDiagramFile: null,
        pendingFileNavigation: null,
        pendingFileFocusPath: null,
        isMobile: false,
        isCommandPaletteOpen: false,
        isHelpDialogOpen: false,
        isAboutDialogOpen: false,
        isVarinDiagnosticsDialogOpen: false,
        isSessionCreateDialogOpen: false,
        isScheduledTasksDialogOpen: false,
        isArchivePageOpen: false,
        worktreesPageProjectId: null,
        isSettingsDialogOpen: false,
        isNewWorktreeDialogOpen: false,
        isModelSelectorOpen: false,
        sidebarSection: 'sessions',
        settingsPage: 'home',
        settingsHasOpenedOnce: false,
        settingsProjectsSelectedId: null,
        settingsRemoteInstancesSelectedId: null,
        eventStreamStatus: 'idle',
        eventStreamHint: null,
        showReasoningTraces: true,
        sessionGoalEnabled: true,
        sessionGoalDefaultBudgetEnabled: false,
        sessionGoalDefaultBudget: 200_000,
        collapsibleThinkingBlocks: true,
        chatRenderMode: 'live',
        activityRenderMode: 'summary',
        showDeletionDialog: true,
        serverPermissionAutoAcceptEnabled: false,
        autoDeleteEnabled: false,
        autoSaveEnabled: true,
        autoDeleteAfterDays: 30,
        sessionRetentionAction: 'archive',
        recoveryPreference: 'conversation',
        autoDeleteLastRunAt: null,
        messageLimit: 200,
        fontSize: 100,
        globalDraftStarters: null,
        terminalFontSize: 14,
        terminalShell: 'auto',
        terminalLoginShells: [],
        editorFontSize: 13,
        fileEditorSettings: { ...DEFAULT_FILE_EDITOR_SETTINGS },
        uiFont: DEFAULT_UI_FONT,
        monoFont: DEFAULT_MONO_FONT,
        padding: 100,
        cornerRadius: 18,
        inputBarOffset: 0,
        mobileKeyboardMode: getStoredMobileKeyboardMode(),
        favoriteModels: [],
        hiddenModels: [],
        providerOrder: [],
        collapsedModelProviders: [],
        recentModels: [],
        recentAgents: [],
        recentEfforts: {},
        diffLayoutPreference: 'inline',
        diffFileLayout: {},
        diffWrapLines: false,
        walkthroughTocWidth: 224,
        gitChangesViewMode: 'flat',
        isTimelineDialogOpen: false,
        isPromptNavigatorPanelOpen: false,
        isImagePreviewOpen: false,
        nativeNotificationsEnabled: false,
        notificationMode: 'hidden-only',
        notifyOnSubtasks: true,
        dockBadgeEnabled: true,

        // Event toggles (which events trigger notifications)
        notifyOnCompletion: true,
        notifyOnError: true,
        notifyOnQuestion: true,
        notificationTemplates: {
          completion: { ...EMPTY_NOTIFICATION_TEMPLATES.completion },
          error: { ...EMPTY_NOTIFICATION_TEMPLATES.error },
          question: { ...EMPTY_NOTIFICATION_TEMPLATES.question },
          subtask: { ...EMPTY_NOTIFICATION_TEMPLATES.subtask },
        },

        // Summarization settings
        summarizeLastMessage: false,
        summaryThreshold: 200,
        summaryLength: 100,
        maxLastMessageLength: 250,

        showTerminalQuickKeysOnDesktop: false,
        persistChatDraft: true,
        inputSpellcheckEnabled: false,
        chatContentWidth: DEFAULT_CHAT_CONTENT_WIDTH,
        codeBlockLineWrap: true,
        showToolFileIcons: true,
        showTurnChangedFiles: false,
        showExpandedBashTools: false,
        showExpandedEditTools: false,
        timeFormatPreference: 'auto',
        weekStartPreference: 'auto',
        desktopWindowControlsPosition: 'right',
        desktopWindowControlsStyle: 'classic',
        mermaidRenderingMode: 'svg',
        userMessageRenderingMode: 'markdown',
        collapsibleUserMessages: true,
        stickyUserHeader: false,
        promptNavigatorEnabled: true,
        expandedEditorToolbar: false,
        draftStartersVisible: true,
        mobileSessionPanelOpen: false,
        mobileSessionFilterProjectId: null,
        isExpandedInput: false,
        shortcutOverrides: {},
        fileEditorKeymap: 'default',

        setTheme: (theme) => {
          set({ theme });
          get().applyTheme();
        },

        toggleSidebar: () => {
          set((state) => {
            const newOpen = !state.isSidebarOpen;

            if (newOpen && !state.hasManuallyResizedLeftSidebar) {
              return {
                isSidebarOpen: newOpen,
                sidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
              };
            }
            return { isSidebarOpen: newOpen };
          });
        },

        setSidebarOpen: (open) => {
          set((state) => {
            if (state.isSidebarOpen === open) {
              if (!open) {
                return state;
              }
              if (!state.hasManuallyResizedLeftSidebar && state.sidebarWidth !== LEFT_SIDEBAR_DEFAULT_WIDTH) {
                return {
                  isSidebarOpen: open,
                  sidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
                };
              }
              return state;
            }
            if (open && !state.hasManuallyResizedLeftSidebar) {
              return {
                isSidebarOpen: open,
                sidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
              };
            }
            return { isSidebarOpen: open };
          });
        },

        setSidebarWidth: (width) => {
          set({ sidebarWidth: width, hasManuallyResizedLeftSidebar: true });
        },

        toggleContextRail: () => set((state) => ({ isContextRailOpen: !state.isContextRailOpen })),

        rememberAgentWorkbenchProfile: (hostId, profileId) => {
          if (get().agentWorkbenchProfileByHost[hostId] === profileId) return;
          set((state) => ({
            agentWorkbenchProfileByHost: { ...state.agentWorkbenchProfileByHost, [hostId]: profileId },
          }));
        },

        setContextRailOrder: (order) => {
          const sanitized = Array.isArray(order)
            ? order.filter((id, index) => typeof id === 'string' && id.trim() !== '' && order.indexOf(id) === index)
            : [];
          set({ contextRailOrder: sanitized });
        },

        toggleContextEditorTree: () => {
          set((state) => ({ contextEditorTreeVisible: !state.contextEditorTreeVisible }));
        },

        setContextEditorTreeWidth: (width) => {
          if (!Number.isFinite(width)) {
            return;
          }
          set({ contextEditorTreeWidth: Math.min(480, Math.max(200, Math.round(width))) });
        },

        // Rail entry point: restores the current or latest page in a surface's
        // family, opens a singleton when none exists, and closes a visible family.
        // Explicit child-page requests continue to target their exact mode.
        openContextSurface: (directory, mode) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          const state = get();
          const panelState = state.contextPanelByDirectory[normalizedDirectory];
          const tabs = panelState?.tabs ?? [];
          const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;

          const belongsToSurface = (tab: ContextPanelTab): boolean => (
            mode === getContextRailMode(mode) ? getContextRailMode(tab.mode) === mode : tab.mode === mode
          );
          if (panelState?.isOpen && activeTab && belongsToSurface(activeTab)) {
            state.closeContextPanel(normalizedDirectory);
            return;
          }

          const tabsOfMode = tabs.filter(belongsToSurface);
          if (tabsOfMode.length > 0) {
            // Preserve the active page on reopen. Otherwise, `>=` resolves equal
            // timestamps to the later tab in insertion order.
            const mostRecent = activeTab && belongsToSurface(activeTab)
              ? activeTab
              : tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
            state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
            return;
          }

          // Split chat needs a real session; editor and preview have empty launchers.
          if (mode === 'chat') {
            return;
          }

          state.openContextPanelTab(normalizedDirectory, { mode });
        },

        openContextPanelTab: (directory, tab) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: upsertContextPanelTab(current, tab),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        openContextDiff: (directory, filePath, staged = false, scope = null) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = (filePath || '').trim();
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          const diffScope = normalizePendingDiffScope(scope) ?? (staged ? 'staged' : 'working');

          get().openContextPanelTab(normalizedDirectory, {
            mode: 'diff',
            targetDirectory: normalizedDirectory,
            targetPath: normalizedFilePath,
            stagedDiff: diffScope === 'staged',
            diffScope,
          });
        },

        openContextFile: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'file', targetPath: normalizedFilePath, targetDirectory: normalizedDirectory });
          get().setPendingFileFocusPath(normalizedFilePath);
          get().setPendingFileNavigation(null);
        },

        openContextFileAtLine: (directory, filePath, line, column, resourceDirectory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
          const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, {
            mode: 'file', targetPath: normalizedFilePath, targetDirectory: resourceDirectory ?? normalizedDirectory,
          });
          get().setPendingFileFocusPath(null);
          get().setPendingFileNavigation({
            path: normalizedFilePath,
            line: normalizedLine,
            column: normalizedColumn,
          });
        },

        openContextOverview: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'context' });
        },

        openContextPlan: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'plan' });
        },

        openContextPreview: (directory, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedUrl = (url || '').trim();
          if (!normalizedDirectory || !normalizedUrl) {
            return;
          }

          let label: string | null = null;
          try {
            const parsed = new URL(normalizedUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              label = parsed.host || parsed.hostname || 'Preview';
            }
          } catch {
            // ignore invalid URL
          }

          get().openContextPanelTab(normalizedDirectory, {
            mode: 'preview',
            targetPath: normalizedUrl,
            dedupeKey: normalizedUrl,
            label,
          });
        },

        openContextBrowser: (directory, url = '') => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedUrl = (url || '').trim();
          if (!normalizedDirectory) {
            return;
          }

          let label: string | null = null;
          if (normalizedUrl) {
            try {
              const parsed = new URL(normalizedUrl.includes('://') ? normalizedUrl : `https://${normalizedUrl}`);
              if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                label = parsed.host || parsed.hostname || null;
              }
            } catch {
              // ignore invalid URL
            }
          }

          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: normalizedUrl || null,
            dedupeKey: 'browser',
            label: label ?? 'Browser',
          });
        },

        setContextPanelTabTargetPath: (directory, tabID, targetPath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          const normalizedTargetPath = normalizeContextTargetPath(targetPath);
          if (!normalizedDirectory || !normalizedTabID || !normalizedTargetPath) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            if (!prev) {
              return state;
            }

            const tabs = sanitizeContextPanelTabs(prev.tabs);
            let changed = false;
            const nextTabs = tabs.map((tab) => {
              if (tab.id !== normalizedTabID || tab.targetPath === normalizedTargetPath) {
                return tab;
              }
              changed = true;
              return {
                ...tab,
                targetPath: normalizedTargetPath,
                touchedAt: Date.now(),
              };
            });

            if (!changed) {
              return state;
            }

            return {
              contextPanelByDirectory: {
                ...state.contextPanelByDirectory,
                [normalizedDirectory]: {
                  ...prev,
                  tabs: nextTabs,
                  touchedAt: Date.now(),
                },
              },
            };
          });
        },

        setActiveContextPanelTab: (directory, tabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          if (!normalizedDirectory || !normalizedTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            if (!current.tabs.some((tab) => tab.id === normalizedTabID)) {
              return state;
            }

            if (current.activeTabId === normalizedTabID && current.isOpen) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                isOpen: true,
                activeTabId: normalizedTabID,
                touchedAt: Date.now(),
                tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
                  ? { ...tab, touchedAt: Date.now() }
                  : tab)),
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        reorderContextPanelTabs: (directory, activeTabID, overTabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedActiveTabID = (activeTabID || '').trim();
          const normalizedOverTabID = (overTabID || '').trim();
          if (!normalizedDirectory || !normalizedActiveTabID || !normalizedOverTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            if (!current.tabs.some((tab) => tab.id === normalizedActiveTabID) || !current.tabs.some((tab) => tab.id === normalizedOverTabID)) {
              return state;
            }

            const next = reorderContextPanelTabs(current, normalizedActiveTabID, normalizedOverTabID);
            if (next.tabs === current.tabs) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: next,
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        closeContextPanelTab: (directory, tabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          if (!normalizedDirectory || !normalizedTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            if (!current.tabs.some((tab) => tab.id === normalizedTabID)) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: closeContextPanelTab(current, normalizedTabID),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });

        },

        closeContextPanel: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            if (!prev || !prev.isOpen) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...touchContextPanelState(prev),
                isOpen: false,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        toggleContextPanel: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return;
          const state = get();
          const current = state.contextPanelByDirectory[normalizedDirectory];
          if (current?.isOpen) {
            state.closeContextPanel(normalizedDirectory);
            return;
          }
          const activeTabId = resolveActiveContextPanelTabID(current?.tabs ?? [], current?.activeTabId ?? null);
          if (activeTabId) {
            state.setActiveContextPanelTab(normalizedDirectory, activeTabId);
          } else {
            state.openContextSurface(normalizedDirectory, 'file');
          }
        },

        toggleContextPanelExpanded: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                expanded: !current.expanded,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        setContextPanelWidth: (directory, mode, width) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                widthByMode: {
                  ...current.widthByMode,
                  [mode]: clampContextPanelWidth(width),
                },
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        setNotesPanelHeight: (height) => {
          set({ notesPanelHeight: height });
        },

        setTodoPanelHeight: (height) => {
          set({ todoPanelHeight: height });
        },

        setSessionSwitcherOpen: (open) => {
          if (get().isSessionSwitcherOpen === open) {
            return;
          }
          set({ isSessionSwitcherOpen: open });
        },

        setSessionDropdownOpen: (open) => {
          if (get().isSessionDropdownOpen === open) {
            return;
          }
          set({ isSessionDropdownOpen: open });
        },

        setMainTabGuard: (guard) => {
          if (get().mainTabGuard === guard) {
            return;
          }
          set({ mainTabGuard: guard });
        },

        setActiveMainTab: (tab) => {
          const guard = get().mainTabGuard;
          if (guard && !guard(tab)) {
            return;
          }
          activeMainTabByRuntime.set(runtimeMemoryKey(), tab);
          set({ activeMainTab: tab });
        },

        prepareForRuntimeSwitch: (runtimeKey?: string | null) => {
          activeMainTabByRuntime.set(runtimeMemoryKey(runtimeKey), get().activeMainTab);
        },

        restoreForRuntimeSwitch: (runtimeKey?: string | null) => {
          const restored = activeMainTabByRuntime.get(runtimeMemoryKey(runtimeKey)) ?? 'chat';
          set({ activeMainTab: restored });
        },

        setPendingDiffFile: (filePath, staged = false, scope = null) => {
          set({
            pendingDiffFile: filePath,
            pendingDiffStaged: filePath ? staged : false,
            pendingDiffScope: filePath ? scope : null,
          });
        },

        setPendingDiagramFile: (filePath) => {
          set({ pendingDiagramFile: filePath });
        },

        setPendingFileNavigation: (navigation) => {
          set({ pendingFileNavigation: navigation });
        },

        setPendingFileFocusPath: (path) => {
          set({ pendingFileFocusPath: path });
        },

        navigateToDiff: (filePath, staged = false, scope = null) => {
          const guard = get().mainTabGuard;
          if (guard && !guard('diff')) {
            return;
          }
          set({ pendingDiffFile: filePath, pendingDiffStaged: staged, pendingDiffScope: scope, activeMainTab: 'diff' });
        },

        consumePendingDiffFile: () => {
          const { pendingDiffFile } = get();
          if (pendingDiffFile) {
            set({ pendingDiffFile: null, pendingDiffStaged: false, pendingDiffScope: null });
          }
          return pendingDiffFile;
        },

        navigateToDiagram: (filePath) => {
          const guard = get().mainTabGuard;
          if (guard && !guard('diagram')) {
            return;
          }
          set({ pendingDiagramFile: filePath, activeMainTab: 'diagram' });
        },

        consumePendingDiagramFile: () => {
          const { pendingDiagramFile } = get();
          if (pendingDiagramFile) {
            set({ pendingDiagramFile: null });
          }
          return pendingDiagramFile;
        },

        setIsMobile: (isMobile) => {
          set({ isMobile });
        },

        toggleCommandPalette: () => {
          set((state) => ({ isCommandPaletteOpen: !state.isCommandPaletteOpen }));
        },

        setCommandPaletteOpen: (open) => {
          set({ isCommandPaletteOpen: open });
        },

        toggleHelpDialog: () => {
          set((state) => ({ isHelpDialogOpen: !state.isHelpDialogOpen }));
        },

        setHelpDialogOpen: (open) => {
          set({ isHelpDialogOpen: open });
        },

        setAboutDialogOpen: (open) => {
          set({ isAboutDialogOpen: open });
        },

        setVarinDiagnosticsDialogOpen: (open) => {
          set({ isVarinDiagnosticsDialogOpen: open });
        },

        setSessionCreateDialogOpen: (open) => {
          set({ isSessionCreateDialogOpen: open });
        },

        setScheduledTasksDialogOpen: (open) => {
          set(open
            ? { isScheduledTasksDialogOpen: true, isArchivePageOpen: false, worktreesPageProjectId: null, isMultiRunLauncherOpen: false }
            : { isScheduledTasksDialogOpen: false });
        },

        setArchivePageOpen: (open) => {
          set(open
            ? { isArchivePageOpen: true, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, isMultiRunLauncherOpen: false }
            : { isArchivePageOpen: false });
        },

        setWorktreesPageProjectId: (projectId) => {
          set(projectId
            ? { worktreesPageProjectId: projectId, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isMultiRunLauncherOpen: false }
            : { worktreesPageProjectId: null });
        },

        closeMainSurfaces: () => {
          const state = get();
          if (!state.isScheduledTasksDialogOpen && !state.isArchivePageOpen && !state.worktreesPageProjectId && !state.isMultiRunLauncherOpen) {
            return;
          }
          set({
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
            isMultiRunLauncherOpen: false,
            multiRunLauncherPrefillPrompt: '',
          });
        },

        setSettingsDialogOpen: (open) => {
          set((state) => {
            if (!open) {
              return { isSettingsDialogOpen: false };
            }
            if (state.settingsHasOpenedOnce) {
              return { isSettingsDialogOpen: true };
            }
            return { isSettingsDialogOpen: true, settingsHasOpenedOnce: true };
          });
        },

        setNewWorktreeDialogOpen: (open) => {
          set({ isNewWorktreeDialogOpen: open });
        },

        setModelSelectorOpen: (open) => {
          set({ isModelSelectorOpen: open });
        },

        setSidebarSection: (section) => {
          set({ sidebarSection: section });
        },

        setSettingsPage: (slug) => {
          set({ settingsPage: slug });
        },

        setSettingsProjectsSelectedId: (projectId) => {
          set({ settingsProjectsSelectedId: projectId });
        },

        setSettingsRemoteInstancesSelectedId: (instanceId) => {
          set({ settingsRemoteInstancesSelectedId: instanceId });
        },

        setEventStreamStatus: (status, hint) => {
          set({
            eventStreamStatus: status,
            eventStreamHint: hint ?? null,
          });
        },

        setShowReasoningTraces: (value) => {
          set({ showReasoningTraces: value });
        },

        setSessionGoalEnabled: (value) => {
          set({ sessionGoalEnabled: value });
        },

        setSessionGoalDefaultBudgetEnabled: (value) => {
          set({ sessionGoalDefaultBudgetEnabled: value });
        },

        setSessionGoalDefaultBudget: (value) => {
          set({ sessionGoalDefaultBudget: value });
        },

        setCollapsibleThinkingBlocks: (value) => {
          set({ collapsibleThinkingBlocks: value });
        },

        setChatRenderMode: (value) => {
          set({ chatRenderMode: value });
        },

        setActivityRenderMode: (value) => {
          set({ activityRenderMode: value });
        },

        setShowDeletionDialog: (value) => {
          set({ showDeletionDialog: value });
        },

        setServerPermissionAutoAcceptEnabled: (value) => {
          set({ serverPermissionAutoAcceptEnabled: value });
        },

        setAutoDeleteEnabled: (value) => {
          set({ autoDeleteEnabled: value });
        },

        setAutoSaveEnabled: (value) => {
          set({ autoSaveEnabled: value });
        },

        setAutoDeleteAfterDays: (days) => {
          const clampedDays = Math.max(1, Math.min(365, days));
          set({ autoDeleteAfterDays: clampedDays });
        },

        setSessionRetentionAction: (value) => {
          set({ sessionRetentionAction: value });
        },

        setRecoveryPreference: (value) => {
          set({ recoveryPreference: value });
        },

        setAutoDeleteLastRunAt: (timestamp) => {
          set({ autoDeleteLastRunAt: timestamp });
        },

        setMessageLimit: (value) => {
          const clamped = Math.max(10, Math.min(500, Math.round(value)));
          set({ messageLimit: clamped });
        },

        setFontSize: (size) => {
          // Clamp between 50% and 200%
          const clampedSize = Math.max(50, Math.min(200, size));
          set({ fontSize: clampedSize });
          get().applyTypography();
        },

        setGlobalDraftStarters: (refs) => {
          set({ globalDraftStarters: refs });
        },

        setDraftStartersVisible: (value) => {
          set({ draftStartersVisible: value });
        },

        setTerminalFontSize: (size) => {
          const rounded = Math.round(size);
          const clamped = Math.max(9, Math.min(52, rounded));
          set({ terminalFontSize: clamped });
        },

        setTerminalShell: (shell) => {
          set({ terminalShell: shell });
        },

        setTerminalLoginShells: (shells) => {
          set({ terminalLoginShells: [...new Set(shells)] });
        },

        setEditorFontSize: (size) => {
          const rounded = Math.round(size);
          const clamped = Math.max(9, Math.min(32, rounded));
          set({ editorFontSize: clamped });
        },

        updateFileEditorSettings: (patch) => {
          set((state) => ({
            fileEditorSettings: normalizeFileEditorSettings(patch, state.fileEditorSettings),
          }));
        },

        resetFileEditorSettings: () => {
          set({ fileEditorSettings: { ...DEFAULT_FILE_EDITOR_SETTINGS } });
        },

        setUiFont: (font) => {
          set({ uiFont: font });
        },

        setMonoFont: (font) => {
          set({ monoFont: font });
        },

        setPadding: (size) => {
          // Clamp between 50% and 200%
          const clampedSize = Math.max(50, Math.min(200, size));
          set({ padding: clampedSize });
          get().applyPadding();
        },

        setCornerRadius: (radius) => {
          set({ cornerRadius: radius });
        },

        applyTypography: () => {
          const { fontSize } = get();
          const root = document.documentElement;

          // 100 = default (1.0x), 50 = half size (0.5x), 200 = double (2.0x)
          const scale = fontSize / 100;

          const entries = Object.entries(SEMANTIC_TYPOGRAPHY) as Array<[SemanticTypographyKey, string]>;

          // Default must be SEMANTIC_TYPOGRAPHY (from CSS). Remove overrides.
          if (scale === 1) {
            for (const [key] of entries) {
              root.style.removeProperty(getTypographyVariable(key));
            }
            return;
          }

          for (const [key, baseValue] of entries) {
            const numericValue = parseFloat(baseValue);
            if (!Number.isFinite(numericValue)) {
              continue;
            }
            root.style.setProperty(getTypographyVariable(key), `${numericValue * scale}rem`);
          }
        },

        applyPadding: () => {
          const { padding } = get();
          const root = document.documentElement;

          const scale = padding / 100;

          if (scale === 1) {
            root.style.removeProperty('--padding-scale');
            root.style.removeProperty('--line-height-tight');
            root.style.removeProperty('--line-height-normal');
            root.style.removeProperty('--line-height-relaxed');
            root.style.removeProperty('--line-height-loose');
            return;
          }

          // Apply padding as a percentage scale with non-linear scaling
          // Use square root for more natural scaling at extremes
          const adjustedScale = Math.sqrt(scale);

          // Set the CSS custom property that all spacing tokens reference
          root.style.setProperty('--padding-scale', adjustedScale.toString());

          // Dampened line-height scaling at extremes
          const lineHeightScale = 1 + (scale - 1) * 0.15;

          root.style.setProperty('--line-height-tight', (1.25 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-normal', (1.5 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-relaxed', (1.625 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-loose', (2 * lineHeightScale).toFixed(3));
        },

        setDiffLayoutPreference: (mode) => {
          set({ diffLayoutPreference: mode });
        },

        setDiffFileLayout: (filePath, mode) => {
          set((state) => ({
            diffFileLayout: {
              ...state.diffFileLayout,
              [filePath]: mode,
            },
          }));
        },

        setDiffWrapLines: (wrap) => {
          set({ diffWrapLines: wrap });
        },

        setWalkthroughTocWidth: (width) => {
          set({ walkthroughTocWidth: Math.round(width) });
        },

        setGitChangesViewMode: (mode) => {
          set({ gitChangesViewMode: mode });
        },

        setInputBarOffset: (offset) => {
          set({ inputBarOffset: offset });
        },

        setMobileKeyboardMode: (mode) => {
          set((state) => state.mobileKeyboardMode === mode ? state : { mobileKeyboardMode: mode });
        },

        toggleFavoriteModel: (providerID, modelID) => {
          set((state) => {
            const exists = state.favoriteModels.some(
              (fav) => fav.providerID === providerID && fav.modelID === modelID
            );

            if (exists) {
              // Remove from favorites
              return {
                favoriteModels: state.favoriteModels.filter(
                  (fav) => !(fav.providerID === providerID && fav.modelID === modelID)
                ),
              };
            } else {
              // Add to favorites (newest first)
              return {
                favoriteModels: [{ providerID, modelID }, ...state.favoriteModels],
              };
            }
          });
        },

        reorderFavoriteModel: (activeProviderID, activeModelID, overProviderID, overModelID) => {
          set((state) => {
            const oldIndex = state.favoriteModels.findIndex(
              (fav) => fav.providerID === activeProviderID && fav.modelID === activeModelID
            );
            const newIndex = state.favoriteModels.findIndex(
              (fav) => fav.providerID === overProviderID && fav.modelID === overModelID
            );

            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
              return state;
            }

            const nextFavorites = state.favoriteModels.slice();
            const [moved] = nextFavorites.splice(oldIndex, 1);
            if (!moved) {
              return state;
            }
            nextFavorites.splice(newIndex, 0, moved);
            return { favoriteModels: nextFavorites };
          });
        },

        setProviderOrder: (orderedProviderIDs) => {
          set((state) => {
            const next = orderedProviderIDs.filter((id) => typeof id === 'string' && id.length > 0);
            const current = state.providerOrder;
            if (current.length === next.length && current.every((id, index) => id === next[index])) {
              return state;
            }
            return { providerOrder: next };
          });
        },

        toggleHiddenModel: (providerID, modelID) => {
          set((state) => {
            const exists = state.hiddenModels.some(
              (item) => item.providerID === providerID && item.modelID === modelID
            );

            if (exists) {
              return {
                hiddenModels: state.hiddenModels.filter(
                  (item) => !(item.providerID === providerID && item.modelID === modelID)
                ),
              };
            }

            return {
              hiddenModels: [{ providerID, modelID }, ...state.hiddenModels],
            };
          });
        },

        isHiddenModel: (providerID, modelID) => {
          const { hiddenModels } = get();
          return hiddenModels.some(
            (item) => item.providerID === providerID && item.modelID === modelID
          );
        },

        hideAllModels: (providerID, modelIDs) => {
          set((state) => {
            const current = state.hiddenModels.filter((item) => item.providerID !== providerID);
            const additions = modelIDs
              .filter((modelID) => typeof modelID === 'string' && modelID.length > 0)
              .map((modelID) => ({ providerID, modelID }));
            return { hiddenModels: [...additions, ...current] };
          });
        },

        showAllModels: (providerID) => {
          set((state) => ({
            hiddenModels: state.hiddenModels.filter((item) => item.providerID !== providerID),
          }));
        },

        toggleModelProviderCollapsed: (providerID) => {
          const normalizedProviderID = typeof providerID === 'string' ? providerID.trim() : '';
          if (!normalizedProviderID) {
            return;
          }

          set((state) => {
            const isCollapsed = state.collapsedModelProviders.includes(normalizedProviderID);
            if (isCollapsed) {
              return {
                collapsedModelProviders: state.collapsedModelProviders.filter((id) => id !== normalizedProviderID),
              };
            }

            return {
              collapsedModelProviders: [...state.collapsedModelProviders, normalizedProviderID],
            };
          });
        },

        setModelProvidersCollapsed: (providerIDs, collapsed) => {
          const normalizedProviderIDs = Array.from(new Set(
            providerIDs
              .filter((providerID): providerID is string => typeof providerID === 'string')
              .map((providerID) => providerID.trim())
              .filter(Boolean)
          ));

          if (normalizedProviderIDs.length === 0) {
            return;
          }

          set((state) => {
            const scopedProviderIDs = new Set(normalizedProviderIDs);
            const untouchedProviders = state.collapsedModelProviders.filter((providerID) => !scopedProviderIDs.has(providerID));

            return {
              collapsedModelProviders: collapsed
                ? [...untouchedProviders, ...normalizedProviderIDs]
                : untouchedProviders,
            };
          });
        },

        isFavoriteModel: (providerID, modelID) => {
          const { favoriteModels } = get();
          return favoriteModels.some(
            (fav) => fav.providerID === providerID && fav.modelID === modelID
          );
        },

        addRecentModel: (providerID, modelID) => {
          set((state) => {
            // Remove existing instance if any
            const filtered = state.recentModels.filter(
              (m) => !(m.providerID === providerID && m.modelID === modelID)
            );
            // Add to front, limit to 5
            return {
              recentModels: [{ providerID, modelID }, ...filtered].slice(0, 5),
            };
          });
        },

        addRecentAgent: (agentName) => {
          const normalized = typeof agentName === 'string' ? agentName.trim() : '';
          if (!normalized) {
            return;
          }
          set((state) => {
            if (state.recentAgents.includes(normalized)) {
              return state;
            }
            const filtered = state.recentAgents;
            return {
              recentAgents: [normalized, ...filtered].slice(0, 5),
            };
          });
        },

        addRecentEffort: (providerID, modelID, variant) => {
          const provider = typeof providerID === 'string' ? providerID.trim() : '';
          const model = typeof modelID === 'string' ? modelID.trim() : '';
          if (!provider || !model) {
            return;
          }
          const key = `${provider}/${model}`;
          const normalizedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant.trim() : 'default';
          set((state) => {
            const current = state.recentEfforts[key] ?? [];
            if (current.includes(normalizedVariant)) {
              return state;
            }
            const filtered = current;
            return {
              recentEfforts: {
                ...state.recentEfforts,
                [key]: [normalizedVariant, ...filtered].slice(0, 5),
              },
            };
          });
        },

        applyTheme: () => {
          const { theme } = get();
          const root = document.documentElement;

          root.classList.remove('light', 'dark');

          if (theme === 'system') {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            root.classList.add(systemTheme);
          } else {
            root.classList.add(theme);
          }
        },

        // Multi-run is one of the mutually exclusive full-page surfaces:
        // opening it closes the other surfaces and vice versa.
        setMultiRunLauncherOpen: (open) => {
          set((state) => ({
            isMultiRunLauncherOpen: open,
            multiRunLauncherPrefillPrompt: open ? state.multiRunLauncherPrefillPrompt : '',
            ...(open ? { isScheduledTasksDialogOpen: false, isArchivePageOpen: false, worktreesPageProjectId: null } : {}),
          }));
        },

        openMultiRunLauncher: () => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: '',
            isSessionSwitcherOpen: false,
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
          });
        },

        openMultiRunLauncherWithPrompt: (prompt) => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: prompt,
            isSessionSwitcherOpen: false,
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
          });
        },

        setTimelineDialogOpen: (open) => {
          set({ isTimelineDialogOpen: open });
        },

        setPromptNavigatorPanelOpen: (open) => {
          set({ isPromptNavigatorPanelOpen: open });
        },

        togglePromptNavigatorPanel: () => {
          set((state) => ({ isPromptNavigatorPanelOpen: !state.isPromptNavigatorPanelOpen }));
        },

        setImagePreviewOpen: (open) => {
          set({ isImagePreviewOpen: open });
        },

        setNativeNotificationsEnabled: (value) => {
          set({ nativeNotificationsEnabled: value });
        },

        setNotificationMode: (mode) => {
          set({ notificationMode: mode });
        },

        setShowTerminalQuickKeysOnDesktop: (value) => {
          set({ showTerminalQuickKeysOnDesktop: value });
        },

        setNotifyOnSubtasks: (value) => {
          set({ notifyOnSubtasks: value });
        },

        setDockBadgeEnabled: (value) => {
          set({ dockBadgeEnabled: value });
        },

        setNotifyOnCompletion: (value) => { set({ notifyOnCompletion: value }); },
        setNotifyOnError: (value) => { set({ notifyOnError: value }); },
        setNotifyOnQuestion: (value) => { set({ notifyOnQuestion: value }); },
        setNotificationTemplates: (templates) => {
          set((state) => ({
            notificationTemplates: typeof templates === 'function'
              ? templates(state.notificationTemplates)
              : templates,
          }));
        },
        setSummarizeLastMessage: (value) => { set({ summarizeLastMessage: value }); },
        setSummaryThreshold: (value) => { set({ summaryThreshold: value }); },
        setSummaryLength: (value) => { set({ summaryLength: value }); },
        setMaxLastMessageLength: (value) => { set({ maxLastMessageLength: value }); },
        setPersistChatDraft: (value) => {
          set({ persistChatDraft: value });
        },
        setInputSpellcheckEnabled: (value) => {
          set({ inputSpellcheckEnabled: value });
        },
        setChatContentWidth: (value) => {
          if (isChatContentWidth(value)) set({ chatContentWidth: value });
        },
        setCodeBlockLineWrap: (value) => {
          set({ codeBlockLineWrap: value });
        },
        setShowToolFileIcons: (value) => {
          set({ showToolFileIcons: value });
        },
        setShowTurnChangedFiles: (value) => {
          set({ showTurnChangedFiles: value });
        },
        setShowExpandedBashTools: (value) => {
          set({ showExpandedBashTools: value });
        },
        setShowExpandedEditTools: (value) => {
          set({ showExpandedEditTools: value });
        },

        setTimeFormatPreference: (value) => {
          set({ timeFormatPreference: value });
        },

        setWeekStartPreference: (value) => {
          set({ weekStartPreference: value });
        },
        setDesktopWindowControlsPosition: (value) => {
          set({ desktopWindowControlsPosition: value === 'left' ? 'left' : 'right' });
        },
        setDesktopWindowControlsStyle: (value) => {
          set({ desktopWindowControlsStyle: value === 'traffic-lights' ? 'traffic-lights' : 'classic' });
        },
        setMermaidRenderingMode: (value) => {
          set({ mermaidRenderingMode: value });
        },
        setUserMessageRenderingMode: (value) => {
          set({ userMessageRenderingMode: value });
        },
        setCollapsibleUserMessages: (value) => {
          set({ collapsibleUserMessages: value });
        },
        setStickyUserHeader: (value) => {
          set({ stickyUserHeader: value });
        },
        setPromptNavigatorEnabled: (value) => {
          set({ promptNavigatorEnabled: value });
        },
        setExpandedEditorToolbar: (value: boolean) => {
          set({ expandedEditorToolbar: value });
        },
        setMobileSessionPanelOpen: (value) => {
          set({ mobileSessionPanelOpen: value });
        },
        setMobileSessionFilterProjectId: (value) => {
          set({ mobileSessionFilterProjectId: value });
        },
        viewPagerPage: 'center',
        setViewPagerPage: (page: 'left' | 'center' | 'right') => {
          set({ viewPagerPage: page });
          set({ isSessionSwitcherOpen: page === 'left' });
        },

        setShortcutOverride: (actionId, combo) => {
          set((state) => ({
            shortcutOverrides: {
              ...state.shortcutOverrides,
              [actionId]: combo,
            },
          }));
        },

        clearShortcutOverride: (actionId) => {
          set((state) => {
            const rest = { ...state.shortcutOverrides };
            delete rest[actionId];
            return { shortcutOverrides: rest };
          });
        },

        resetAllShortcutOverrides: () => {
          set({ shortcutOverrides: {} });
        },

        setFileEditorKeymap: (value) => {
          set({ fileEditorKeymap: normalizeFileEditorKeymap(value) });
        },

        toggleExpandedInput: () => {
          set((state) => ({ isExpandedInput: !state.isExpandedInput }));
        },

        setExpandedInput: (value) => {
          set({ isExpandedInput: value });
        },
      }),
      {
        name: 'varin.ui.v1',
        storage: createDeferredSafeJSONStorage(),
        merge: (persisted, current) => {
          const saved = persisted && typeof persisted === 'object'
            ? persisted as Partial<UIStore>
            : {};
          return {
            ...current,
            ...saved,
            chatContentWidth: isChatContentWidth(saved.chatContentWidth) ? saved.chatContentWidth : DEFAULT_CHAT_CONTENT_WIDTH,
            fileEditorSettings: normalizeFileEditorSettings(
              saved.fileEditorSettings,
              current.fileEditorSettings,
            ),
          };
        },
        partialize: (state) => ({
          theme: state.theme,
          isSidebarOpen: state.isSidebarOpen,
          sidebarWidth: state.sidebarWidth,
          contextPanelByDirectory: state.contextPanelByDirectory,
          contextRailOrder: state.contextRailOrder,
          isContextRailOpen: state.isContextRailOpen,
          agentWorkbenchProfileByHost: state.agentWorkbenchProfileByHost,
          contextEditorTreeVisible: state.contextEditorTreeVisible,
          contextEditorTreeWidth: state.contextEditorTreeWidth,
          notesPanelHeight: state.notesPanelHeight,
          todoPanelHeight: state.todoPanelHeight,
          isSessionSwitcherOpen: state.isSessionSwitcherOpen,
          activeMainTab: state.activeMainTab,
          sidebarSection: state.sidebarSection,
          settingsPage: state.settingsPage,
          settingsHasOpenedOnce: state.settingsHasOpenedOnce,
          settingsProjectsSelectedId: state.settingsProjectsSelectedId,
          settingsRemoteInstancesSelectedId: state.settingsRemoteInstancesSelectedId,
          isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
          // Note: isSettingsDialogOpen intentionally NOT persisted
          showReasoningTraces: state.showReasoningTraces,
          sessionGoalEnabled: state.sessionGoalEnabled,
          sessionGoalDefaultBudgetEnabled: state.sessionGoalDefaultBudgetEnabled,
          sessionGoalDefaultBudget: state.sessionGoalDefaultBudget,
          collapsibleThinkingBlocks: state.collapsibleThinkingBlocks,
          chatRenderMode: state.chatRenderMode,
          activityRenderMode: state.activityRenderMode,
          showDeletionDialog: state.showDeletionDialog,
          serverPermissionAutoAcceptEnabled: state.serverPermissionAutoAcceptEnabled,
          autoDeleteEnabled: state.autoDeleteEnabled,
          autoSaveEnabled: state.autoSaveEnabled,
          autoDeleteAfterDays: state.autoDeleteAfterDays,
          sessionRetentionAction: state.sessionRetentionAction,
          recoveryPreference: state.recoveryPreference,
          autoDeleteLastRunAt: state.autoDeleteLastRunAt,
          messageLimit: state.messageLimit,
          fontSize: state.fontSize,
          globalDraftStarters: state.globalDraftStarters,
          terminalFontSize: state.terminalFontSize,
          terminalShell: state.terminalShell,
          terminalLoginShells: state.terminalLoginShells,
          editorFontSize: state.editorFontSize,
          fileEditorSettings: state.fileEditorSettings,
          uiFont: state.uiFont,
          monoFont: state.monoFont,
          padding: state.padding,
          cornerRadius: state.cornerRadius,
          favoriteModels: state.favoriteModels,
          hiddenModels: state.hiddenModels,
          providerOrder: state.providerOrder,
          collapsedModelProviders: state.collapsedModelProviders,
          recentModels: state.recentModels,
          recentAgents: state.recentAgents,
          recentEfforts: state.recentEfforts,
          diffLayoutPreference: state.diffLayoutPreference,
          diffWrapLines: state.diffWrapLines,
          walkthroughTocWidth: state.walkthroughTocWidth,
          gitChangesViewMode: state.gitChangesViewMode,
          nativeNotificationsEnabled: state.nativeNotificationsEnabled,
          notificationMode: state.notificationMode,
          showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
          notifyOnSubtasks: state.notifyOnSubtasks,
          dockBadgeEnabled: state.dockBadgeEnabled,
          notifyOnCompletion: state.notifyOnCompletion,
          notifyOnError: state.notifyOnError,
          notifyOnQuestion: state.notifyOnQuestion,
          notificationTemplates: state.notificationTemplates,
          summarizeLastMessage: state.summarizeLastMessage,
          summaryThreshold: state.summaryThreshold,
          summaryLength: state.summaryLength,
          maxLastMessageLength: state.maxLastMessageLength,
          persistChatDraft: state.persistChatDraft,
          inputSpellcheckEnabled: state.inputSpellcheckEnabled,
          chatContentWidth: state.chatContentWidth,
          codeBlockLineWrap: state.codeBlockLineWrap,
          showToolFileIcons: state.showToolFileIcons,
          showTurnChangedFiles: state.showTurnChangedFiles,
          showExpandedBashTools: state.showExpandedBashTools,
          showExpandedEditTools: state.showExpandedEditTools,
          timeFormatPreference: state.timeFormatPreference,
          weekStartPreference: state.weekStartPreference,
          desktopWindowControlsPosition: state.desktopWindowControlsPosition,
          desktopWindowControlsStyle: state.desktopWindowControlsStyle,
          mermaidRenderingMode: state.mermaidRenderingMode,
          userMessageRenderingMode: state.userMessageRenderingMode,
          collapsibleUserMessages: state.collapsibleUserMessages,
          stickyUserHeader: state.stickyUserHeader,
          promptNavigatorEnabled: state.promptNavigatorEnabled,
          expandedEditorToolbar: state.expandedEditorToolbar,
          draftStartersVisible: state.draftStartersVisible,
          mobileSessionFilterProjectId: state.mobileSessionFilterProjectId,
          shortcutOverrides: state.shortcutOverrides,
          fileEditorKeymap: state.fileEditorKeymap,
        })
      }
    ),
    {
      name: 'varin-ui'
    }
  )
);
