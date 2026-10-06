import type { JsonValue } from '@varin/extension-contract';

export type EditorProviderViewState = {
  providerId: string;
  schemaVersion: number;
  value: JsonValue;
};

export type EditorViewState = {
  diffLayout?: 'auto' | 'inline' | 'split';
  browserTabId?: string;
  browserUrl?: string;
  browserPosition?: { x: number; y: number };
  editorInfo?: { line: number; column: number; languageId: string; languageName?: string; tabSize: number; insertSpaces: boolean };
  /** Which Git revision the diff viewer compares against, for diff-provider tabs. */
  diffScope?: 'working' | 'staged';
  /** Repository root relative to the workspace, so nested Git repositories remain addressable. */
  diffRepositoryResourceId?: string;
  previewMode?: 'preview' | 'edit' | 'tree' | 'text';
  previewScrollTop?: number;
  providerState?: EditorProviderViewState;
};

export type EditorTab = {
  tabId: string;
  viewId: string;
  resourceId: string;
  preview: boolean;
  pinned: boolean;
  providerId: string;
  /**
   * The caller chose this provider explicitly, so provider resolution must not replace it.
   * Without this the host re-resolves on every render and an explicitly requested provider,
   * such as the Git diff viewer, is silently overridden by the resource's default.
   */
  providerPinned?: boolean;
  viewState: EditorViewState;
};

export type EditorGroupLeaf = {
  type: 'group';
  groupId: string;
  tabs: EditorTab[];
  activeTabId: string | null;
};

export type EditorGroupSplit = {
  type: 'split';
  splitId: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  first: EditorGroupNode;
  second: EditorGroupNode;
};

export type EditorGroupNode = EditorGroupLeaf | EditorGroupSplit;

export type EditorWorkbenchState = {
  workspaceId: string;
  tree: EditorGroupNode;
  activeGroupId: string;
};

export type SnapshotRestoreResult =
  | { status: 'missing' }
  | { status: 'empty' }
  | { status: 'malformed' }
  | { status: 'failure'; errorMessage: string }
  | { status: 'ready'; state: EditorWorkbenchState; migrated?: boolean };

export type EditorProviderContribution = {
  id: string;
  extensionId: string;
  enabled: boolean;
  languages?: string[];
  filenames?: string[];
  priority: number;
  fallback?: boolean;
};

export const BUILTIN_EDITOR_PROVIDER_IDS = {
  browser: 'varin.builtin.browser',
  text: 'varin.builtin.text',
  markdown: 'varin.builtin.markdown',
  json: 'varin.builtin.json',
  html: 'varin.builtin.html',
  drawio: 'varin.builtin.drawio',
  image: 'varin.builtin.image',
  pdf: 'varin.builtin.pdf',
  diff: 'varin.builtin.diff',
  /**
   * Git working-tree/staged diff for a tracked file. Declares no languages and is never a
   * fallback, so resolution never selects it; callers request it explicitly with a pinned tab.
   */
  gitDiff: 'varin.builtin.git-diff',
} as const;

export type BuiltinEditorProviderId = typeof BUILTIN_EDITOR_PROVIDER_IDS[keyof typeof BUILTIN_EDITOR_PROVIDER_IDS];

export type WorkbenchPanelId = 'terminal' | 'problems' | 'output' | 'changes';

export type WorkbenchPanelLayout = {
  workspaceId: string;
  visible: boolean;
  activePanelId: WorkbenchPanelId;
  size: number;
};

export type WorkbenchProblemsSnapshot =
  | { status: 'empty' }
  | {
      status: 'ready';
      items: Array<{
        resourceId: string;
        message: string;
        severity: 'error' | 'warning' | 'info';
        line?: number;
        column?: number;
      }>;
    }
  | { status: 'failure'; errorMessage: string };

export type WorkbenchOutputSnapshot =
  | { status: 'empty' }
  | { status: 'ready'; channels: Array<{ id: string; title: string }> }
  | { status: 'failure'; errorMessage: string };

export type WorkbenchMenuItem = {
  id: string;
  commandId: string;
  group: string;
  order: number;
  when?: Record<string, string | boolean | number>;
};

export type EditorProviderSelection =
  | { status: 'none' }
  | { status: 'selected'; providerId: string }
  | { status: 'ambiguous'; providerIds: string[] };

export const EDITOR_WORKBENCH_SNAPSHOT_VERSION = 2 as const;
