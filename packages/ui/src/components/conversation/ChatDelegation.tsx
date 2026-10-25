import React from 'react';
import type { DelegatedExecution } from '@varin/protocol';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ChildPreparation, ChildState, ChildFileResult } from './childPresentation';
import { ThreadChildReport } from '../thread/ThreadChildReport';
import { ThreadIntegrationPanel } from '../thread/ThreadIntegrationPanel';
import { canCancelOperation } from '../thread/threadOperations';
import { invocationOperationId, toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';

export function ChatDelegation({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments), receipt = toolRecord(result?.details ?? execution?.result);
  const operationId = invocationOperationId(call, execution);
  const original = execution?.child?.execution;
  const [expanded, setExpanded] = React.useState(false);
  const [loaded, setLoaded] = React.useState<{ id: string; execution?: DelegatedExecution }>();
  const [error, setError] = React.useState<string>();
  const [retry, setRetry] = React.useState(0);
  const [stopping, setStopping] = React.useState(false);
  const host = getRuntimeEndpointGeneration();
  const owner = [host, conversation?.identity.threadId, conversation?.identity.branchId, operationId].join(':');
  const exact = original ?? (loaded?.id === owner ? loaded.execution : undefined);
  const child = execution?.child?.task;
  const threadId = exact?.child_thread_id ?? child?.child_thread_id ?? toolText(receipt.threadId);
  const branchId = exact?.child_branch_id ?? child?.child_branch_id ?? toolText(receipt.branchId);
  const name = exact?.name || child?.name || toolText(receipt.name) || toolText(args.name) || t('chat.tools.delegatedTask');
  const task = toolText(args.task);
  const childState = execution?.child?.activity?.state ?? exact?.state;
  const report = exact?.report;
  const active = execution?.operation && canCancelOperation(execution.operation);
  // A member that joins while it starts arrives with settle; history is still.
  const [arrives] = React.useState(() => Boolean(generating) || status === 'running'
    || ['queued', 'preparing', 'starting', 'running'].includes(childState ?? ''));
  React.useEffect(() => {
    if (!expanded || !operationId || !conversation?.api.collaboration || original || result?.notDispatched
      || generating || result?.status !== 'background' && !execution?.child) return;
    const controller = new AbortController(); setError(undefined);
    void conversation.api.collaboration.executions(conversation.identity, operationId, controller.signal).then(rows => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration())
        setLoaded({ id: owner, execution: rows.find(row => row.execution_id === operationId) });
    }, failure => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [expanded, conversation?.api, conversation?.identity, operationId, original, owner, host, retry, result?.notDispatched, result?.status, generating, execution?.child]);
  const open = () => {
    if (!conversation || !threadId || !branchId) return;
    useUIStore.getState().openContextPanelTab(cwd, { mode: 'threads', thread: conversation.identity,
      member: { runtime: 'agent', threadId, branchId } });
  };
  const cancel = async () => {
    if (!conversation || !operationId || stopping) return;
    setStopping(true); setError(undefined);
    try { await conversation.api.cancelOperation(operationId); }
    catch (failure) { if (host === getRuntimeEndpointGeneration()) { setStopping(false); setError(String(failure)); } }
  };
  return <ToolDisclosure id={'tool:' + call.id} className="tool-delegation group" onExpanded={setExpanded}>
    <summary className="tool-member-line" data-arrive={arrives || undefined}>
      {threadId ? <AgentAvatar identity={threadId} avatar={child?.avatar ?? exact?.avatar ?? execution?.agent?.avatar} size={23} />
        : <Icon name="ai-agent" className="size-4 text-muted-foreground" />}
      <span className="typography-meta font-medium truncate">{name}</span>
      <span className="tool-member-purpose typography-micro text-muted-foreground" title={task}>{task}</span>
      {childState ? <ChildState state={(stopping || exact?.cancel_requested || execution?.operation?.cancel_requested) && active ? 'stopping' : childState} />
        : <ToolStatus status={status} generating={generating} stopped={stopping && Boolean(active)} />}
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
    </summary>
    <div className="tool-member-detail">
      <p className="whitespace-pre-wrap break-words typography-meta">{task}</p>
      {exact?.preparation && childState === 'preparing' && <ChildPreparation progress={exact.preparation} />}
      {execution?.child?.activity?.reason && <p role="status" className="typography-meta text-destructive">{execution.child.activity.reason}</p>}
      <div className="tool-inline-actions">
        {threadId && branchId && conversation && <button type="button" onClick={open}>{t('chat.tools.viewConversation')} <Icon name="external-link" className="size-3" /></button>}
        {active && !conversation?.readOnly && <button type="button" disabled={stopping || execution?.operation?.cancel_requested} onClick={() => void cancel()}>{t(stopping || execution?.operation?.cancel_requested ? 'chat.children.stopping' : 'chat.tools.stopTask')}</button>}
      </div>
      {error && <p role="alert" className="typography-meta text-destructive">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('chat.script.retry')}</button></p>}
      {report?.detail && <MarkdownRenderer content={report.detail} messageId={call.id + ':report'} />}
      {operationId && conversation && report?.history_ids.map(itemId => <ThreadChildReport key={itemId}
        api={conversation.api} identity={conversation.identity} operationId={operationId} executionId={exact?.execution_id} itemId={itemId} />)}
      {exact && (exact.code_result.kind !== 'pending' || childState === 'settling') && <ChildFileResult result={exact.code_result} />}
      {exact && conversation && <ThreadIntegrationPanel api={conversation.api} identity={conversation.identity} execution={exact} />}
      {(status === 'error' || status === 'unknown' || status === 'cancelled') && output}
      {details}
    </div>
  </ToolDisclosure>;
}
