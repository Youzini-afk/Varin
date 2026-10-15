import React from 'react';
import type { ChildTask, DelegatedExecution } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI, ThreadSnapshot } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadChildReport } from '../thread/ThreadChildReport';
import { ThreadExecutions } from '../thread/ThreadExecutions';
import { ThreadIntegrationPanel } from '../thread/ThreadIntegrationPanel';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useI18n } from '@/lib/i18n';
import { ChildState, ChildFileResult } from './childPresentation';

const childEnded = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);

/** A row follows the newest execution; each report still uses its own immutable owner. */
export function ChildTasks({ api, identity, children, executions, activity, pending, cancel }: {
  api: ThreadsAPI; identity: ThreadIdentity; children: ChildTask[]; executions: DelegatedExecution[];
  pending: boolean; cancel?: (operationId: string) => Promise<unknown>;
  activity?: ThreadSnapshot['childActivity'];
}) {
  const { t } = useI18n();
  const rows = React.useMemo(() => children.map(child => {
    // Catalog returns admission order. A late receipt can advance an older execution's cursor.
    const history = executions.filter(execution => execution.child_operation_id === child.operation_id);
    const latest = history.at(-1);
    return { child, latest, history, state: latest && activity?.[latest.execution_id]?.state || latest?.state || child.state };
  }), [children, executions, activity]);
  const active = rows.filter(row => !childEnded(row.state));
  const ended = rows.filter(row => childEnded(row.state));
  const [error, setError] = React.useState<string>();
  const open = async (child: ChildTask) => {
    try { setError(undefined); await openThreadFromNavigation({ threadId: child.child_thread_id, branchId: child.child_branch_id }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const renderRow = ({ child, latest, history, state }: typeof rows[number]) => {
    const report = latest?.report ?? (latest ? null : child.report);
    const result = latest?.code_result ?? child.code_result;
    return <details key={child.operation_id} className="group/child rounded-lg">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2 hover:bg-interactive-hover [&::-webkit-details-marker]:hidden">
        <Icon name="chat-3" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate typography-meta font-medium" title={child.input.task}>{child.input.task}</span>
        <ChildState state={latest?.cancel_requested && !childEnded(state) ? 'stopping' : state} />
      </summary>
      <div className="space-y-3 border-l border-border/50 py-2 pl-3 ml-3">
        <p className="whitespace-pre-wrap break-words typography-meta">{child.input.task}</p>
        <ChildFileResult result={result} />
        {latest && <ThreadIntegrationPanel api={api} identity={identity} execution={latest} />}
        {report?.detail && <MarkdownRenderer messageId={`child:${latest?.execution_id ?? child.operation_id}`} content={report.detail} />}
        {report?.history_ids.map(itemId => <ThreadChildReport key={itemId} api={api} identity={identity}
          operationId={child.operation_id} executionId={latest?.execution_id} itemId={itemId} />)}
        {history.length > 1 && <details><summary className="cursor-pointer typography-meta text-muted-foreground">{t('chat.children.previousExecutions')}</summary>
          <ThreadExecutions api={api} identity={identity} executions={history.slice(0, -1)} />
        </details>}
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={() => void open(child)}>{t('harness.threads.openConversation')}</Button>
          {cancel && !childEnded(state) && <Button variant="ghost" size="sm" disabled={pending || latest?.cancel_requested}
            onClick={() => void cancel(child.operation_id)}>{t('harness.threads.stop')}</Button>}
        </div>
      </div>
    </details>;
  };
  return <div className="space-y-1" aria-label={t('harness.threads.title')}>
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    {active.map(renderRow)}
    {!!ended.length && <details className="group/ended"><summary className="flex cursor-pointer list-none items-center gap-1 py-1 typography-meta text-muted-foreground [&::-webkit-details-marker]:hidden">
      <Icon name="arrow-right-s" className="size-3.5 group-open/ended:rotate-90" />{t('harness.threads.ended', { count: ended.length })}
    </summary>{ended.map(renderRow)}</details>}
  </div>;
}
