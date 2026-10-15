import React from 'react';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { recordHintsFromToolCall } from '@/lib/agent-editor/hints';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { attachActiveEditorContext } from '@/features/agent-editor/attach-active-editor';
import { peekEditorSessionLink } from '@/lib/agent-editor/navigation';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import {
  peekEditorWorkbench,
  subscribeEditorWorkbench,
} from '@/lib/workbench/editors/session';
import { getWorkbenchProblems, showWorkbenchPanel } from '@/lib/workbench/editors/panels';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  activateEditorContextOwner,
  useEditorContextStore,
} from '@/stores/useEditorContextStore';
import { useThreadStore, threadIdentityKey } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';

const ATTACH_ERROR_KEYS = {
  'missing-editor': 'workbench.attachment.missing-editor',
  'missing-selection': 'workbench.attachment.missing-selection',
  'missing-document': 'workbench.attachment.missing-document',
  'wrong-runtime': 'workbench.attachment.wrong-runtime',
  'no-session': 'workbench.attachment.no-session',
} as const satisfies Record<string, I18nKey>;

const OWNER = 'varin.builtin.workbench';

export const AgentEditorCoordinator: React.FC = () => {
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = useThreadStore(state => state.selectedIdentity ? threadIdentityKey(state.hostKey, state.selectedIdentity) : null);
  const runtimeKey = getRuntimeKey();
  const { snapshot } = useSelectedThreadSnapshot();
  const toolExecutions = snapshot?.operations;
  const workbench = React.useSyncExternalStore(
    subscribeEditorWorkbench,
    () => (workspaceId ? peekEditorWorkbench(workspaceId) : undefined),
    () => undefined,
  );
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const activeEditorFile = useEditorContextStore((state) => state.activeEditorFile);
  const activeOwnerId = tab ? `view:${tab.viewId}` : null;

  React.useEffect(() => {
    activateEditorContextOwner(activeOwnerId);
    return () => activateEditorContextOwner(null);
  }, [activeOwnerId]);

  React.useEffect(() => {
    const current = activeEditorFile?.workspaceId === workspaceId ? activeEditorFile : null;
    setWorkbenchContextKey('editorIsOpen', current !== null);
    setWorkbenchContextKey('editorIsDirty', current?.dirty === true);
    setWorkbenchContextKey('editorHasSelection', current?.selection !== null && current?.selection !== undefined);
  }, [activeEditorFile, workspaceId]);

  React.useEffect(() => () => {
    setWorkbenchContextKey('editorIsOpen', false);
    setWorkbenchContextKey('editorIsDirty', false);
    setWorkbenchContextKey('editorHasSelection', false);
  }, []);

  React.useEffect(() => {
    if (!sessionId || !workspaceId || !directory || !toolExecutions) return;
    const source = snapshot?.launch?.selection.source;
    if (!source || source.mode !== 'live_root' || source.workspace_id !== workspaceId || source.live_root?.canonicalRoot !== directory) return;
    for (const execution of toolExecutions) {
      if (execution.run_id !== snapshot?.activeRun?.id) continue;
      const intent = execution.intent as { call?: { name?: string; arguments?: unknown } } | null;
      if (!intent?.call?.name || execution.outcome !== 'succeeded') continue;
      recordHintsFromToolCall({ runtimeKey, threadKey: sessionId, toolCallId: execution.id, toolName: intent.call.name, args: intent.call.arguments, workspaceId, workspaceRoot: directory });
    }
  }, [directory, runtimeKey, sessionId, snapshot?.activeRun?.id, snapshot?.launch?.selection.source, toolExecutions, workspaceId]);

  React.useEffect(() => {
    const notify = (status: 'missing-editor' | 'missing-selection' | 'missing-document' | 'wrong-runtime' | 'no-session') => {
      toast.error(t(ATTACH_ERROR_KEYS[status]));
    };
    const attach = (kind: 'editor' | 'selection') => {
      if (!sessionId || !workspaceId || !directory) {
        notify('no-session');
        return;
      }
      const result = attachActiveEditorContext({
        threadKey: sessionId,
        workspaceId,
        workspaceRoot: directory,
        kind,
      });
      if ('status' in result) notify(result.status);
    };
    const dispose = [
      registerWorkbenchCommand('varin.editor.attachActiveFile', OWNER, () => attach('editor')),
      registerWorkbenchCommand('varin.editor.attachSelection', OWNER, () => attach('selection')),
      registerWorkbenchCommand('varin.editor.attachProblem', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const problems = getWorkbenchProblems(workspaceId);
        const item = problems.status === 'ready' ? problems.items[0] : undefined;
        if (!item) {
          notify('missing-document');
          return;
        }
        const result = attachEditorContext({
          threadKey: sessionId,
          workspaceId,
          resourceId: item.resourceId,
          kind: 'diagnostic',
          diagnosticMessage: item.message,
          ...(typeof item.line === 'number'
            ? {
              range: {
                startLine: item.line,
                startColumn: item.column ?? 1,
                endLine: item.line,
                endColumn: item.column ?? 1,
              },
            }
            : {}),
        });
        if ('status' in result) notify(result.status);
      }),
      registerWorkbenchCommand('varin.editor.revealInSession', OWNER, () => {
        const currentTab = tabRef.current;
        if (!workspaceId || !currentTab) return;
        const link = peekEditorSessionLink({ workspaceId, resourceId: currentTab.resourceId });
        if (!link?.entryId) return;
        void openThreadFromNavigation(link.thread);
      }),
      registerWorkbenchCommand('varin.editor.showChanges', OWNER, () => {
        if (workspaceId) showWorkbenchPanel(workspaceId, 'changes');
      }),
      registerWorkbenchMenuItem({
        id: 'varin.editor.attachActiveFile',
        commandId: 'varin.editor.attachActiveFile',
        group: 'editor/title',
        order: 20,
        when: { editorIsOpen: true },
      }),
    ];
    return () => {
      for (const close of dispose) close();
    };
  }, [directory, sessionId, t, workspaceId]);

  return null;
};
