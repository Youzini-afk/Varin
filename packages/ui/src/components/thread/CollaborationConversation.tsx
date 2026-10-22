import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import {
  ThreadProjection,
  type StreamingTextPart,
  type StreamingToolCall,
  type ToolExecutionProgress,
} from '@/lib/agent-runtime/thread-projection';
import { threadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import { ReferenceNavigationContext } from '../conversation/ReferenceNavigation';
import { useI18n } from '@/lib/i18n';
import { runFailureMessage } from '@/lib/agent-runtime/runFailure';
import { Button } from '@/components/ui/button';
import { ThreadQuestions } from './ThreadQuestions';
import { ThreadPermission } from './ThreadPermission';

/** The selected member uses the same history and progress renderer as the main conversation. */
export function CollaborationConversation({
  api,
  identity,
  host,
  onQuote,
}: {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  host: number;
  onQuote(text: string): void;
}) {
  const { t } = useI18n();
  const historyWindow = React.useMemo(() => threadHistoryWindow(api, String(host), identity), [api, host, identity]);
  const history = React.useSyncExternalStore(
    historyWindow.subscribe,
    historyWindow.getSnapshot,
    historyWindow.getSnapshot,
  );
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [progress, setProgress] = React.useState<StreamingTextPart[]>([]);
  const [tools, setTools] = React.useState<StreamingToolCall[]>([]);
  const [toolProgress, setToolProgress] = React.useState<ToolExecutionProgress[]>([]);
  const [error, setError] = React.useState<string>();
  const [retry, setRetry] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const alive = React.useRef(true);
  const actionInFlight = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      actionInFlight.current = false;
      if (alive.current) setPending(false);
    }
  };
  React.useEffect(() => {
    const projection = new ThreadProjection(
      api,
      identity,
      (value) => {
        historyWindow.accept(value);
        setSnapshot(value);
        setError(undefined);
      },
      (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
      setProgress,
      setTools,
      setToolProgress,
      { contextInspection: false },
    );
    projection.start();
    return () => projection.close();
  }, [api, identity, historyWindow, retry]);
  const branch = snapshot?.thread.branches.find((branch) => branch.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const source = snapshot?.launch?.selection.source;
  const reference = React.useMemo(() => ({ identity }), [identity]);
  return (
    <ReferenceNavigationContext.Provider value={reference}>
      <div className="collaboration-conversation flex min-h-0 flex-1 flex-col">
        {error && (
          <div role="alert" className="px-4 py-2 typography-meta text-destructive">
            {error}
            <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
              {t('chat.family.retry')}
            </Button>
          </div>
        )}
        {snapshot && (
          <ThreadQuestions
            operations={snapshot.operations}
            enabled={(operation) => !pending && run?.state === 'waiting' && run.waiting_on === operation.waiting_on}
            onCancel={(operation) => act(() => api.cancelOperation(operation.id))}
            onAnswer={(operation, answer) =>
              act(() => api.answerQuestion({ ...identity, operationId: operation.id, answer }))
            }
          />
        )}
        {!snapshot && !history.ready ? (
          <p role="status" className="p-4 typography-meta text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : (
          <ConversationTimeline
            api={api}
            identity={identity}
            viewId="collaboration"
            snapshot={history.connecting ? undefined : snapshot}
            history={history.items}
            historyReady={history.ready}
            historyReset={history.reset}
            runUsage={history.usage}
            earlierHistory={{
              available: Boolean(history.previous),
              loading: history.loading,
              error: history.error,
              latencyMs: history.latencyMs,
              load: historyWindow.loadEarlier,
            }}
            progress={progress}
            streamingTools={tools}
            toolProgress={toolProgress}
            cwd={source?.live_root?.canonicalRoot ?? ''}
            working={Boolean(branch?.active_run_id) && run?.state !== 'waiting'}
            readOnly
            onQuote={onQuote}
            footer={
              <>
                {snapshot?.runFailure && (
                  <p className="p-4 typography-meta text-destructive">{runFailureMessage(snapshot.runFailure, t)}</p>
                )}
                {snapshot?.operations.map((operation) => (
                  <ThreadPermission
                    key={operation.id}
                    operation={operation}
                    enabled={!pending && operation.run_id === run?.id && !run?.cancel_requested}
                    onDecide={(permissionId, decision) =>
                      act(() =>
                        api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision }),
                      )
                    }
                  />
                ))}
              </>
            }
          />
        )}
      </div>
    </ReferenceNavigationContext.Provider>
  );
}
