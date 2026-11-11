import { getEditorResourceWorkspace } from '@/lib/workbench/editors/resource-workspace';
import type { editor } from 'monaco-editor/editor';

import type { DocumentIdentity } from '@/lib/documents/types';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { FileEditorSettings, FileEditorSettingsPatch } from '@/lib/file-editor-settings';
import { eventMatchesShortcut, getEffectiveShortcutCombo, type ShortcutCombo } from '@/lib/shortcuts';
import {
  getActiveWorkbenchWorkspaceId,
  listEditorWorkbenches,
  peekEditorWorkbench,
  setActiveWorkbenchEditorView,
} from '@/lib/workbench/editors/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import {
  getWorkbenchContextKey,
  setWorkbenchContextKey,
} from '@/lib/workbench/editors/context-keys';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';

export const FILE_EDITOR_COMMAND_IDS = {
  save: 'save-active-file',
  saveAll: 'editor.saveAll',
  find: 'editor.find',
  replace: 'editor.replace',
  goToLine: 'editor.goToLine',
  goToSymbol: 'editor.goToSymbol',
  format: 'editor.formatDocument',
  rename: 'editor.renameSymbol',
  quickFix: 'editor.quickFix',
  definition: 'editor.goToDefinition',
  references: 'editor.findReferences',
  fold: 'editor.fold',
  unfold: 'editor.unfold',
  toggleWrap: 'editor.toggleWordWrap',
  toggleMinimap: 'editor.toggleMinimap',
  cursorAbove: 'editor.addCursorAbove',
  cursorBelow: 'editor.addCursorBelow',
  focusPreviousGroup: 'editor.focusPreviousGroup',
  focusNextGroup: 'editor.focusNextGroup',
} as const;

export type FileEditorCommandId = typeof FILE_EDITOR_COMMAND_IDS[keyof typeof FILE_EDITOR_COMMAND_IDS];

type FileEditorCommandTarget = {
  documents?: ReturnType<typeof getDocumentRegistry>;
  editorWorkspaceId?: string;
  editor: editor.IStandaloneCodeEditor;
  identity: DocumentIdentity;
  ownerId: string;
  getSettings(): FileEditorSettings;
  getShortcutOverrides(): Record<string, ShortcutCombo>;
  onCommandError?(commandId: FileEditorCommandId, error: unknown): void;
  onCommandUnavailable?(commandId: FileEditorCommandId): void;
  updateSettings(patch: FileEditorSettingsPatch): void;
  viewId: string;
};

const targets = new Map<string, FileEditorCommandTarget>();
const pendingNavigation = new Map<string, { column: number; line: number }>();
let activeOwnerId: string | null = null;
const bridgeDisposers: Array<() => void> = [];
const targetListeners = new Set<() => void>();
let targetRevision = 0;

const emitTargetChange = (): void => {
  targetRevision += 1;
  for (const listener of targetListeners) listener();
};

export const getFileEditorCommandTargetRevision = (): number => targetRevision;

export const subscribeFileEditorCommandTargets = (listener: () => void): (() => void) => {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
};

const activeTarget = (): FileEditorCommandTarget | null => {
  const focused = activeOwnerId ? targets.get(activeOwnerId) : undefined;
  if (focused) return focused;
  const workspaceId = getActiveWorkbenchWorkspaceId();
  const workbench = workspaceId ? peekEditorWorkbench(workspaceId) : undefined;
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  if (!tab || !workspaceId) return null;
  return [...targets.values()].find((target) => (
    (target.editorWorkspaceId ?? target.identity.workspaceId) === workspaceId && target.viewId === tab.viewId
  )) ?? null;
};

const targetForIdentity = (identity: DocumentIdentity, viewId?: string): FileEditorCommandTarget | null => (
  [...targets.values()].find((target) => (
    target.identity.workspaceId === identity.workspaceId
    && target.identity.resourceId === identity.resourceId
    && (viewId === undefined || target.viewId === viewId)
  )) ?? null
);

const identityKey = (identity: DocumentIdentity): string => (
  `${identity.workspaceId}\0${identity.resourceId}`
);

const navigationKey = (identity: DocumentIdentity, viewId?: string): string => (
  `${identityKey(identity)}\0${viewId ?? ''}`
);

