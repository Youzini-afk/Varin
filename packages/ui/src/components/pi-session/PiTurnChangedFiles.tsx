import React from 'react';
import type { PiAssistantMessage, PiToolResultMessage } from '@varin/protocol';
import { useUIStore } from '@/stores/useUIStore';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';
import { useI18n } from '@/lib/i18n';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { Icon } from '@/components/icon/Icon';
import { fileChangePhase, fileChangeTargets } from './fileChangePreview';

export const PiTurnChangedFiles: React.FC<{
  messages: PiAssistantMessage[]; results: ReadonlyMap<string, PiToolResultMessage>;
  executions: Record<string, PiToolExecutionState>; cwd: string; sessionId: string;
}> = ({ messages, results, executions, cwd, sessionId }) => {
  const enabled = useUIStore(state => state.showTurnChangedFiles);
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const files = React.useMemo(() => {
    const changed = new Map<string, { path: string; callId: string; deleted: boolean }>();
    if (!enabled) return [];
    for (const message of messages) for (const call of message.content) {
      if (call.type !== 'toolCall' || message.stopReason === 'pending') continue;
      for (const file of fileChangeTargets(call)) {
        if (fileChangePhase(executions[call.id], results.get(call.id), false, file.path) !== 'applied') continue;
        changed.set(file.path, { path: file.path, callId: call.id, deleted: file.operation === 'delete' });
      }
    }
    return [...changed.values()];
  }, [enabled, messages, results, executions]);
  if (!files.length) return null;
  return <details className="group/files min-w-0 rounded-lg border border-border/50 px-3 py-2 typography-meta">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
      <Icon name="file-code" className="size-3.5" />{t('chat.changedFiles.title')}
      <span className="tabular-nums">{files.length}</span><Icon name="arrow-right-s" className="ml-auto size-3.5 group-open/files:rotate-90" />
    </summary>
    <div className="mt-2 flex flex-col items-start gap-1">
      {files.map(file => <button key={file.path} type="button" disabled={!workspaceId || file.deleted}
        className="max-w-full truncate rounded px-1 py-1 text-left enabled:hover:bg-interactive-hover disabled:opacity-60"
        title={file.path} data-varin-file-path={file.path} onClick={() => {
          if (workspaceId) void revealResourceInEditor({ workspaceId, workspaceRoot: cwd, sessionId,
            resourceId: resourceIdFromWorkspacePath(cwd, file.path) ?? file.path.replace(/\\/g, '/'), toolCallId: file.callId });
        }}>{file.path}</button>)}
    </div>
  </details>;
};
