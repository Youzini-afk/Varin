import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import { renderTerminalOutput } from '@/components/chat/message/parts/toolOutput';
import { useUIStore } from '@/stores/useUIStore';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { canCancelOperation } from '../thread/threadOperations';
import { invocationOperationId, toolRecord, toolText } from './toolInvocation';
import { ToolResultNotice } from './ChatResourceTools';
import type { ToolViewProps } from './toolViewTypes';
import { toolValueLabel } from './toolLabels';
import { ToolHeadingText } from './ToolHeadingText';
import { processCommand, useToolTargets } from './toolTargetContext';
import { subjectJoin, toolSubject } from './toolSubject';

export function ChatProcessTool({ call, execution, result, status, generating, output, details }: ToolViewProps) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const expanded = useUIStore(state => state.showExpandedBashTools);
  const targets = useToolTargets();
  const args = toolRecord(call.arguments), operation = execution?.operation;
  const data = toolRecord(result?.details ?? execution?.result);
  const finalData = toolRecord(operation?.external_receipt?.result.data);
  const snapshot = toolRecord(data.process ?? data.snapshot ?? finalData.process ?? finalData.snapshot
    ?? (typeof data.status === 'string' ? data : finalData));
  const chunks = Array.isArray(data.chunks) ? data.chunks.map(toolRecord) : [];
  const text = chunks.length ? chunks.map(chunk => toolText(chunk.text)).join('')
    : operation?.external_receipt?.result.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n') ?? '';
  const processId = toolText(args.processId) || toolText(data.processId) || toolText(snapshot.processId);
  const command = processCommand(args) || targets?.processes.get(processId) || '';
  const operationId = invocationOperationId(call, execution);
  const spawning = call.name === 'process_spawn';
  const waiting = call.name === 'wait_process';
  const [error, setError] = React.useState<string>();
  const [stopping, setStopping] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const viewport = React.useRef<HTMLPreElement>(null);
  const follow = React.useRef(true);
  const [following, setFollowing] = React.useState(true);
  React.useLayoutEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text]);
  const host = getRuntimeEndpointGeneration();
  const live = (spawning || waiting) && operation && canCancelOperation(operation);
  const stop = async () => {
    if (!operationId || !conversation || stopping) return;
    setError(undefined); setStopping(true);
    try { await conversation.api.cancelOperation(operationId); }
    catch (failure) { if (host === getRuntimeEndpointGeneration()) { setError(String(failure)); setStopping(false); } }
  };
  const terminal = async () => {
    if (!conversation?.api.processes || !operationId || opening) return;
    setOpening(true); setError(undefined);
    try {
      const binding = await conversation.api.processes.openTerminal({ ...conversation.identity, operationId });
      if (host !== getRuntimeEndpointGeneration()) return;
      attachProcessTerminal(binding.cwd, binding.sessionId, command, binding.resourceOwner, {
        identity: conversation.identity, operationId: binding.operationId, processId: binding.processId, endpointGeneration: host,
      });
    } catch (failure) { if (host === getRuntimeEndpointGeneration()) setError(String(failure)); }
    finally { setOpening(false); }
  };
  const label = t(spawning ? 'chat.toolSummary.runProcess' : waiting ? 'chat.tools.waitProcess' : call.name === 'process_stop' ? 'chat.tools.stopProcess'
    : call.name === 'process_read' ? 'chat.tools.processOutput' : call.name === 'process_write' ? 'chat.tools.processInput'
      : call.name === 'process_resize' ? 'chat.tools.resizeTerminal' : 'chat.tools.inspectProcess');
  const subject = toolSubject(call, { ...data, process: snapshot }, t, targets);
  const receipt = subjectJoin(typeof data.confirmedBytes === 'number' ? t('chat.toolSummary.inputBytes', { count: data.confirmedBytes }) : '',
    typeof snapshot.exitCode === 'number' ? t('chat.tools.exitCode', { code: snapshot.exitCode }) : toolValueLabel(snapshot.status, t),
    call.name === 'process_read' && Array.isArray(data.chunks) && (text || data.chunks.length === 0)
      ? t('chat.toolSummary.outputLines', { count: text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0 }) : '',
    data.stopConfirmed === false ? t('chat.tools.cancelAwaitingStop') : '');
  return <ToolDisclosure id={'tool:' + call.id} className="tool-process group" initiallyExpanded={expanded || status === 'error'}>
    <summary className="tool-command-heading"><Icon name="terminal" className="size-3.5 shrink-0" />
      <ToolHeadingText label={label} subject={subject} receipt={receipt} />
      <span className={status === 'success' && receipt ? 'sr-only' : undefined}><ToolStatus status={status} generating={generating} stopped={Boolean(live && (stopping || operation?.cancel_requested))} /></span>
      <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" /></summary>
    <div className="tool-process-console">
      {spawning && command && <pre className="tool-command-line">{'› ' + command}</pre>}
      {text && <pre ref={viewport} tabIndex={0} className="tool-process-output" data-conversation-tool-scroll="true" onScroll={event => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 2;
        setFollowing(follow.current);
      }}>{renderTerminalOutput(text)}</pre>}
      <div className="tool-process-receipt typography-micro text-muted-foreground">
        {processId && <span title={processId} className="max-w-64 truncate">{processId}</span>}
        {typeof snapshot.status === 'string' && <span>{toolValueLabel(snapshot.status, t)}</span>}
        {typeof snapshot.exitCode === 'number' && <span>{t('chat.tools.exitCode', { code: snapshot.exitCode })}</span>}
        {snapshot.outputComplete === false && <span>{t('chat.tools.partialOutput')}</span>}
      </div>
      {output}
      <div className="tool-inline-actions">
        {!following && <button type="button" onClick={() => { follow.current = true; setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}>{t('chat.tools.followOutput')} <Icon name="arrow-down-s" className="size-3" /></button>}
        {spawning && !generating && (operation?.managed_process || result?.status === 'background') && args.mode === 'pty' && operationId && conversation?.api.processes && !conversation.readOnly && <button type="button" disabled={opening} onClick={() => void terminal()}>{t('chat.timeline.tools.openTerminal')} <Icon name="external-link" className="size-3" /></button>}
        {live && !conversation?.readOnly && <button type="button" disabled={stopping || operation?.cancel_requested} onClick={() => void stop()}>{t(waiting ? 'chat.tools.stopWaiting' : 'chat.tools.stopProcess')}</button>}
      </div>
      {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
      <ToolResultNotice data={data} status={status} />{details}
    </div>
  </ToolDisclosure>;
}
