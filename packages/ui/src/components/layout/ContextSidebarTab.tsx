import React from 'react';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ThreadContent } from '@/components/thread/ThreadContent';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { copyTextToClipboard } from '@/lib/clipboard';

/** Inspect native history and context facts without projecting another runtime's counters. */
export const ContextPanelContent: React.FC = () => {
  const { identity, snapshot, error } = useSelectedThreadSnapshot();
  const api = useRuntimeAPIs().threads;
  if (!identity) return <p className="p-4 text-sm text-muted-foreground">Open a conversation to inspect its context.</p>;
  if (!snapshot || !api) return <p role={error ? 'alert' : 'status'} className="p-4 text-sm">{error || 'Loading context…'}</p>;
  return <div className="space-y-4 overflow-y-auto p-4 text-sm">
    {error && <p role="alert">{error}</p>}
    <h3 className="font-medium">{snapshot.thread.title || 'Conversation'}</h3>
    <dl className="space-y-1"><dt>Thread</dt><dd className="break-all text-muted-foreground">{identity.threadId}</dd><dt>Branch</dt><dd className="break-all text-muted-foreground">{identity.branchId}</dd>
      <dt>Run</dt><dd>{snapshot.activeRun?.state ?? 'Idle'}</dd></dl>
    <details><summary>Current context</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(snapshot.context, null, 2)}</pre></details>
    <section className="space-y-3"><h4 className="font-medium">Retained history</h4>
      {snapshot.history.map(item => <details key={item.id}><summary>{item.source} · {item.id}</summary>
        <button type="button" onClick={() => void copyTextToClipboard(JSON.stringify(item.content, null, 2))}>Copy record</button>
        <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: item.id }} parts={historyParts(item.content, item.source)} messageId={item.id} />
      </details>)}
      {snapshot.historyPage.previous && <p className="text-muted-foreground">Earlier history is available in the conversation.</p>}
    </section>
  </div>;
};
