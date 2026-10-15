import type { SurfaceActivationContext } from '@varin/extension-surface';
import { toast } from '@/components/ui';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { createWorktreeThread } from '@/lib/agent-runtime/worktreeThread';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { useUIStore } from '@/stores/useUIStore';
import { getDocumentRegistry } from '@/lib/documents/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import {
  closeWorkbenchEditor,
  ensureEditorWorkbench,
  getActiveWorkbenchWorkspaceId,
  splitActiveEditor,
} from '@/lib/workbench/editors/session';
import type { WorkbenchCommandImplementation, WorkbenchCommandMeta } from './surface-command-types';
import { requestIdeSearch } from '@/lib/workbench/ide-search-events';
import {
  executeActiveFileEditorCommand,
  FILE_EDITOR_COMMAND_IDS,
  hasActiveFileEditorCommandTarget,
  type FileEditorCommandId,
} from '@/lib/monaco/editor-command-service';

export const BUILTIN_COMMANDS_EXTENSION_ID = 'varin.builtin.commands';

interface BuiltinCommandDefinition {
  implementation: WorkbenchCommandImplementation;
  meta: WorkbenchCommandMeta;
}

const command = (
  meta: WorkbenchCommandMeta,
  execute: WorkbenchCommandImplementation['execute'],
): BuiltinCommandDefinition => ({ meta, implementation: { execute } });

const editorCommand = (meta: WorkbenchCommandMeta, commandId: FileEditorCommandId): BuiltinCommandDefinition => ({
  meta,
  implementation: {
    execute: async () => {
      await executeActiveFileEditorCommand(commandId);
    },
    isAvailable: () => hasActiveFileEditorCommandTarget(),
  },
});

