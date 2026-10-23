import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getToolSummary } from '@/components/chat/message/parts/toolSummary';
import { ThinkingPreview } from './ThinkingPreview';
import { ToolDisclosure } from './ToolDisclosure';
import { invocationData, invocationStatus, operationInvocation, toolRecord, toolText } from './toolInvocation';
import { fileChangePhase, fileChangeTargets, isFileChangeTool } from './fileChangePreview';
import { toolSubject } from './toolSubject';
import { useToolTargets } from './toolTargetContext';
import { isStandaloneTool } from './standaloneTools';
import { workToolLabels } from './toolLabels';
import { scriptDescendants, scriptArguments } from './scriptPresentation';
import type { DialogueActivity, DialogueProcess } from './chatDialogueProjection';
import type { ChatToolExecutionState, ChatToolResultMessage } from './types';

const actions: Record<string, I18nKey> = {
  file_read: 'chat.dialogue.read', file_list: 'chat.dialogue.list', file_search: 'chat.dialogue.search', code_retrieval: 'chat.dialogue.retrieve',
  file_write: 'chat.dialogue.write', file_edit: 'chat.dialogue.edit', apply_patch: 'chat.dialogue.edit',
  process_spawn: 'chat.dialogue.command', process_read: 'chat.tools.processOutput', process_write: 'chat.tools.processInput',
  process_inspect: 'chat.tools.inspectProcess', process_resize: 'chat.tools.resizeTerminal', process_stop: 'chat.tools.stopProcess', wait_process: 'chat.tools.waitProcess',
  script_run: 'chat.dialogue.script', script_open: 'chat.dialogue.scriptOpen', script_close: 'chat.dialogue.scriptClose',
  websearch: 'chat.dialogue.webSearch', webfetch: 'chat.dialogue.webRead', document_read: 'chat.dialogue.document',
  todo: 'chat.dialogue.plan', memory: 'chat.dialogue.memory', render_ui: 'chat.dialogue.render',
  recovery_points: 'chat.dialogue.recovery', file_restore: 'chat.dialogue.restore',
  image_generate: 'chat.dialogue.image', image_edit: 'chat.dialogue.image',
};
type Category = 'reads' | 'searches' | 'changes' | 'drafts' | 'branches' | 'commands' | 'scripts' | 'processes' | 'web' | 'collaboration' | 'plans' | 'memory' | 'other';
const category = (name: string): Category => {
  if (name === 'file_read') return 'reads';
  if (['file_search', 'file_list', 'code_retrieval'].includes(name)) return 'searches';
  if (isFileChangeTool(name)) return 'changes';
  if (name === 'process_spawn') return 'commands';
  if (name.startsWith('script_')) return 'scripts';
  if (name.startsWith('process_') || name === 'wait_process') return 'processes';
  if (['websearch', 'webfetch', 'document_read', 'research_search'].includes(name)) return 'web';
  if (name.startsWith('child_') || ['wait_child', 'threads', 'read_thread', 'send', 'submit_code', 'update', 'agent_rename'].includes(name)) return 'collaboration';
  return name === 'todo' ? 'plans' : name === 'memory' ? 'memory' : 'other';
};

