import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { ThreadOutput } from '../thread/ThreadMedia';
import { canCancelOperation } from '../thread/threadOperations';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { SourceLink } from './ChatSourceTools';
import { useOptionalConversationPresentation } from './ConversationContext';
import { useToolOperation } from './useToolOperation';
import { invocationOperationId, toolRecord, toolText } from './toolInvocation';
import { toolValueLabel } from './toolLabels';
import type { ToolViewProps } from './toolViewTypes';
import { ToolHeadingText } from './ToolHeadingText';
import { toolSubject } from './toolSubject';

const operations: Record<string, I18nKey> = {
  mcp_discover: 'chat.tools.discoverService', mcp_list_resources: 'chat.tools.serviceResources', mcp_read_resource: 'chat.tools.readResource',
  mcp_list_prompts: 'chat.tools.servicePrompts', mcp_get_prompt: 'chat.tools.promptTemplate', mcp_subscribe_resource: 'chat.tools.observeResource',
  mcp_unsubscribe_resource: 'chat.tools.stopResourceObservation', mcp_task_get: 'chat.tools.remoteTask', mcp_task_wait: 'chat.tools.remoteTask',
  mcp_task_cancel: 'chat.tools.requestRemoteCancel', mcp_start_task: 'chat.tools.remoteTask',
};
const list = (value: unknown) => Array.isArray(value) ? value.map(toolRecord) : [];

function McpObjects({ value, id }: { value: unknown; id: string }) {
  const data = toolRecord(value);
  const title = toolText(data.title) || toolText(data.name), url = toolText(data.html_url) || toolText(data.url);
  if (title && (url || typeof data.body === 'string' || typeof data.description === 'string')) return <article className="tool-mcp-object">
    <SourceLink url={url}>{title}</SourceLink>
    {typeof data.state === 'string' && <p className="typography-micro text-muted-foreground">{data.state}{typeof data.number === 'number' ? ' · #' + data.number : ''}</p>}
    {typeof data.description === 'string' && <p className="tool-source-snippet">{data.description}</p>}
    {typeof data.body === 'string' && <MarkdownRenderer content={data.body} messageId={id} variant="tool" enableFileReferences={false} />}
  </article>;
  return <JsonSummaryView data={value} />;
}