const contributionIdForCommand = (commandId: string): string => (
  `${BUILTIN_COMMANDS_EXTENSION_ID}.${commandId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
);

const reportFailure = (title: string, error: unknown): void => {
  toast.error(title, { description: error instanceof Error ? error.message : String(error) });
};

const BUILTIN_WORKBENCH_COMMANDS: readonly BuiltinCommandDefinition[] = [
  command({ commandId: 'new-session', titleKey: 'commandPalette.item.newSession', icon: 'add', shortcutId: 'new_chat', keywords: ['new', 'session'], order: 0 }, async () => {
    try {
      await startThreadFromNavigation();
    } catch (error) {
      reportFailure('Failed to create conversation', error);
    }
  }),
  command({ commandId: 'new-worktree', titleKey: 'commandPalette.item.newWorktreeDraft', icon: 'git-branch', shortcutId: 'new_chat_worktree', keywords: ['new', 'worktree', 'session'], order: 1 }, async () => {
    try {
      await createWorktreeThread();
    } catch (error) {
      reportFailure('Failed to create worktree conversation', error);
    }
  }),
  command({ commandId: 'add-project', titleKey: 'commandPalette.item.addProject', icon: 'folder-add', keywords: ['add', 'project', 'workspace'], order: 2 }, () => {
    workspaceEvents.requestDirectoryDialog();
  }),
  command({ commandId: 'workspace-search', titleKey: 'workbench.ide.activity.search', icon: 'search', shortcutId: 'toggle_files', keywords: ['search', 'workspace', 'text', 'files'], order: 2.5 }, ({ currentDirectory }) => {
    if (requestIdeSearch({ mode: 'content' })) return;
    if (currentDirectory) useUIStore.getState().openContextSurface(currentDirectory, 'file');
  }),
  command({ commandId: 'toggle-sidebar', titleKey: 'commandPalette.item.toggleSidebar', mobileTitleKey: 'commandPalette.item.showSessionSwitcher', icon: 'layout-left', shortcutId: 'toggle_sidebar', keywords: ['sidebar', 'session switcher'], order: 3 }, ({ isMobile }) => {
    const state = useUIStore.getState();
    if (isMobile) state.setSessionSwitcherOpen(!state.isSessionSwitcherOpen);
    else state.toggleSidebar();
  }),
  command({ commandId: 'toggle-terminal', titleKey: 'commandPalette.item.toggleTerminal', icon: 'terminal-box', shortcutId: 'toggle_terminal', keywords: ['terminal', 'shell'], order: 4 }, ({ currentDirectory }) => {
    if (currentDirectory) useUIStore.getState().openContextSurface(currentDirectory, 'terminal');
  }),
  command({ commandId: 'context-usage', titleKey: 'commandPalette.item.showContextUsage', icon: 'pie-chart', keywords: ['context', 'usage'], order: 5 }, ({ currentDirectory }) => {
    if (currentDirectory) useUIStore.getState().openContextOverview(currentDirectory);
  }),
  command({ commandId: 'open-settings', titleKey: 'commandPalette.item.openSettings', icon: 'settings-3', shortcutId: 'open_settings', keywords: ['settings', 'preferences'], order: 6 }, () => {
    useUIStore.getState().setSettingsDialogOpen(true);
  }),
  command({ commandId: 'split-editor', titleKey: 'commandPalette.item.splitEditor', icon: 'split-cells-horizontal', keywords: ['split', 'editor'], order: 7 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (workspaceId) splitActiveEditor(workspaceId, 'vertical');
  }),
  command({ commandId: 'split-editor-orthogonal', titleKey: 'commandPalette.item.splitEditorOrthogonal', icon: 'split-cells-horizontal', keywords: ['split', 'editor', 'horizontal'], order: 8 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (workspaceId) splitActiveEditor(workspaceId, 'horizontal');
  }),
  command({ commandId: 'close-editor', titleKey: 'commandPalette.item.closeEditor', icon: 'close', keywords: ['close', 'editor'], order: 9 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (!workspaceId) return;
    const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
    if (tab) closeWorkbenchEditor(workspaceId, tab.tabId);
  }),
  command({ commandId: 'save-active-file', titleKey: 'commandPalette.item.saveActiveFile', icon: 'save-3', shortcutId: 'editor_save', keywords: ['save', 'file', 'editor'], order: 10 }, async () => {
    if (await executeActiveFileEditorCommand(FILE_EDITOR_COMMAND_IDS.save)) return;
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (!workspaceId) return;
    const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
    if (!tab) return;
    try {
      void getDocumentRegistry().save({ workspaceId, resourceId: tab.resourceId }).catch((error) => {
        reportFailure('Failed to save file', error);
      });
    } catch (error) {
      reportFailure('Failed to save file', error);
    }
  }),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.saveAll, titleKey: 'commandPalette.item.saveAllFiles', icon: 'save-3', keywords: ['save', 'all', 'files'], order: 11 }, FILE_EDITOR_COMMAND_IDS.saveAll),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.find, titleKey: 'commandPalette.item.findInFile', icon: 'search', shortcutId: 'editor_find', keywords: ['find', 'search', 'file'], order: 12 }, FILE_EDITOR_COMMAND_IDS.find),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.replace, titleKey: 'commandPalette.item.replaceInFile', icon: 'edit', shortcutId: 'editor_replace', keywords: ['replace', 'find', 'file'], order: 13 }, FILE_EDITOR_COMMAND_IDS.replace),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.goToLine, titleKey: 'commandPalette.item.goToLine', icon: 'file-text', shortcutId: 'open_go_to_line', keywords: ['go', 'line', 'editor'], order: 14 }, FILE_EDITOR_COMMAND_IDS.goToLine),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.goToSymbol, titleKey: 'commandPalette.item.goToSymbol', icon: 'list-unordered', keywords: ['go', 'symbol', 'outline'], order: 15 }, FILE_EDITOR_COMMAND_IDS.goToSymbol),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.format, titleKey: 'commandPalette.item.formatDocument', icon: 'code', keywords: ['format', 'document', 'editor'], order: 16 }, FILE_EDITOR_COMMAND_IDS.format),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.rename, titleKey: 'commandPalette.item.renameSymbol', icon: 'edit-2', shortcutId: 'editor_rename', keywords: ['rename', 'symbol', 'refactor'], order: 17 }, FILE_EDITOR_COMMAND_IDS.rename),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.quickFix, titleKey: 'commandPalette.item.quickFix', icon: 'code-ai', shortcutId: 'editor_quick_fix', keywords: ['quick', 'fix', 'code action'], order: 18 }, FILE_EDITOR_COMMAND_IDS.quickFix),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.definition, titleKey: 'commandPalette.item.goToDefinition', icon: 'file-search', keywords: ['definition', 'go', 'symbol'], order: 19 }, FILE_EDITOR_COMMAND_IDS.definition),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.references, titleKey: 'commandPalette.item.findReferences', icon: 'menu-search', keywords: ['references', 'find', 'symbol'], order: 20 }, FILE_EDITOR_COMMAND_IDS.references),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.fold, titleKey: 'commandPalette.item.foldRegion', icon: 'menu-fold-2', keywords: ['fold', 'collapse', 'code'], order: 21 }, FILE_EDITOR_COMMAND_IDS.fold),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.unfold, titleKey: 'commandPalette.item.unfoldRegion', icon: 'menu-fold-2', keywords: ['unfold', 'expand', 'code'], order: 22 }, FILE_EDITOR_COMMAND_IDS.unfold),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.toggleWrap, titleKey: 'commandPalette.item.toggleEditorWrap', icon: 'text-wrap', keywords: ['wrap', 'line', 'editor'], order: 23 }, FILE_EDITOR_COMMAND_IDS.toggleWrap),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.toggleMinimap, titleKey: 'commandPalette.item.toggleEditorMinimap', icon: 'file-list-2', keywords: ['minimap', 'editor', 'toggle'], order: 24 }, FILE_EDITOR_COMMAND_IDS.toggleMinimap),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.cursorAbove, titleKey: 'commandPalette.item.addCursorAbove', icon: 'cursor', shortcutId: 'editor_cursor_above', keywords: ['cursor', 'above', 'multi cursor'], order: 25 }, FILE_EDITOR_COMMAND_IDS.cursorAbove),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.cursorBelow, titleKey: 'commandPalette.item.addCursorBelow', icon: 'cursor', shortcutId: 'editor_cursor_below', keywords: ['cursor', 'below', 'multi cursor'], order: 26 }, FILE_EDITOR_COMMAND_IDS.cursorBelow),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.focusPreviousGroup, titleKey: 'commandPalette.item.focusPreviousEditorGroup', icon: 'arrow-left', keywords: ['focus', 'previous', 'editor group'], order: 27 }, FILE_EDITOR_COMMAND_IDS.focusPreviousGroup),
  editorCommand({ commandId: FILE_EDITOR_COMMAND_IDS.focusNextGroup, titleKey: 'commandPalette.item.focusNextEditorGroup', icon: 'arrow-right', keywords: ['focus', 'next', 'editor group'], order: 28 }, FILE_EDITOR_COMMAND_IDS.focusNextGroup),
];

export const registerBuiltinWorkbenchCommands = (context: SurfaceActivationContext): void => {
  for (const definition of BUILTIN_WORKBENCH_COMMANDS) {
    context.contribute({
      // Command IDs are execution contracts and may use Monaco-style camelCase. Surface
      // contribution IDs are separate identities whose contract requires lowercase segments.
      id: contributionIdForCommand(definition.meta.commandId),
      kind: 'command',
      contractVersion: 1,
      supports: ['web', 'desktop', 'mobile'],
      placement: { slot: 'command-palette.primary', order: definition.meta.order },
      data: {
        commandId: definition.meta.commandId,
        titleKey: definition.meta.titleKey,
        ...(definition.meta.mobileTitleKey ? { mobileTitleKey: definition.meta.mobileTitleKey } : {}),
        icon: definition.meta.icon,
        keywords: definition.meta.keywords,
        order: definition.meta.order,
        ...(definition.meta.shortcutId ? { shortcutId: definition.meta.shortcutId } : {}),
      },
    }, definition.implementation);
  }
};
