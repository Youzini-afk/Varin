import React from 'react';
import { parseTodoPlan } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';
import { workToolContent } from './workToolContent';
import { workToolLabels, toolValueLabel } from './toolLabels';
import { ToolHeadingText } from './ToolHeadingText';
import { useToolTargets } from './toolTargetContext';
import { toolSubject } from './toolSubject';
export function ChatWorkTool({ call, execution, result, status, generating, cwd, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const targets = useToolTargets();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const plan = call.name === 'todo', memory = call.name === 'memory', settings = call.name.startsWith('settings_');
  const body = toolRecord(data.plan ?? toolRecord(data.mutation).plan);
  const planItems = typeof body.content === 'string' ? parseTodoPlan(body.content) : [];
  const label = t(plan && args.action === 'update' ? 'chat.tools.updatePlan' : memory && args.action === 'save' ? 'chat.tools.saveMemory'
    : memory && args.action === 'delete' ? 'chat.tools.deleteMemory' : workToolLabels[call.name] ?? 'chat.tools.resource');
  const subject = toolSubject(call, data, t, targets);
  const content = toolText(data.content) || toolText(toolRecord(data.note).content);
  const objectResult = result?.details !== undefined && Object.keys(data).length > 0;
  const purposeContent = workToolContent(call, data, t, cwd, conversation);
  return <ToolDisclosure id={'tool:' + call.id} initiallyExpanded={memory && Boolean(purposeContent || content)} className={'tool-work-record group ' + (plan ? 'tool-plan-record' : memory ? 'tool-memory-record' : '')}>
    <summary className="tool-work-heading"><Icon name={plan ? 'list-check-2' : memory ? 'brain' : settings ? 'settings-3'
      : call.name.includes('child') ? 'group' : call.name === 'ask_user' || call.name === 'question_status' ? 'question' : 'file-list-2'} className="size-3.5 shrink-0" />
      <ToolHeadingText label={label} subject={subject} />
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

export function ChatArtifactTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const target = toolText(args.prompt);
  return <section className="tool-media-result">
    <div className="tool-artifact-heading"><Icon name="file-image" className="size-3.5 shrink-0" />
      <span className="typography-meta">{t(call.name === 'image_edit' ? 'chat.tools.editImage' : 'chat.tools.generateImage')}</span>
      <span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={target}>{target}</span>
      {status !== 'success' && <ToolStatus status={status} generating={generating} />}</div>
    <ToolResultNotice data={data} status={status} />{output}{details}
  </section>;
}
