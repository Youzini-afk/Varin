import React from 'react';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useUIStore } from '@/stores/useUIStore';
import type { useI18n } from '@/lib/i18n';
import type { ConversationPresentation } from './ConversationContext';
import type { ChatToolCall } from './types';
import { toolRecord, toolText } from './toolInvocation';
import { toolValueLabel } from './toolLabels';
import { ChildState } from './childPresentation';
import { ThreadChildReport } from '../thread/ThreadChildReport';
import { ToolDisclosure } from './ToolDisclosure';
import { getToolSummary } from '@/components/chat/message/parts/toolSummary';

const records = (value: unknown) => Array.isArray(value) ? value.map(toolRecord) : [];
const valueText = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);

/** Read the owner's recorded objects. Requested mutations never stand in for committed results. */
export function workToolContent(call: ChatToolCall, data: Record<string, unknown>, t: ReturnType<typeof useI18n>['t'],
  cwd: string, conversation: ConversationPresentation | null): React.ReactNode {
  const args = toolRecord(call.arguments);
  if (call.name === 'retrieval_control' && typeof data.state === 'string') {
    const message = toolRecord(data.latestAssistantMessage), action = toolRecord(data.latestAction);
    const summary = typeof action.tool === 'string' ? getToolSummary({ toolName: action.tool, arguments: action.arguments }).text : '';
    return <div className="min-w-0 space-y-2">
      <p className="typography-micro text-muted-foreground">{toolValueLabel(data.state, t)}
        {typeof data.elapsedMs === 'number' && <> · {t('chat.explore.seconds', { count: (data.elapsedMs / 1000).toFixed(1) })}</>}</p>
      {typeof message.text === 'string' && message.text && <div className="max-h-64 overflow-auto overscroll-contain break-words">
        <MarkdownRenderer content={message.text} messageId={call.id + ':latest-message'} enableFileReferences={false} />
      </div>}
      {typeof action.tool === 'string' && <p className="break-words typography-meta text-muted-foreground">
        {action.tool}{summary && summary !== action.tool ? ' · ' + summary : ''} · {toolValueLabel(action.outcome ?? action.state, t)}
      </p>}
    </div>;
  }
  if (call.name === 'child_status') {
    const executions = Array.isArray(data.executions) ? records(data.executions) : data.execution_id ? [data] : [];
    return executions.length ? <div className="tool-execution-history">{executions.map((entry, index) => {
      const report = toolRecord(entry.report), failure = toolRecord(entry.preparationFailure);
      return <div key={toolText(entry.execution_id) || index}>
        <div className="flex flex-wrap items-center gap-2"><ChildState state={toolText(entry.state)} /><span className="truncate typography-micro text-muted-foreground" title={toolText(entry.execution_id)}>{toolText(entry.execution_id)}</span></div>
        {typeof failure.message === 'string' && <p className="typography-meta text-destructive">{failure.message}</p>}
        {typeof report.detail === 'string' && <p className="whitespace-pre-wrap typography-meta">{report.detail}</p>}
      </div>;
    })}</div> : null;
  }
  if (call.name === 'child_report') {
    const page = toolRecord(data.page);
    if (page.format === 'text' && typeof page.text === 'string') return <div>
      <MarkdownRenderer messageId={call.id + ':report'} content={page.text} enableFileReferences={false} />
      {page.next_offset != null && <p className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}
    </div>;
    if (page.format === 'output_body' && conversation?.api.collaboration && typeof page.operation_id === 'string'
      && typeof page.execution_id === 'string' && typeof page.item_id === 'string')
      return <ThreadChildReport api={conversation.api} identity={conversation.identity} operationId={page.operation_id} executionId={page.execution_id} itemId={page.item_id} />;
  }
  if (call.name === 'submit_code' || call.name === 'update') {
    const applied = Array.isArray(data.appliedPaths) ? data.appliedPaths.filter(path => typeof path === 'string') : [];
    const conflicts = Array.isArray(data.conflictPaths) ? data.conflictPaths.filter(path => typeof path === 'string') : [];
    if (!applied.length && !conflicts.length && typeof data.text !== 'string') return null;
    const source = toolRecord(data.source), target = toolRecord(data.target);
    return <div className="tool-file-handoff">
      {Boolean(source.name || target.name) && <p className="typography-micro text-muted-foreground">{toolText(source.name) || toolText(source.agentId)} → {toolText(target.name) || toolText(target.agentId)}</p>}
      {typeof data.text === 'string' && <p className="whitespace-pre-wrap typography-meta">{data.text}</p>}
      {Array.from(new Set([...applied, ...conflicts])).map(path => <div key={path} className="tool-handoff-file">
        <FileTypeIcon filePath={path} className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 break-all">{path}</span>
        <span className={conflicts.includes(path) ? 'text-destructive' : 'text-muted-foreground'}>{t(conflicts.includes(path) ? 'chat.integration.conflict' : 'chat.tools.state.applied')}</span>
      </div>)}
    </div>;
  }
  if (call.name === 'memory') {
    const changes = records(toolRecord(data.memoryReceipt).changes);
    const notes = data.item ? [toolRecord(data.item)] : records(data.notes);
    if (!notes.length && !changes.length) return null;
    return <div className="tool-memory-notes">{(changes.length ? changes : notes).map((entry, index) => {
      const note = changes.length ? toolRecord(entry.note) : entry;
      const scope = toolRecord(entry.scope ?? note.scope), source = toolRecord(note.source);
      return <div key={String(entry.id ?? index)} className="tool-memory-note">
        <p className="typography-micro text-muted-foreground">{toolValueLabel(scope.kind, t)}{scope.id ? ' · ' + toolText(scope.id) : ''}
          {changes.length > 0 && <span> · {t(entry.note === null ? 'chat.tools.deleted' : 'chat.tools.saved')}</span>}</p>
        {typeof note.content === 'string' && <blockquote className="tool-memory-text">{note.content}</blockquote>}
        {typeof source.label === 'string' && <ToolDisclosure id={'memory-source:' + call.id + ':' + index} className="tool-document-text"><summary className="typography-micro text-muted-foreground">{t('chat.tools.memorySource')}</summary><p className="typography-meta">{source.label}</p></ToolDisclosure>}
        {data.sources !== undefined && <ToolDisclosure id={'memory-sources:' + call.id + ':' + index} className="tool-document-text"><summary className="typography-micro text-muted-foreground">{t('chat.tools.memorySource')}</summary><JsonSummaryView data={data.sources} /></ToolDisclosure>}
        {data.chain !== undefined && <ToolDisclosure id={'memory-chain:' + call.id + ':' + index} className="tool-document-text"><summary className="typography-micro text-muted-foreground">{t('chat.tools.memoryHistory')}</summary><JsonSummaryView data={data.chain} /></ToolDisclosure>}
      </div>;
    })}</div>;
  }
  if (call.name.startsWith('settings_')) {
    const items = records(data.items), fields = records(data.fields), effective = toolRecord(data.effective);
    if (call.name === 'settings_search' && Array.isArray(data.items)) return <dl className="tool-setting-fields">{items.map((item, index) =>
      <div key={toolText(item.id) || index}><dt className="font-mono">{toolText(item.id)}</dt><dd>{toolText(item.note) || toolText(item.category)}
        {item.summary !== undefined && <JsonSummaryView data={item.summary} />}</dd></div>)}</dl>;
    if (!fields.length && !items.length && !data.appliedAt && !data.operation && !Object.keys(effective).length) return null;
    const fieldList = (entries: Record<string, unknown>[], values: Record<string, unknown> = {}) => <dl className="tool-setting-fields">{entries.map((field, index) => {
      const path = toolText(field.path), returned = Object.hasOwn(values, path) ? values[path] : field.saved;
      return <div key={path || index}><dt className="font-mono">{path}</dt><dd>
        {returned !== undefined && <pre>{valueText(returned)}</pre>}
        {typeof field.status === 'string' && <span className={field.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{toolValueLabel(field.status, t)}</span>}
        {field.isSet === false && <span className="text-muted-foreground">{t('chat.tools.notSet')}</span>}
        {typeof field.error === 'string' && <p className="text-destructive">{field.error}</p>}
      </dd></div>;
    })}</dl>;
    const action = toolRecord(data.operation);
    return <div className="tool-settings-changes">
      {fields.length > 0 && fieldList(fields, effective)}
      {items.map((item, index) => <div key={toolText(item.id) || index}><p className="typography-meta">{toolText(item.id)} · {toolText(item.status)}</p>
        {fieldList(records(item.fields))}{typeof item.error === 'string' && <p className="text-destructive">{item.error}</p>}</div>)}
      {Object.hasOwn(effective, 'value') && <JsonSummaryView data={effective.value} />}
      {typeof data.appliedAt === 'string' && <p className="typography-micro text-muted-foreground">{t('chat.tools.takesEffect')} · {toolValueLabel(data.appliedAt, t)}</p>}
      {typeof action.state === 'string' && <p className="typography-meta">{action.state} · {toolText(action.detail)}</p>}
    </div>;
  }
  if (call.name === 'threads' && Array.isArray(data.members)) return <div className="tool-thread-directory">{records(data.members).map((member, index) => {
    const threadId = toolText(member.threadId), branches = records(member.branches);
    const branchId = toolText(branches[0]?.branchId);
    return <div key={threadId || index} className="tool-thread-directory-row"><AgentAvatar identity={threadId} size={23} />
      <div className="min-w-0 flex-1"><p className="typography-meta">{toolText(member.name) || toolText(member.agentId) || threadId}</p>
        <p className="typography-micro text-muted-foreground">{toolText(member.task)}</p></div>
      <span className="typography-micro text-muted-foreground">{toolText(member.state)}</span>
      {conversation && threadId && branchId && branches.length === 1 && <button type="button" className="tool-thread-open" title={t('chat.tools.viewConversation')}
        onClick={() => useUIStore.getState().openContextPanelTab(cwd, { mode: 'threads', thread: conversation.identity, member: { runtime: 'agent', threadId, branchId } })}><Icon name="external-link" className="size-3.5" /></button>}
    </div>;
  })}</div>;
  if (call.name === 'read_thread') {
    const page = toolRecord(data.page);
    if (!Array.isArray(page.items)) return null;
    return <div className="tool-thread-excerpts">{records(page.items).map((entry, index) => <div key={toolText(entry.id) || index}>
      <p className="typography-micro text-muted-foreground">{toolText(entry.source)} · {toolText(entry.kind)}</p>
      {entry.bodyTruncated === true ? <p className="whitespace-pre-wrap typography-meta">{toolText(entry.preview)}</p>
        : <JsonSummaryView data={entry.body} />}
      {entry.bodyTruncated === true && <p className="typography-micro text-muted-foreground">{t('chat.tools.partialResult')}</p>}
    </div>)}</div>;
  }
  if (call.name === 'goal_report' && data.state) return <div className="tool-goal-record"><p className="typography-meta">{toolText(data.state)}</p>
    {typeof args.reason === 'string' && <p className="whitespace-pre-wrap typography-meta">{args.reason}</p>}</div>;
  if (call.name === 'tool_describe') {
    const tools = records(data.tools), groups = records(data.groups);
    if (groups.length) return <dl className="tool-capability-list">{groups.map((group, index) => <div key={toolText(group.namespace) || index}>
      <dt className="typography-meta font-medium">{toolText(group.namespace)} <span className="typography-micro text-muted-foreground">{typeof group.tools === 'number' ? group.tools : ''}</span></dt>
      <dd className="typography-meta text-muted-foreground">{toolText(group.description)}</dd></div>)}</dl>;
    const capabilities = tools.length ? tools : typeof data.description === 'string' ? [data] : [];
    return capabilities.length ? <dl className="tool-capability-list">{capabilities.map((tool, index) => <div key={toolText(tool.name) || index}>
      <dt className="typography-meta font-medium">{toolText(tool.name)}</dt><dd className="typography-meta text-muted-foreground whitespace-pre-wrap">{toolText(tool.description)}</dd>
    </div>)}</dl> : null;
  }
  if (call.name === 'resource_read') {
    const file = toolRecord(data.file), content = toolText(file.content);
    if (content) return <div className="tool-resource-document"><p className="typography-micro text-muted-foreground">{toolText(file.reference)}</p>
      <div className="tool-result-scroll" data-conversation-tool-scroll="true"><MarkdownRenderer content={content} messageId={call.id + ':resource'} variant="tool" enableFileReferences={false} /></div></div>;
    const instructions = records(data.instructions);
    if (instructions.length) return <div className="tool-resource-document">{instructions.map((entry, index) => <div key={index}>
      <p className="typography-micro text-muted-foreground">{toolText(entry.path)}</p>
      <pre className="tool-hit-context">{toolText(entry.content)}</pre></div>)}</div>;
  }
  return null;
}
