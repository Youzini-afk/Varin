import React from 'react';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import {
  peekLastStackFrame,
  peekLastTestFailure,
  peekRunDebugEditorProjection,
  subscribeRunDebugEditorProjection,
  toggleRunDebugBreakpoint,
} from '@/lib/run-debug/session';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, subscribeEditorWorkbench } from '@/lib/workbench/editors/session';
import { textEditorSummaryFromViewState } from '@/lib/workbench/editors/view-state-core';
import { useThreadStore, threadIdentityKey } from '@/stores/useThreadStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';

const OWNER = 'varin.builtin.workbench';

const ATTACH_ERROR_KEYS = {
  'missing-test': 'workbench.attachment.missing-test',
  'missing-stack': 'workbench.attachment.missing-stack',
  'no-session': 'workbench.attachment.no-session',
  'missing-document': 'workbench.attachment.missing-document',
  'wrong-runtime': 'workbench.attachment.wrong-runtime',
} as const satisfies Record<string, I18nKey>;

export const RunDebugCoordinator: React.FC = () => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const workspaceId = useWorkbenchWorkspaceId();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = useThreadStore(state => state.selectedIdentity ? threadIdentityKey(state.hostKey, state.selectedIdentity) : null);
  const workbench = React.useSyncExternalStore(
    subscribeEditorWorkbench,
    () => (workspaceId ? peekEditorWorkbench(workspaceId) : undefined),
    () => undefined,
  );
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const activeViewId = tab?.viewId;
  const [, refreshDebugProjection] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => (
    workspaceId && activeViewId
      ? subscribeRunDebugEditorProjection(workspaceId, refreshDebugProjection)
      : () => undefined
  ), [activeViewId, workspaceId]);
  const debugProjection = workspaceId && activeViewId ? peekRunDebugEditorProjection(workspaceId) : undefined;
  const revealedFrameRef = React.useRef('');

  React.useEffect(() => {
    const frame = debugProjection?.currentDebugFrame;
    const owner = debugProjection?.debugOwner;
    if (!workspaceId || !directory || !frame?.resourceId || !owner) return;
    const key = `${workspaceId}\0${owner.sessionId}\0${owner.generation}\0${frame.id}`;
    if (revealedFrameRef.current === key) return;
    revealedFrameRef.current = key;
    revealResourceInEditor({
      workspaceId,
      workspaceRoot: directory,
      resourceId: frame.resourceId,
      line: frame.line,
      column: frame.column,
    });
  }, [debugProjection?.currentDebugFrame, debugProjection?.debugOwner, directory, workspaceId]);

  React.useEffect(() => {
    revealedFrameRef.current = '';
  }, [workspaceId]);

  React.useEffect(() => {
    const notify = (status: keyof typeof ATTACH_ERROR_KEYS) => {
      toast.error(t(ATTACH_ERROR_KEYS[status]));
    };
    const dispose = [
      registerWorkbenchCommand('workbench.action.debug.start', OWNER, () => {
        if (!workspaceId) return;
        const currentTab = tabRef.current;
        void apis.debug.start({
          workspaceId,
          ...(currentTab?.resourceId
            ? {
              program: currentTab.resourceId,
              languageId: languageIdFromResourceId(currentTab.resourceId),
            }
            : {}),
        });
      }),
      registerWorkbenchCommand('workbench.action.debug.stop', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stop({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.continue', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.continue({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.pause', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.pause({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepOver', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepOver({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepInto', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepIn({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepOut', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepOut({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.test.run', OWNER, () => {
        if (!workspaceId) return;
        void apis.tests.run({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.test.discover', OWNER, () => {
        if (!workspaceId) return;
        void apis.tests.discover({ workspaceId });
      }),
      registerWorkbenchCommand('editor.debug.toggleBreakpoint', OWNER, () => {
        const fallbackTab = tabRef.current;
        if (!workspaceId || !fallbackTab) return;
        const currentWorkbench = peekEditorWorkbench(workspaceId);
        const currentTab = (currentWorkbench ? activeEditorTab(currentWorkbench) : undefined) ?? fallbackTab;
        const line = textEditorSummaryFromViewState(currentTab.viewState)?.cursor.line ?? 1;
        void toggleRunDebugBreakpoint({ workspaceId, resourceId: currentTab.resourceId }, line).catch((error) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }),
      registerWorkbenchCommand('varin.editor.attachTestFailure', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const failure = peekLastTestFailure(workspaceId);
        if (!failure) {
          notify('missing-test');
          return;
        }
        const result = attachEditorContext({
          threadKey: sessionId,
          workspaceId,
          resourceId: failure.resourceId ?? failure.id,
          kind: 'test-failure',
          diagnosticMessage: failure.message ?? failure.label,
          ...(typeof failure.line === 'number'
            ? {
              range: {
                startLine: failure.line,
                startColumn: 1,
                endLine: failure.line,
                endColumn: 1,
              },
            }
            : {}),
          ...(failure.stack ? { text: failure.stack } : {}),
          label: failure.label,
        });
        if ('status' in result && (result.status === 'wrong-runtime' || result.status === 'missing-document')) {
          notify(result.status);
        }
      }),
      registerWorkbenchCommand('varin.editor.attachStackFrame', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const frame = peekLastStackFrame(workspaceId);
        if (!frame) {
          notify('missing-stack');
          return;
        }
        const result = attachEditorContext({
          threadKey: sessionId,
          workspaceId,
          resourceId: frame.resourceId ?? tabRef.current?.resourceId ?? 'stack',
          kind: 'stack',
          diagnosticMessage: `${frame.name}:${frame.line}`,
          range: {
            startLine: frame.line,
            startColumn: frame.column,
            endLine: frame.line,
            endColumn: frame.column,
          },
          label: frame.name,
        });
        if ('status' in result && (result.status === 'wrong-runtime' || result.status === 'missing-document')) {
          notify(result.status);
        }
      }),
    ];
    return () => {
      for (const close of dispose) close();
    };
  }, [apis.debug, apis.tests, sessionId, t, workspaceId]);

  return null;
};