const activateTarget = (target: FileEditorCommandTarget, focus = false): void => {
  activeOwnerId = target.ownerId;
  setActiveWorkbenchEditorView(target.editorWorkspaceId ?? target.identity.workspaceId, target.viewId);
  if (focus) target.editor.focus();
  refreshContext(true);
};

const revealTargetPosition = (
  target: FileEditorCommandTarget,
  line: number,
  column: number,
): void => {
  const model = target.editor.getModel();
  if (!model) return;
  const lineNumber = Math.min(Math.max(1, Math.floor(line)), model.getLineCount());
  const position = {
    lineNumber,
    column: Math.min(Math.max(1, Math.floor(column)), model.getLineMaxColumn(lineNumber)),
  };
  activateTarget(target, true);
  target.editor.setPosition(position);
  target.editor.revealPositionInCenter(position);
};

export const requestFileEditorNavigation = (
  identity: DocumentIdentity,
  line: number,
  column: number,
  viewId?: string,
): boolean => {
  const target = targetForIdentity(identity, viewId);
  if (!target) {
    pendingNavigation.set(navigationKey(identity, viewId), { column, line });
    return false;
  }
  pendingNavigation.delete(navigationKey(identity, viewId));
  revealTargetPosition(target, line, column);
  return true;
};

const setContext = (key: string, value: string | boolean | number): void => {
  setWorkbenchContextKey(key, value);
};

const refreshContext = (focused = getWorkbenchContextKey('editorTextFocus') === true): void => {
  const target = activeTarget();
  setContext('editorIsOpen', targets.size > 0);
  setContext('editorTextFocus', Boolean(target && focused));
  if (!target) {
    setContext('editorHasSelection', false);
    setContext('editorLanguageId', '');
    setContext('editorWordWrap', false);
    setContext('editorMinimap', false);
    return;
  }
  const raw = target.editor.getRawOptions();
  setContext('editorHasSelection', Boolean(target.editor.getSelection() && !target.editor.getSelection()?.isEmpty()));
  setContext('editorLanguageId', target.editor.getModel()?.getLanguageId() ?? 'plaintext');
  setContext('editorWordWrap', raw.wordWrap === 'on');
  setContext('editorMinimap', raw.minimap?.enabled === true);
};

const runAction = async (target: FileEditorCommandTarget, actionId: string): Promise<boolean> => {
  const action = target.editor.getAction(actionId);
  if (!action?.isSupported()) return false;
  await action.run();
  return true;
};

export const saveFileEditorDocument = async (identity: DocumentIdentity, documents?: ReturnType<typeof getDocumentRegistry>, viewId?: string): Promise<void> => {
  const target = targetForIdentity(identity, viewId);
  if (target?.getSettings().formatOnSave) {
    await runAction(target, 'editor.action.formatDocument').catch(() => undefined);
  }
  await (documents ?? target?.documents ?? getDocumentRegistry()).save(identity);
};

const saveTarget = async (target: FileEditorCommandTarget): Promise<void> => {
  await saveFileEditorDocument(target.identity, target.documents, target.viewId);
};

const saveAll = async (): Promise<void> => {
  const saves: Array<Promise<unknown>> = [];
  for (const workbench of listEditorWorkbenches()) {
    const resource = getEditorResourceWorkspace(workbench.workspaceId);
    const registry = resource?.scope.documents ?? getDocumentRegistry();
    const workspaceId = resource?.documentWorkspaceId ?? workbench.workspaceId;
    for (const resourceId of registry.dirtyResourceIds(workspaceId)) {
      saves.push(saveFileEditorDocument({ workspaceId, resourceId }, registry));
    }
  }
  await Promise.all(saves);
};

const toggleSetting = (target: FileEditorCommandTarget, field: 'wordWrap' | 'minimap'): void => {
  const raw = target.editor.getRawOptions();
  const currentlyEnabled = field === 'wordWrap'
    ? raw.wordWrap === 'on'
    : raw.minimap?.enabled === true;
  target.updateSettings({ [field]: currentlyEnabled ? 'off' : 'on' });
};

const focusAdjacentGroup = (direction: -1 | 1): void => {
  const current = activeTarget();
  if (!current) return;
  const peers = [...targets.values()].filter((target) => target.identity.workspaceId === current.identity.workspaceId);
  if (peers.length < 2) return;
  const index = Math.max(0, peers.findIndex((target) => target.ownerId === current.ownerId));
  const next = peers[(index + direction + peers.length) % peers.length];
  if (!next) return;
  activeOwnerId = next.ownerId;
  setActiveWorkbenchEditorView(next.identity.workspaceId, next.viewId);
  next.editor.focus();
  refreshContext(true);
};