export function ChatDialogueActivity({ process, executions, results, active, expanded, onExpandedChange, renderActivity }: {
  process: DialogueProcess; executions: Record<string, ChatToolExecutionState>; results: ReadonlyMap<string, ChatToolResultMessage>;
  active: boolean; expanded?: boolean; onExpandedChange?(open: boolean): void; renderActivity(item: DialogueActivity): React.ReactNode;
}) {
  const { t } = useI18n();
  const targets = useToolTargets();
  const describe = (item: Extract<DialogueActivity, { kind: 'tool' }>, execution?: ChatToolExecutionState, result?: ChatToolResultMessage) => {
    const phase = isFileChangeTool(item.call.name) ? fileChangePhase(execution, result, item.streaming) : undefined;
    const status = phase === 'failed' || phase === 'partial' ? 'error' : invocationStatus(result, execution, item.streaming);
    return { item, execution, result, status, phase };
  };
  const seenOperations = new Set<string>();
  const tools = process.activities.flatMap(item => {
    if (item.kind !== 'tool') return [];
    const root = describe(item, executions[item.call.id], results.get(item.call.id));
    const nested = item.call.name === 'script_run' ? scriptDescendants(item.call.id, executions)
      .filter(child => !isStandaloneTool(child.name) && toolRecord(toolRecord(child.operation?.intent).call).name !== 'tool_invoke')
      .map(child => describe({ id: `tool:${child.toolCallId}`, kind: 'tool', sourceId: item.sourceId, streaming: false,
        call: { type: 'toolCall', id: child.toolCallId, name: child.name, arguments: child.args ?? {} } }, child,
      child.operation ? operationInvocation(child.operation).result : undefined)) : [];
    // Use already observed nested work; opening a collapsed process does not
    // perform extra reads just to replace the script wrapper's label/count.
    return [{ ...root, counted: !nested.length }, ...nested.map(row => ({ ...row, counted: true }))];
  }).filter(row => {
    const id = row.execution?.operationId ?? row.item.call.id;
    if (seenOperations.has(id)) return false;
    seenOperations.add(id); return true;
  });
  const counts = new Map<Category, number>();
  for (const { item, status, execution, result, counted } of tools) {
    if (!counted) continue;
    const kind = category(item.call.name);
    if (kind === 'changes') {
      const effects = new Set<Category>();
      for (const file of fileChangeTargets(item.call)) {
        const phase = fileChangePhase(execution, result, false, file.path);
        if (phase === 'applied') effects.add('changes');
        if (phase === 'draft') effects.add('drafts');
        if (phase === 'branch') effects.add('branches');
      }
      for (const effect of effects) counts.set(effect, (counts.get(effect) ?? 0) + 1);
    } else if (status === 'success') counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const failures = tools.filter(row => row.status === 'error').length;
  const pending = tools.filter(row => row.counted && ['running', 'waiting', 'background'].includes(row.status));
  const uncertain = tools.filter(row => row.status === 'unknown' || row.status === 'success' && row.phase === 'preview').length;
  const cancelled = tools.filter(row => row.status === 'cancelled').length;
  const summary = [...counts].map(([kind, count]) => t(kind === 'reads' ? 'chat.activity.reads' : kind === 'changes' ? 'chat.activity.changes' : `chat.dialogue.count.${kind}`, { count })).join(' · ')
    || t(tools.length ? 'chat.dialogue.tools' : process.activities.some(item => item.kind === 'thinking') ? 'chat.dialogue.thinking' : 'chat.dialogue.records');
  const last = process.activities.at(-1);
  const liveThinking = process.tail && active && last?.kind === 'thinking' && last.streaming;
  // Keep the current public thought visible in the one-line process header. Completed
  // mixed segments retain their tool receipts; thinking-only segments retain their preview.
  const thinking = last?.kind === 'thinking' && (liveThinking || process.activities.every(item => item.kind === 'thinking')) ? last : undefined;
  const current = process.tail && active && !liveThinking ? pending.at(-1) ?? tools.at(-1) : undefined;
  let label = liveThinking ? t('chat.dialogue.thinkingNow') : summary;
  let subject = '';
  if (current) {
    const { call } = current.item;
    const purpose = workToolLabels[call.name];
    const action = actions[call.name] ? t(actions[call.name]!) : purpose ? t(purpose) : t('chat.dialogue.invoke', { name: call.name });
    label = t(current.item.streaming ? 'chat.dialogue.preparing'
      : current.status === 'running' || current.status === 'background' ? purpose && !actions[call.name] ? 'chat.dialogue.handling' : 'chat.dialogue.running'
        : current.status === 'waiting' ? 'chat.dialogue.waiting' : current.status === 'success' ? 'chat.dialogue.finished'
          : current.status === 'error' ? 'chat.dialogue.failed' : current.status === 'cancelled' ? 'chat.dialogue.cancelled' : 'chat.dialogue.unconfirmed', { action });
    const data = toolRecord(invocationData(current.result?.details ?? current.execution?.result, call));
    const compact = getToolSummary({ toolName: call.name, arguments: call.arguments, details: data }).text;
    subject = (call.name === 'process_spawn' ? compact : '') || toolSubject(call, data, t, targets)
      || (call.name === 'script_run' ? toolText(scriptArguments(call).title) : '') || compact;
    if (subject === call.name) subject = '';
  }
  const busy = liveThinking || current?.item.streaming || pending.some(row => row.status === 'running');
  const title = [label, subject].filter(Boolean).join(' · ');
  return <ToolDisclosure id={`dialogue:${process.id}`} className="dialogue-activity" open={expanded} onOpenChange={onExpandedChange}>
    <summary className="dialogue-activity-heading">
      <Icon name="arrow-right-s" className="dialogue-activity-chevron size-3.5 shrink-0" />
      <span key={current?.item.id ?? thinking?.id ?? 'summary'} className="dialogue-activity-label" title={title}>
        {busy && <Icon name="loader-4" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />}
        {thinking ? <>
          <span className="shrink-0">{label}</span>
          {thinking.content.redacted ? <span className="min-w-0 truncate">{t('chat.reasoningTrace.unavailable')}</span>
            : <ThinkingPreview text={thinking.content.thinking} streaming={Boolean(liveThinking)} active />}
        </> : <span className="min-w-0 truncate">{label}{subject && <> · {subject.replace(/\s+/g, ' ').trim()}</>}</span>}
      </span>
      {failures > 0 && <span className="shrink-0 typography-micro text-destructive">{t('chat.dialogue.failures', { count: failures })}</span>}
      {uncertain > 0 && <span className="shrink-0 typography-micro text-status-warning">{t('chat.dialogue.uncertain', { count: uncertain })}</span>}
      {cancelled > 0 && <span className="shrink-0 typography-micro">{t('chat.dialogue.stopped', { count: cancelled })}</span>}
      {!current && pending.length > 0 && <span className="shrink-0 typography-micro">{t('chat.dialogue.pending', { count: pending.length })}</span>}
      {current && pending.length > 1 && <span className="shrink-0 typography-micro">{t('chat.activity.otherPending', { count: pending.length - 1 })}</span>}
    </summary>
    <div className="dialogue-activity-body">{process.activities.map(item => <React.Fragment key={item.id}>{renderActivity(item)}</React.Fragment>)}</div>
  </ToolDisclosure>;
}
