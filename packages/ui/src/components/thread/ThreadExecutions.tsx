import React from 'react';
import type { ChildTextPage, DelegatedExecution } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

const triggerLabels = {
  dispatch: 'Initial delegated execution',
  user_continuation: 'User continuation',
  computer_event: 'Computer event continuation',
  message_request: 'Request continuation',
  followup: 'Follow-up continuation',
  calendar: 'Calendar continuation',
} satisfies Record<DelegatedExecution['trigger']['kind'], string>;

/** Each report and file publication remains attached to its actual execution. */
export function ThreadExecutions({ api, identity, executions }: { api: ThreadsAPI; identity: ThreadIdentity; executions: DelegatedExecution[] }) {
  return <div aria-label="Delegated executions" className="space-y-2">
    {executions.map(execution => <details key={execution.execution_id} className="rounded border p-2 text-sm">
      <summary>{triggerLabels[execution.trigger.kind]} · {execution.state}</summary>
      <div className="break-all text-xs text-muted-foreground">Execution: {execution.execution_id}</div>
      <div className="break-all text-xs text-muted-foreground">Run: {execution.receipt?.run_id ?? 'Not admitted yet'}</div>
      {execution.trigger.kind !== 'dispatch' && <div className="break-all text-xs text-muted-foreground">Previous Run: {execution.trigger.previous_run_id}</div>}
      {execution.trigger.kind === 'computer_event' && <div className="break-all text-xs text-muted-foreground">Computer event: {execution.trigger.event_id} · input {execution.trigger.input_id}</div>}
      {execution.trigger.kind === 'calendar' && <div className="break-all text-xs text-muted-foreground">Calendar: {execution.trigger.definition_id} · occurrence {execution.trigger.occurrence_id}</div>}
      {execution.trigger.kind === 'followup' && <div className="break-all text-xs text-muted-foreground">Follow-up: {execution.trigger.followup_id} · occurrence {execution.trigger.occurrence_id}</div>}
      {execution.trigger.kind === 'message_request' && <div className="break-all text-xs text-muted-foreground">Request message: {execution.trigger.message_id}</div>}
      {execution.source?.kind === 'absent' && <div className="text-xs text-muted-foreground">No file source</div>}
      <div className="text-xs text-muted-foreground">{execution.code_result.kind === 'published'
        ? `Fixed file result: ${execution.code_result.result.publication_id} · revision ${execution.code_result.result.result_revision} · effect ${execution.code_result.effect}`
        : execution.code_result.kind === 'unavailable' ? `File result unavailable: ${execution.code_result.code} · effect ${execution.code_result.effect}`
          : execution.code_result.kind === 'not_applicable' ? 'File result not applicable'
          : execution.code_result.kind === 'no_changes' ? 'No file changes'
            : `File result: ${execution.code_result.kind}`}</div>
      {execution.report && <p>Report: {execution.report.outcome}{execution.report.detail ? ` · ${execution.report.detail}` : ''}</p>}
      {execution.report?.history_ids.map(itemId => <ExecutionReport key={itemId} api={api} identity={identity} executionId={execution.execution_id} itemId={itemId} />)}
    </details>)}
  </div>;
}

export function ChildExecutions({ api, identity, operationId }: { api: ThreadsAPI; identity: ThreadIdentity; operationId: string }) {
  const [executions, setExecutions] = React.useState<DelegatedExecution[] | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), []);
  const read = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api.collaboration!.executions(identity, operationId, controller.signal);
      if (!controller.signal.aborted) setExecutions(result.filter(execution => execution.trigger.kind !== 'dispatch'));
    } catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : 'Execution list unavailable'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  if (!api.collaboration) return null;
  return <div className="space-y-2">
    <Button variant="ghost" size="sm" disabled={loading} onClick={() => void read()}>{executions ? 'Refresh subsequent executions' : 'View subsequent executions'}</Button>
    {error && <p role="alert">{error}</p>}
    {executions?.length === 0 && <p className="text-xs text-muted-foreground">No subsequent executions</p>}
    {executions && <ThreadExecutions api={api} identity={identity} executions={executions} />}
  </div>;
}

function ExecutionReport({ api, identity, executionId, itemId }: { api: ThreadsAPI; identity: ThreadIdentity; executionId: string; itemId: string }) {
  const [page, setPage] = React.useState<ChildTextPage | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), []);
  const read = async (offset: number) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api.collaboration!.readExecutionReport(identity, executionId, itemId, offset, undefined, controller.signal);
      if (result.execution_id !== executionId || result.item_id !== itemId) throw new Error('Report identity changed');
      if (!controller.signal.aborted) setPage(result);
    } catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : 'Report unavailable'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <div>
    {error && <p role="alert">{error}</p>}
    {page && <><MarkdownRenderer messageId={`${executionId}:${itemId}:${page.offset}`} content={page.text} /><p className="text-xs">Bytes {page.offset}–{page.offset + new TextEncoder().encode(page.text).length} of {page.total_bytes}</p></>}
    {(!page || page.next_offset !== null) && <Button variant="ghost" size="sm" disabled={loading || !api.collaboration} onClick={() => void read(page?.next_offset ?? 0)}>{page ? 'Read next report page' : 'Read execution report'}</Button>}
  </div>;
}