export const hasActiveFileEditorCommandTarget = (): boolean => activeTarget() !== null;

export const executeFileEditorCommand = async (
  identity: DocumentIdentity,
  commandId: FileEditorCommandId,
  viewId?: string,
): Promise<boolean> => {
  const target = targetForIdentity(identity, viewId);
  if (!target) return false;
  activateTarget(target);
  return executeFileEditorCommandOnTarget(target, commandId);
};

const executeFileEditorCommandOnTarget = async (
  target: FileEditorCommandTarget,
  commandId: FileEditorCommandId,
): Promise<boolean> => {
  switch (commandId) {
    case FILE_EDITOR_COMMAND_IDS.save:
      await saveTarget(target);
      return true;
    case FILE_EDITOR_COMMAND_IDS.saveAll:
      await saveAll();
      return true;
    case FILE_EDITOR_COMMAND_IDS.find:
      return runAction(target, 'actions.find');
    case FILE_EDITOR_COMMAND_IDS.replace:
      return runAction(target, 'editor.action.startFindReplaceAction');
    case FILE_EDITOR_COMMAND_IDS.goToLine:
      return runAction(target, 'editor.action.gotoLine');
    case FILE_EDITOR_COMMAND_IDS.goToSymbol:
      return runAction(target, 'editor.action.quickOutline');
    case FILE_EDITOR_COMMAND_IDS.format:
      return runAction(target, 'editor.action.formatDocument');
    case FILE_EDITOR_COMMAND_IDS.rename:
      return runAction(target, 'editor.action.rename');
    case FILE_EDITOR_COMMAND_IDS.quickFix:
      return runAction(target, 'editor.action.quickFix');
    case FILE_EDITOR_COMMAND_IDS.definition:
      return runAction(target, 'editor.action.revealDefinition');
    case FILE_EDITOR_COMMAND_IDS.references:
      return runAction(target, 'editor.action.referenceSearch.trigger');
    case FILE_EDITOR_COMMAND_IDS.fold:
      return runAction(target, 'editor.fold');
    case FILE_EDITOR_COMMAND_IDS.unfold:
      return runAction(target, 'editor.unfold');
    case FILE_EDITOR_COMMAND_IDS.toggleWrap:
      toggleSetting(target, 'wordWrap');
      return true;
    case FILE_EDITOR_COMMAND_IDS.toggleMinimap:
      toggleSetting(target, 'minimap');
      return true;
    case FILE_EDITOR_COMMAND_IDS.cursorAbove:
      return runAction(target, 'editor.action.insertCursorAbove');
    case FILE_EDITOR_COMMAND_IDS.cursorBelow:
      return runAction(target, 'editor.action.insertCursorBelow');
    case FILE_EDITOR_COMMAND_IDS.focusPreviousGroup:
      focusAdjacentGroup(-1);
      return true;
    case FILE_EDITOR_COMMAND_IDS.focusNextGroup:
      focusAdjacentGroup(1);
      return true;
  }
  return false;
};

export const executeActiveFileEditorCommand = async (commandId: FileEditorCommandId): Promise<boolean> => {
  const target = activeTarget();
  if (!target) return false;
  return executeFileEditorCommandOnTarget(target, commandId);
};

const shortcutCommands: ReadonlyArray<[shortcutId: string, commandId: FileEditorCommandId]> = [
  ['editor_save', FILE_EDITOR_COMMAND_IDS.save],
  ['editor_find', FILE_EDITOR_COMMAND_IDS.find],
  ['editor_replace', FILE_EDITOR_COMMAND_IDS.replace],
  ['open_go_to_line', FILE_EDITOR_COMMAND_IDS.goToLine],
  ['editor_rename', FILE_EDITOR_COMMAND_IDS.rename],
  ['editor_quick_fix', FILE_EDITOR_COMMAND_IDS.quickFix],
  ['editor_cursor_above', FILE_EDITOR_COMMAND_IDS.cursorAbove],
  ['editor_cursor_below', FILE_EDITOR_COMMAND_IDS.cursorBelow],
];

