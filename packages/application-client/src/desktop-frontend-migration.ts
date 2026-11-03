/** One-time desktop origin migration. This is a product-data allowlist, never
 * a browser-profile dump or an authentication/permission migration. */
export const FRONTEND_MIGRATION_SCHEMA = 1 as const;
export const NATIVE_MIGRATION_RECOVERY_KEY = 'varin.desktopMigration.nativeRecovery.v1';
export const FRONTEND_RECOVERED_DRAFTS_KEY = 'varin.desktopMigration.recoveredDrafts.v1';
export const FRONTEND_MIGRATION_MARKER_KEY = 'varin.desktopMigration.import.v1';
export const FRONTEND_CREDENTIAL_KEYS = ['openaiApiKey', 'openaiCompatibleApiKey', 'sttApiKey'] as const;
const stores: Readonly<Record<string, readonly string[]>> = {
  'varin.ui.v1': ['theme', 'isSidebarOpen', 'sidebarWidth', 'contextPanelByDirectory', 'contextRailOrder', 'isContextRailOpen', 'agentWorkbenchProfileByHost', 'contextEditorTreeVisible', 'contextEditorTreeWidth', 'notesPanelHeight', 'todoPanelHeight', 'isSessionSwitcherOpen', 'activeMainTab', 'sidebarSection', 'settingsPage', 'settingsHasOpenedOnce', 'settingsProjectsSelectedId', 'settingsRemoteInstancesSelectedId', 'isSessionCreateDialogOpen', 'showReasoningTraces', 'sessionGoalEnabled', 'sessionGoalDefaultBudgetEnabled', 'sessionGoalDefaultBudget', 'collapsibleThinkingBlocks', 'chatRenderMode', 'activityRenderMode', 'motionPreference', 'showDeletionDialog', 'serverPermissionAutoAcceptEnabled', 'autoDeleteEnabled', 'autoSaveEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction', 'recoveryPreference', 'autoDeleteLastRunAt', 'messageLimit', 'fontSize', 'globalDraftStarters', 'terminalFontSize', 'terminalShell', 'terminalLoginShells', 'editorFontSize', 'fileEditorSettings', 'uiFont', 'monoFont', 'padding', 'cornerRadius', 'favoriteModels', 'hiddenModels', 'providerOrder', 'collapsedModelProviders', 'recentModels', 'recentAgents', 'recentEfforts', 'diffLayoutPreference', 'diffWrapLines', 'gitChangesViewMode', 'nativeNotificationsEnabled', 'notificationMode', 'showTerminalQuickKeysOnDesktop', 'notifyOnSubtasks', 'dockBadgeEnabled', 'notifyOnCompletion', 'notifyOnError', 'notifyOnQuestion', 'notificationTemplates', 'summarizeLastMessage', 'summaryThreshold', 'summaryLength', 'maxLastMessageLength', 'persistChatDraft', 'inputSpellcheckEnabled', 'chatContentWidth', 'codeBlockLineWrap', 'showToolFileIcons', 'showTurnChangedFiles', 'showExpandedBashTools', 'showExpandedEditTools', 'timeFormatPreference', 'weekStartPreference', 'desktopWindowControlsPosition', 'desktopWindowControlsStyle', 'mermaidRenderingMode', 'userMessageRenderingMode', 'collapsibleUserMessages', 'stickyUserHeader', 'promptNavigatorEnabled', 'expandedEditorToolbar', 'draftStartersVisible', 'mobileSessionFilterProjectId', 'shortcutOverrides', 'fileEditorKeymap'],
  'config-store': ['settingsAutoCreateWorktree', 'settingsAutoUpdateChecksEnabled', 'settingsDefaultFileViewerPreview', 'settingsGitmojiEnabled', 'settingsZenModel', 'browserVoice', 'dictationEnabled', 'localTtsVoiceId', 'openaiCompatibleTtsModel', 'openaiCompatibleUrl', 'openaiCompatibleVoice', 'openaiVoice', 'sayVoice', 'showMessageTTSButtons', 'speechPitch', 'speechRate', 'speechVolume', 'sttLanguage', 'sttLocalModel', 'sttModel', 'sttProvider', 'sttServerUrl', 'sttSilenceHoldMs', 'sttSilenceThresholdDb', 'sttTranscribeOnStop', 'summarizeCharacterThreshold', 'summarizeMaxLength', 'summarizeMessageTTS', 'summarizeVoiceConversation', 'ttsInputMode', 'voiceProvider'],
  'varin.filesExplorer.v1': ['activeRuntimeKey', 'runtimeSnapshots'],
  'varin.gitRepositorySelection.v1': ['repositoryByWorkspace'],
  'varin.workOverview.v1': ['bySession', 'panelWidth'],
  'git-identities-store': ['selectedProfileId'],
  'varin.threadInlineCommentDrafts.v1': ['drafts', 'touchedAt'],
  'varin-thread-review-links': ['linksByOriginal'],
  'varin.sessionDisplay.v1': ['sessionGroupingMode', 'stickyZoneHeaders', 'showRecentSection', 'projectsSectionCollapsed', 'projectSortOrder', 'conversationTreeByHost'],
  'varin.modelPickerSections.v1': ['collapsedSections'],
  'mobile-worktree-order': ['orderByProject'],
  'mobile-session-tree': ['projectExpanded', 'worktreeExpanded'],
  'varin.botLayout.v1': ['sidebarOpen', 'ordinarySidebar', 'panelOpen', 'panelWidth', 'tab', 'activityScope', 'memoryScope', 'seen'],
  'varin.githubPrStatus.v1': ['entries'],
  'varin.messageQueue.v1': ['followUpBehavior'],
};
const plain = new Set(['lastDirectory', 'homeDirectory', 'activeProjectId', 'openInAppId', 'gitmojiEnabled', 'directoryTreeShowHidden', 'filesViewShowGitignored',
  'browserVoice', 'dictationEnabled', 'localTtsVoiceId', 'openaiCompatibleTtsModel', 'openaiCompatibleUrl', 'openaiCompatibleVoice', 'openaiVoice', 'sayVoice', 'showMessageTTSButtons', 'speechPitch', 'speechRate', 'speechVolume', 'sttLanguage', 'sttLocalModel', 'sttModel', 'sttProvider', 'sttServerUrl', 'sttSilenceHoldMs', 'sttSilenceThresholdDb', 'sttTranscribeOnStop', 'summarizeCharacterThreshold', 'summarizeMaxLength', 'summarizeMessageTTS', 'summarizeVoiceConversation', 'ttsInputMode', 'voiceProvider',
  'varin.editor-workbench.owner', 'varin.ipad.leftSidebarWidth', 'varin.ipad.rightSidebarWidth', 'varin:lastWorktreeSourceBranch', 'varin.workspaceSidebar.sortMode', 'varin.mobileKeyboardMode', 'varin.mobileLayout.v1', 'varin:plan:md-viewer-mode']);
