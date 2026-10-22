import React from 'react';
import type { Followup, FollowupView } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { JsonSummaryView } from '@/components/chat/message/parts/JsonSummaryView';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolStatus, ToolDisclosure } from './ToolDisclosure';
import { ToolResultNotice } from './ChatResourceTools';
import { toolRecord, toolText } from './toolInvocation';
import { toolValueLabel } from './toolLabels';
import { useToolAction } from './useToolAction';
import type { ToolViewProps } from './toolViewTypes';
import { ToolHeadingText } from './ToolHeadingText';
import { toolSubject } from './toolSubject';

function Condition({ source, observed }: { source: Record<string, unknown>; observed: boolean }) {
  const { t } = useI18n();
  const kind = toolText(source.kind);
  const labels = { at: 'atTime', process_stopped: 'processStopped', job_stopped: 'jobStopped', file: 'fileCondition', artifact: 'artifactReady', collection: 'collectionReady', log_literal: 'logMatch', log_end: 'logEnded', metric: 'metricCondition', run_completed: 'runCompleted', goal_requested: 'goalContinues' } as const;
  const label = labels[kind as keyof typeof labels];
  const subject = kind === 'at' ? new Date(Number(source.at_ms ?? source.atMs)).toLocaleString()
    : kind === 'file' ? toolText(source.path) + ' · ' + toolValueLabel(source.condition, t)
      : kind === 'metric' ? [source.machine_id ?? source.machineId, source.metric, source.predicate, source.threshold].join(' · ')
        : toolText(source.name) || toolText(source.literal) || toolText(source.operation_id) || toolText(source.operationId);
  return <li className="tool-follow-condition" data-observed={observed}><Icon name={observed ? 'checkbox-circle' : 'checkbox-blank-circle'} className="size-3.5" />
    <div><p>{label ? t(('chat.tools.condition.' + label) as Parameters<typeof t>[0]) : kind}</p>{subject && <small>{subject}</small>}</div><span>{t(observed ? 'chat.tools.conditionMet' : 'chat.tools.conditionWaiting')}</span></li>;
}