export function ChatMcpTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const source = call.name.startsWith('mcp__') ? call.name.slice(5).split('__') : [];
  const server = toolText(args.server) || source[0] || 'MCP';
  const name = toolText(args.tool) || source.slice(1).join('__') || (operations[call.name] ? t(operations[call.name]!) : call.name);
  const operationId = toolText(data.operationId) || toolText(args.operationId) || invocationOperationId(call, execution);
  const control = useToolOperation(operationId, execution?.operation);
  const operation = control.operation, job = operation?.host_job?.mcpTask, task = job?.task ?? toolRecord(data.task);
  const subscription = operation?.mcp_resource_subscription;
  const hasTask = Boolean(task.status), stopped = operation?.external_receipt?.executor_stopped === true || data.executorStopped === true;
  const cancelling = control.cancelRequested || data.cancelRequested === true;
  const resources = list(data.resources ?? data.resourceTemplates), prompts = list(data.prompts), tools = list(data.tools), contents = list(data.contents);
  const retained = operation?.host_job?.mcpTaskResult;
  const showControl = Boolean(subscription || hasTask || call.name === 'mcp_start_task' || call.name === 'mcp_subscribe_resource');
  return <section className="tool-mcp-result">
    <div className="tool-service-byline"><Icon name="plug" className="size-3.5 shrink-0" /><ToolHeadingText label={server + ' · ' + name} subject={toolSubject(call, data, t)} />{status !== 'success' && <ToolStatus status={status} generating={generating} />}</div>
    {call.name === 'mcp_discover' && data.servers !== undefined && <ToolDisclosure id={'mcp-servers:' + call.id} className="tool-document-text" initiallyExpanded><summary className="typography-meta">{t('chat.tools.discoverService')}</summary><JsonSummaryView data={data.servers} /></ToolDisclosure>}
    {call.name === 'mcp_discover' && Array.isArray(data.services) && data.services.length > 0 && <ToolDisclosure id={'mcp-services:' + call.id} className="tool-document-text"><summary className="typography-meta">{t('chat.tools.serviceResources')}</summary><JsonSummaryView data={data.services} /></ToolDisclosure>}
    {hasTask && <div className="tool-remote-task"><div className="flex flex-wrap items-center gap-2 typography-meta"><Icon name={stopped || ['completed','failed','cancelled'].includes(String(task.status)) ? task.status === 'completed' ? 'check' : 'stop' : cancelling ? 'time' : 'loader-4'} className={task.status === 'working' && !cancelling ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'} />
      <span role="status">{cancelling && !stopped && task.status !== 'cancelled' ? t('chat.tools.cancelAwaitingStop') : toolValueLabel(task.status, t)}</span></div>
      {job?.availability === 'unavailable' && <p className="typography-micro text-[var(--status-warning)]">{t('chat.tools.observationUnavailable')}</p>}
      {job?.problem && <p className="typography-micro text-muted-foreground">{job.problem.kind} · {job.problem.stage}</p>}
      {job?.resultReady && <p className="typography-micro text-muted-foreground">{t('chat.tools.retainedResult')}</p>}
    </div>}
    {subscription && <div className="tool-resource-observation"><Icon name="file-text" className="size-4" /><div><p>{subscription.binding.uri}</p><p className="typography-micro text-muted-foreground">{toolValueLabel(subscription.availability, t)}{subscription.lastEventCursor != null ? ' · ' + t('chat.tools.updateNotice') : ''}</p><p className="typography-micro text-muted-foreground">{t('chat.tools.notificationNotRead')}</p></div></div>}
    {[...resources, ...prompts, ...tools].map((entry, index) => <ToolDisclosure key={index} id={'mcp-entry:' + call.id + ':' + index} className="tool-mcp-entry"><summary><Icon name={entry.uri || entry.uriTemplate ? 'file-text' : entry.inputSchema ? 'tools' : 'chat-quote'} className="size-3.5" /><span>{toolText(entry.title) || toolText(entry.name) || toolText(entry.tool) || toolText(entry.uri)}</span><Icon name="arrow-right-s" className="tool-disclosure-chevron size-3" /></summary><div>
      {typeof entry.description === 'string' && <p className="typography-meta whitespace-pre-wrap">{entry.description}</p>}
      {Boolean(entry.uri || entry.uriTemplate) && <code className="tool-identity">{toolText(entry.uri) || toolText(entry.uriTemplate)}</code>}
      {entry.inputSchema !== undefined && <JsonSummaryView data={entry.inputSchema} />}{Array.isArray(entry.arguments) && <JsonSummaryView data={entry.arguments} />}
    </div></ToolDisclosure>)}
    {contents.map((content, i) => <div key={i} className="tool-resource-observation"><Icon name="file-text" className="size-3.5" /><code>{toolText(content.uri)}</code><span className="typography-micro text-muted-foreground">{toolText(content.mimeType)}</span></div>)}
    {call.name === 'mcp_get_prompt' && typeof data.description === 'string' && <p className="typography-meta">{data.description}</p>}
    {data.structuredContent !== undefined && <McpObjects value={data.structuredContent} id={call.id + ':object'} />}
    {data.isError === true && <p role="alert" className="typography-meta text-destructive">{t('chat.tools.remoteFailure')}</p>}
    {retained && conversation && <ThreadOutput api={conversation.api} identity={conversation.identity} holder={{ kind: 'operation', operationId: operation!.id, output: 'mcp_task_result' }} output={retained} messageId={call.id + ':retained'} />}
    {output}
    {showControl && control.available && <div className="tool-inline-actions"><button type="button" disabled={control.busy} onClick={() => void control.refresh()}>{t('chat.tools.refresh')}</button>
      {operation && !control.readOnly && canCancelOperation(operation) && <button type="button" disabled={control.busy || cancelling} onClick={() => void control.cancel()}>{t(subscription ? 'chat.tools.stopResourceObservation' : 'chat.tools.requestRemoteCancel')}</button>}</div>}
    {control.error && <p role="alert" className="typography-meta text-destructive">{control.error}</p>}
    <ToolResultNotice data={data} status={status} />{details}
  </section>;
}
