import React from 'react';
import { parseTodoPlan } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';
import { workToolContent } from './workToolContent';
import { workToolLabels, toolValueLabel } from './toolLabels';
export function ChatWorkTool({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const plan = call.name === 'todo', memory = call.name === 'memory', settings = call.name.startsWith('settings_');
  const body = toolRecord(data.plan ?? toolRecord(data.mutation).plan);
  const planItems = typeof body.content === 'string' ? parseTodoPlan(body.content) : [];
  const label = t(plan && args.action === 'update' ? 'chat.tools.updatePlan' : memory && args.action === 'save' ? 'chat.tools.saveMemory'
    : memory && args.action === 'delete' ? 'chat.tools.deleteMemory' : workToolLabels[call.name] ?? 'chat.tools.resource');
  const subject = toolText(args.query) || toolText(args.name) || (settings ? toolText(args.id) : '')
    || toolText(args.operationId) || toolText(args.targetThreadId);
  const content = toolText(data.content) || toolText(toolRecord(data.note).content);
  const objectResult = result?.details !== undefined && Object.keys(data).length > 0;
  const purposeContent = workToolContent(call, data, t, cwd, conversation);
  return <ToolDisclosure id={'tool:' + call.id} className={'tool-work-record group ' + (plan ? 'tool-plan-record' : memory ? 'tool-memory-record' : '')}>
    <summary className="tool-work-heading"><Icon name={plan ? 'list-check-2' : memory ? 'brain' : settings ? 'settings-3'
      : call.name.includes('child') ? 'group' : call.name === 'ask_user' || call.name === 'question_status' ? 'question' : 'file-list-2'} className="size-3.5 shrink-0" />
      <span className="typography-meta">{label}</span>
      <span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground">{subject}</span>
      {planItems.length > 0 && <span className="typography-micro text-muted-foreground tabular-nums">{planItems.filter(item => item.status === 'completed').length} / {planItems.length}</span>}
      {typeof data.status === 'string' && !['ready', 'ok', 'available'].includes(data.status) && <span className="typography-micro text-muted-foreground">{toolValueLabel(data.status, t)}</span>}
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
    </summary>
    <div className="tool-work-content">
      {plan && planItems.length > 0 && <ol className="tool-plan-steps">{planItems.map((value, index) => {
        const item = toolRecord(value); return <li key={index}><Icon name={item.status === 'completed' ? 'check'
          : item.status === 'in_progress' ? 'loader-4' : item.status === 'blocked' ? 'error-warning' : 'checkbox-blank-circle-fill'} className="size-3.5 shrink-0" />
          <span>{toolText(item.text) || toolText(item.content)}</span><span className="typography-micro text-muted-foreground">{toolValueLabel(item.status, t)}</span></li>;
      })}</ol>}
      {purposeContent}
      {memory && !purposeContent && <>{Boolean(args.scope ?? data.scope) && <p className="typography-micro text-muted-foreground">{t('chat.tools.scope')} · {toolText(data.scope) || toolText(args.scope)}</p>}
        {content && <blockquote className="tool-memory-text">{content}</blockquote>}</>}
      {call.name === 'ask_user' && typeof args.question === 'string' && <p className="whitespace-pre-wrap typography-meta">{args.question}</p>}
      <ToolResultNotice data={data} status={status} />
      {objectResult && !purposeContent && !(plan && planItems.length || memory && content) && <JsonSummaryView data={data} />}
      {output}{details}
    </div>
  </ToolDisclosure>;
}

export function ChatArtifactTool({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const computer = call.name.startsWith('computer_');
  const label = computer ? t(call.name === 'computer_observe' ? 'chat.tools.observeComputer'
    : call.name.startsWith('computer_browser') ? 'chat.tools.browser' : call.name.startsWith('computer_office') ? 'chat.tools.office' : 'chat.tools.computer')
    : t(call.name === 'image_edit' ? 'chat.tools.editImage' : 'chat.tools.generateImage');
  const action = toolRecord(args.action ?? args.act);
  const observation = toolRecord(data.observation ?? data.result ?? data);
  const app = toolRecord(observation.app);
  const windowTitle = [toolText(app.name) || toolText(observation.app), toolText(observation.windowTitle) || toolText(app.windowTitle)].filter(Boolean).join(' · ');
  const observationLines = Array.isArray(observation.treeLines) ? observation.treeLines : Array.isArray(observation.lines) ? observation.lines : [];
  const target = toolText(args.url) || toolText(action.url) || toolText(args.path) || toolText(args.prompt) || toolText(args.desktopId);
  return <section className={computer ? 'tool-computer-event' : 'tool-media-result'}>
    <div className="tool-artifact-heading"><Icon name={computer ? 'computer' : 'file-image'} className="size-3.5 shrink-0" />
      <span className="typography-meta">{label}</span><span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={target}>{target}</span>
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}</div>
    <ToolResultNotice data={data} status={status} />
    {computer && windowTitle && <p className="typography-micro text-muted-foreground">{windowTitle}</p>}
    {computer && observation !== data && <ToolResultNotice data={observation} status={status} />}
    {observationLines.length > 0 && <ToolDisclosure id={'observation:' + call.id} className="tool-document-text">
      <summary className="typography-micro text-muted-foreground">{t('chat.tools.observedContent')}</summary>
      <pre className="tool-process-output" tabIndex={0}>{observationLines.filter(line => typeof line === 'string').join('\n')}</pre>
    </ToolDisclosure>}
    {typeof observation.text === 'string' && <p className="whitespace-pre-wrap typography-meta">{observation.text}</p>}
    {output}
    {computer && conversation && <div className="tool-inline-actions"><button type="button" onClick={() => useUIStore.getState().openContextPanelTab(cwd, { mode: 'computer', thread: conversation.identity })}>{t('chat.tools.openComputer')} <Icon name="external-link" className="size-3" /></button></div>}
    {details}
  </section>;
}