function FollowupRecord({ id, data, args }: { id: string; data: Record<string, unknown>; args: Record<string, unknown> }) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const action = useToolAction('followup:' + id + ':' + conversation?.identity.threadId);
  const [loaded, setLoaded] = React.useState<FollowupView>(), [history, setHistory] = React.useState<import('@varin/protocol').FollowupOccurrencesResult>();
  const [open, setOpen] = React.useState(false);
  const current = conversation?.followups?.find(item => item.id === id);
  const loadedItem = loaded?.followup;
  const raw = toolRecord(data.followup);
  const recorded = raw.id === id && typeof raw.revision === 'number' && Array.isArray(raw.sources) && typeof raw.state === 'string' ? raw as unknown as Followup : undefined;
  const observed = loadedItem ?? recorded;
  const item: Followup | undefined = current && (!observed || current.revision >= observed.revision) ? current : observed;
  const trigger = toolRecord(item?.trigger ?? toolRecord(data.followup).trigger ?? data.trigger ?? args.trigger);
  const sources = Array.isArray(trigger.sources) ? trigger.sources.map(toolRecord) : trigger.kind ? [trigger] : [];
  const instruction = loaded?.instruction ?? (toolText(data.instruction) || toolText(args.instruction));
  const refresh = () => { if (conversation && id) void action.run(signal => conversation.api.followups.get(conversation.identity, id, signal), setLoaded); };
  const control = (mode: 'pause' | 'resume') => { if (conversation && item) void action.run(() => conversation.api.followups.control({ ...conversation.identity, followupId: id, expectedRevision: item.revision, action: mode }), value => setLoaded(previous => ({ followup: value, instruction: previous?.instruction ?? instruction, registration_trigger: previous?.registration_trigger ?? null }))); };
  return <div className="tool-followup-record">
    {instruction && <p className="tool-follow-instruction">{instruction}</p>}
    {sources.length > 1 && <p className="typography-micro text-muted-foreground">{t(trigger.kind === 'any' ? 'chat.tools.anyCondition' : 'chat.tools.allConditions')}</p>}
    <ol className="tool-follow-conditions">{sources.map((source, index) => <Condition key={index} source={source} observed={Boolean(item?.sources.find(value => value.source_index === index)?.observed)} />)}</ol>
    <div className="tool-inline-actions"><span className="typography-micro" role="status">{item ? toolValueLabel(item.state, t) : t('chat.tools.registrationRecorded')}</span>
      {conversation && id && <button type="button" disabled={action.busy} onClick={refresh}>{t('chat.tools.refresh')}</button>}
      {conversation && !conversation.readOnly && item && item.state !== 'cancelled' && !item.exhausted && <button type="button" disabled={action.busy} onClick={() => control(item.state === 'paused' ? 'resume' : 'pause')}>{t(item.state === 'paused' ? 'chat.tools.resumeFollowup' : 'chat.tools.pauseFollowup')}</button>}
      {conversation && id && <button type="button" aria-expanded={open} disabled={action.busy} onClick={() => { setOpen(!open); if (!open) void action.run(async signal => ({ view: await conversation.api.followups.get(conversation.identity, id, signal), history: await conversation.api.followups.occurrences(conversation.identity, id) }), value => { setLoaded(value.view); setHistory(value.history); }); }}>{t('chat.tools.triggerHistory')}</button>}</div>
    {item?.state === 'paused' && <p className="typography-micro text-muted-foreground">{t('chat.tools.pausedConditions')}</p>}
    {item?.occurrence?.delivery && <p className="typography-meta">{t('chat.tools.continuation')} · {toolValueLabel(item.occurrence.delivery.state, t)}{item.occurrence.delivery.failure_code ? ' · ' + item.occurrence.delivery.failure_code : ''}</p>}
    {open && <div className="tool-trigger-history">{history?.occurrences.map(occurrence => <div key={occurrence.id}><Icon name={occurrence.state === 'completed' ? 'check' : 'time'} className="size-3.5" /><div><p className="typography-meta">{toolValueLabel(occurrence.state, t)}{occurrence.hold_reason ? ' · ' + toolValueLabel(occurrence.hold_reason, t) : ''}</p><ToolDisclosure id={'occurrence:' + occurrence.id} className="tool-document-text"><summary className="typography-micro">{t('chat.tools.triggerEvidence')}</summary><JsonSummaryView data={occurrence.evidence} /></ToolDisclosure></div></div>)}
      {history && !history.occurrences.length && <p className="typography-micro text-muted-foreground">{t('chat.tools.notTriggered')}</p>}
      {history?.nextCursor != null && conversation && <button type="button" className="tool-text-button" disabled={action.busy} onClick={() => void action.run(() => conversation.api.followups.occurrences(conversation.identity, id, history.nextCursor!), value => setHistory(previous => ({ ...value, occurrences: [...(previous?.occurrences ?? []), ...value.occurrences] })))}>{t('chat.tools.moreHistory')}</button>}
    </div>}
    {action.error && <p role="alert" className="typography-meta text-destructive">{action.error}</p>}
  </div>;
}

export function ChatFollowupTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const entries = Array.isArray(data.followups) ? data.followups.map(item => ({ followup: item })) : typeof data.id === 'string' && data.trigger ? [{ followup: data }] : [data];
  return <section className="tool-followup-activity"><div className="tool-source-heading"><Icon name="time" className="size-3.5" /><ToolHeadingText label={t('chat.tools.followup')} subject={toolSubject(call, data, t)} /><ToolStatus status={status} generating={generating} /></div>
    {entries.map((entry, index) => <FollowupRecord key={toolText(toolRecord(entry.followup).id) || index} id={toolText(toolRecord(entry.followup).id) || toolText(data.followupId) || toolText(args.followupId)} data={entry} args={args} />)}
    <ToolResultNotice data={data} status={status} />{output}{details}</section>;
}