const installWorkbenchProjection = (): void => {
  if (bridgeDisposers.length > 0) return;
  const ownerId = 'varin.monaco.editor-commands';
  for (const commandId of Object.values(FILE_EDITOR_COMMAND_IDS)) {
    bridgeDisposers.push(registerWorkbenchCommand(commandId, ownerId, async () => {
      await executeActiveFileEditorCommand(commandId);
    }));
  }
  const menuItems = [
    [FILE_EDITOR_COMMAND_IDS.save, 'editor/title', 10],
    [FILE_EDITOR_COMMAND_IDS.find, 'editor/context', 20],
    [FILE_EDITOR_COMMAND_IDS.replace, 'editor/context', 21],
    [FILE_EDITOR_COMMAND_IDS.definition, 'editor/context', 30],
    [FILE_EDITOR_COMMAND_IDS.references, 'editor/context', 31],
    [FILE_EDITOR_COMMAND_IDS.rename, 'editor/context', 32],
    [FILE_EDITOR_COMMAND_IDS.quickFix, 'editor/context', 33],
  ] as const;
  for (const [commandId, group, order] of menuItems) {
    bridgeDisposers.push(registerWorkbenchMenuItem({
      id: `menu.${commandId}`,
      commandId,
      group,
      order,
      when: { editorIsOpen: true },
    }));
  }
};

const uninstallWorkbenchProjection = (): void => {
  for (const dispose of bridgeDisposers.splice(0)) dispose();
};

export const registerFileEditorCommandTarget = (target: FileEditorCommandTarget): (() => void) => {
  targets.set(target.ownerId, target);
  if (!activeOwnerId) activeOwnerId = target.ownerId;
  installWorkbenchProjection();
  refreshContext();
  emitTargetChange();

  const domNode = target.editor.getDomNode();
  const handleShortcut = (browserEvent: KeyboardEvent): void => {
    if (browserEvent.isComposing) return;
    for (const [shortcutId, commandId] of shortcutCommands) {
      const combo = getEffectiveShortcutCombo(shortcutId, target.getShortcutOverrides());
      if (!combo || !eventMatchesShortcut(browserEvent, combo)) continue;
      browserEvent.preventDefault();
      browserEvent.stopPropagation();
      activateTarget(target);
      void executeFileEditorCommandOnTarget(target, commandId).then((available) => {
        if (!available) target.onCommandUnavailable?.(commandId);
      }).catch((error) => target.onCommandError?.(commandId, error));
      return;
    }
  };
  domNode?.addEventListener('keydown', handleShortcut, true);

  const exactNavigationKey = navigationKey(target.identity, target.viewId);
  const fallbackNavigationKey = navigationKey(target.identity);
  const navigation = pendingNavigation.get(exactNavigationKey)
    ?? pendingNavigation.get(fallbackNavigationKey);
  if (navigation) {
    pendingNavigation.delete(exactNavigationKey);
    pendingNavigation.delete(fallbackNavigationKey);
    queueMicrotask(() => {
      if (targets.get(target.ownerId) === target) {
        revealTargetPosition(target, navigation.line, navigation.column);
      }
    });
  }

  const disposables = [
    target.editor.onDidFocusEditorText(() => {
      activeOwnerId = target.ownerId;
      setActiveWorkbenchEditorView(target.editorWorkspaceId ?? target.identity.workspaceId, target.viewId);
      refreshContext(true);
    }),
    target.editor.onDidBlurEditorText(() => {
      if (activeOwnerId === target.ownerId) {
        activeOwnerId = null;
        refreshContext(false);
      }
    }),
    target.editor.onDidChangeCursorSelection(() => {
      if (activeOwnerId === target.ownerId) refreshContext(true);
    }),
    target.editor.onDidChangeModelLanguage(() => {
      if (activeOwnerId === target.ownerId) refreshContext(true);
    }),
  ];

  return () => {
    domNode?.removeEventListener('keydown', handleShortcut, true);
    for (const disposable of disposables) disposable.dispose();
    if (targets.get(target.ownerId) !== target) return;
    const removedActiveTarget = activeOwnerId === target.ownerId;
    targets.delete(target.ownerId);
    if (removedActiveTarget) activeOwnerId = null;
    refreshContext(removedActiveTarget ? false : undefined);
    if (targets.size === 0) uninstallWorkbenchProjection();
    emitTargetChange();
  };
};

export const resetFileEditorCommandServiceForTests = (): void => {
  targets.clear();
  pendingNavigation.clear();
  activeOwnerId = null;
  uninstallWorkbenchProjection();
  refreshContext(false);
  emitTargetChange();
};