const prefixedObjects: Readonly<Record<string, readonly string[]>> = {
  'varin.editor-workbench:': ['version', 'workspaceId', 'state'],
  'varin.integrate.conflict:': ['repoRoot', 'tempWorktreePath', 'sourceBranch', 'targetBranch', 'cleanTargetWorktrees', 'remainingCommits', 'currentCommit'],
  'varin.conflict:': ['directory', 'conflictFiles', 'operation'],
};
const objects: Readonly<Record<string, readonly string[]>> = {
  'varin.theme.v1': ['mode', 'lightThemeId', 'darkThemeId', 'splash'], 'varin.i18n.v1': ['locale'],
  'appearance-preferences': ['showReasoningTraces', 'collapsibleThinkingBlocks'], 'varin.sessionPinned.v1': ['sessions'],
  'varin.companion.association': ['botId'],
};
const secret = /^(?:__proto__|prototype|constructor|.*apiKey|.*password|clientToken|requestHeaders|authorization|accessToken|refreshToken|sessionToken|privateKey|grant)$/i;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function inert(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(inert);
  const object = record(value);
  if (object)
    return Object.fromEntries(Object.entries(object).filter(([key]) => !secret.test(key)).map(([key, value]) => [key, inert(value)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|auth|api.?key|signature/i.test(key)))
      return null;
  }
  return value;
}
function pick(value: unknown, fields: readonly string[]) { const source = record(value); return source ? Object.fromEntries(fields.filter(key => Object.hasOwn(source, key)).map(key => [key, inert(source[key])])) : null; }
export interface FrontendRecoveredDraft {
  target: string;
  message: Record<string, unknown>;
}
export interface DesktopFrontendPayload {
  schema: 1;
  entries: Record<string, string>;
  credentialSlots: string[];
  pendingDrafts: number;
  excludedEntries: number;
  indexedDb: 'no-product-owner';
}
/** Used on both sides: a native pipe does not weaken validation at import. */
export function exportDesktopFrontendEntries(entries: readonly (readonly [
  string,
  string
])[]): DesktopFrontendPayload {
  const output: Record<string, string> = {}, credentials = new Set<string>();
  const drafts: FrontendRecoveredDraft[] = [];
  let excludedEntries = 0;
  for (const [key, value] of entries) {
    if ((FRONTEND_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
      if (value)
        credentials.add(key);
      continue;
    }
    try {
      if (plain.has(key) || key.startsWith('varin.integrate.target:') || /^activeProjectId:[^\r\n]+$/.test(key)) {
        const cleaned = inert(value);
        if (typeof cleaned === 'string')
          output[key] = cleaned;
        else
          excludedEntries++;
        continue;
      }
      if (key === 'projects' || key === 'pinnedDirectories' || /^projects:[^\r\n]+$/.test(key)) {
        const data = JSON.parse(value);
        if (Array.isArray(data))
          output[key] = JSON.stringify(inert(data));
        else
          excludedEntries++;
        continue;
      }
      if (Object.hasOwn(stores, key)) {
        const envelope = record(JSON.parse(value)), state = record(envelope?.state);
        if (!envelope || !state) {
          excludedEntries++;
          continue;
        }
        if (key === 'config-store')
          for (const secret of FRONTEND_CREDENTIAL_KEYS)
            if (state[secret])
              credentials.add(`config-store.state.${secret}`);
        if (key === 'varin.messageQueue.v1') {
          const queues = record(state.queuedMessages);
          if (queues)
            for (const [target, messages] of Object.entries(queues))
              if (Array.isArray(messages))
                for (const message of messages) {
                  const data = record(message);
                  if (data && typeof data.content === 'string')
                    drafts.push({ target, message: pick(data, ['id', 'content', 'attachments', 'createdAt', 'sendConfig'])! });
                }
        }
        output[key] = JSON.stringify({ state: pick(state, stores[key]!), version: Number.isInteger(envelope.version) ? envelope.version : 0 });
        continue;
      }
      const prefix = Object.keys(prefixedObjects).find(prefix => key.startsWith(prefix) && key.length > prefix.length);
      if (prefix) {
        const data = pick(JSON.parse(value), prefixedObjects[prefix]!);
        if (data)
          output[key] = JSON.stringify(data);
        else
          excludedEntries++;
        continue;
      }
      if (Object.hasOwn(objects, key)) {
        const data = pick(JSON.parse(value), objects[key]!);
        if (data)
          output[key] = JSON.stringify(data);
        else
          excludedEntries++;
        continue;
      }
      excludedEntries++;
    }
    catch {
      excludedEntries++;
    }
  }
  if (drafts.length)
    output[FRONTEND_RECOVERED_DRAFTS_KEY] = JSON.stringify({ schema: 1, drafts });
  return { schema: 1, entries: Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b))), credentialSlots: [...credentials].sort(), pendingDrafts: drafts.length, excludedEntries, indexedDb: 'no-product-owner' };
}
export interface DesktopFrontendStage {
  schema: 1;
  id: string;
  digest: string;
  sourceOrigin: 'varin-ui://app';
  sourceVersion: string;
  stage: 'staged';
  payload: DesktopFrontendPayload;
}
export interface DesktopFrontendImportReceipt {
  id: string;
  digest: string;
  importedKeys: string[];
  retainedKeys: string[];
}
export function validateDesktopFrontendStage(value: unknown): DesktopFrontendStage {
  const v = record(value), p = record(v?.payload);
  if (!v || v.schema !== 1 || v.stage !== 'staged' || v.sourceOrigin !== 'varin-ui://app' || typeof v.id !== 'string' || !v.id || typeof v.digest !== 'string' || !/^[a-f0-9]{64}$/.test(v.digest) || typeof v.sourceVersion !== 'string' || !p || p.schema !== 1 || !record(p.entries) || Object.values(p.entries as object).some(v => typeof v !== 'string'))
    throw new Error('Invalid desktop frontend migration receipt');
  // The recovered queue is inert and has its own schema. Never hydrate it into
  // the auto-sending message queue during a shell transition.
  const allowedCredentialSlots = new Set(FRONTEND_CREDENTIAL_KEYS.flatMap(key => [key, `config-store.state.${key}`]));
  if (!Array.isArray(p.credentialSlots) || p.credentialSlots.some(slot => typeof slot !== 'string' || !allowedCredentialSlots.has(slot)) || new Set(p.credentialSlots).size !== p.credentialSlots.length || !Number.isSafeInteger(p.pendingDrafts) || Number(p.pendingDrafts) < 0 || !Number.isSafeInteger(p.excludedEntries) || Number(p.excludedEntries) < 0 || p.indexedDb !== 'no-product-owner')
    throw new Error('Invalid desktop frontend migration metadata');
  const entries = p.entries as Record<string, string>;
  const recovered = entries[FRONTEND_RECOVERED_DRAFTS_KEY];
  const safe = exportDesktopFrontendEntries(Object.entries(entries));
  let recoveredCount = 0;
  if (recovered !== undefined) {
    const recovery = record(JSON.parse(recovered));
    if (recovery?.schema !== 1 || !Array.isArray(recovery.drafts) || recovery.drafts.some(d => !record(d) || typeof d.target !== 'string' || typeof record(d.message)?.content !== 'string'))
      throw new Error('Invalid recovered drafts');
    recoveredCount = recovery.drafts.length;
    safe.entries[FRONTEND_RECOVERED_DRAFTS_KEY] = JSON.stringify({ schema: 1, drafts: recovery.drafts.map(d => ({ target: d.target, message: pick(d.message, ['id', 'content', 'attachments', 'createdAt', 'sendConfig']) })) });
  }
  if (p.pendingDrafts !== recoveredCount)
    throw new Error('Recovered draft count does not match the migration receipt');
  if (JSON.stringify(Object.entries(entries).sort()) !== JSON.stringify(Object.entries(safe.entries).sort()))
    throw new Error('Migration contains data outside the UI allowlist');
  return value as DesktopFrontendStage;
}
