import React from 'react';
import type { Operation, OperationCallSummary } from '@varin/protocol';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { useOptionalConversationPresentation } from './ConversationContext';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { timelinePresentationCache } from './timelinePresentationCache';
import { getToolSummary } from '@/components/chat/message/parts/toolSummary';
import { orderScriptCalls, scriptArguments, scriptCallStatus, scriptDescendants, scriptOperationId, scriptTitleKey, scriptToolLabels } from './scriptPresentation';

function StatusIcon({ status }: { status: ChatToolExecutionState['status'] }) {
  return <Icon name={status === 'running' ? 'loader-4' : status === 'error' || status === 'unknown' ? 'error-warning'
    : status === 'cancelled' ? 'close' : status === 'success' ? 'check' : 'time'}
    className={`size-3.5 shrink-0 ${status === 'running' ? 'animate-spin' : ''} ${status === 'error' ? 'text-destructive' : ''}`} />;
}

/** Presentation reads the original call lineage; scripts are never inspected by executing them. */
export function ChatScriptCard({ call, execution, executions = {}, status, result, sessionId, output, rawDetails, renderCall, preview = false, generating = false }: {
  call: ChatToolCall; execution?: ChatToolExecutionState; executions?: Record<string, ChatToolExecutionState>;
  status: ChatToolExecutionState['status']; result?: ChatToolResultMessage; sessionId: string;
  output: React.ReactNode; rawDetails: React.ReactNode; renderCall(operation: Operation): React.ReactNode; preview?: boolean; generating?: boolean;
}) {
  const { t } = useI18n();
  const api = useOptionalConversationPresentation()?.api;
  const [choices] = React.useState(() => timelinePresentationCache(sessionId, 'script-cards', () => new Map<string, boolean>()));
  const [open, setOpen] = React.useState(() => choices.get(call.id) ?? false);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [view, setView] = React.useState<{ owner: string; calls: OperationCallSummary[] }>();
  const [error, setError] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const operationId = scriptOperationId(call, execution);
  const owner = `${generation}:${operationId}`;
  const calls = view?.owner === owner ? view.calls : [];
  const liveCalls = scriptDescendants(call.id, executions);
  const signature = JSON.stringify(liveCalls.map(item => [item.operationId, item.status]));
  const admitted = status !== 'running' || execution?.revision !== undefined || liveCalls.length > 0;
  const args = scriptArguments(call);
  const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
  React.useEffect(() => {
    setError(false);
    if (preview || generating || !admitted || result?.notDispatched || call.name !== 'script_run' || !operationId || !api?.toolCalls) return;
    const controller = new AbortController();
    void api.toolCalls(operationId, controller.signal).then(value => {
      if (!controller.signal.aborted) setView({ owner, calls: orderScriptCalls(value) });
    }, () => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [api, operationId, owner, call.name, preview, generating, admitted, execution?.revision, result?.notDispatched, status, signature, retry]);
  const liveById = new Map(liveCalls.map(item => [item.operationId, item]));
  const attention = calls.filter(item => ['error', 'unknown'].includes(liveById.get(item.operationId)?.status ?? scriptCallStatus(item))).length;
  const active = calls.filter(item => (liveById.get(item.operationId)?.status ?? scriptCallStatus(item)) === 'running').length;
  const details = result?.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : undefined;
  const valueText = typeof details?.valueText === 'string' ? details.valueText : undefined;
  const failure = typeof details?.error === 'string' ? details.error
    : details?.error && typeof details.error === 'object' && !Array.isArray(details.error) && typeof details.error.message === 'string' ? details.error.message : undefined;
  return <details open={open} data-conversation-tool-disclosure={`tool:${call.id}`} className="workbench-disclosure my-1"
    onToggle={event => { if (event.target !== event.currentTarget) return; const next = event.currentTarget.open; setOpen(next); choices.set(call.id, next); }}>
    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1 truncate" title={title || t(scriptTitleKey(call, calls))}>{title || t(scriptTitleKey(call, calls))}</span>
      {calls.length > 0 && <span className="shrink-0 typography-micro">{t('chat.timeline.tools.callCount', { count: calls.length })}</span>}
      {attention > 0 && <span className="shrink-0 typography-micro text-[var(--status-warning)]">{t('chat.script.attention', { count: attention })}</span>}
      {active > 0 && status !== 'running' && <span className="shrink-0 typography-micro">{active} {t('chat.timeline.tools.running')}</span>}
      <span className="shrink-0 rounded border border-border/50 px-1 typography-micro">JS</span>
      <span className={status === 'success' ? 'sr-only' : 'shrink-0 typography-micro'}>{t(`chat.timeline.tools.${status}`)}</span>
      <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
    </summary>
    {open && <div className="ml-2 space-y-3 border-l border-border/60 py-2 pl-3">
      {failure && <p role="alert" className="whitespace-pre-wrap break-words typography-meta text-destructive">{failure}</p>}
      {output}
      {valueText && <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 typography-micro">{valueText}</pre>}
      {calls.length > 0 && <section aria-label={t('chat.script.calls')} className="space-y-1">
        <p className="typography-micro text-muted-foreground">{t('chat.script.calls')}</p>
        {calls.map(item => <ScriptCallRow key={`${owner}:${item.operationId}`} call={item} live={liveById.get(item.operationId)} renderCall={renderCall} />)}
      </section>}
      {error && <p role="alert" className="typography-meta text-muted-foreground">{t('chat.script.loadFailed')} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>{t('chat.script.retry')}</button></p>}
      {typeof args.script === 'string' && <details className="group/script"><summary className="cursor-pointer typography-micro text-muted-foreground">{t('chat.script.source')}</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-3 font-mono typography-micro"><code>{args.script}</code></pre>
      </details>}
      <details><summary className="cursor-pointer typography-micro text-muted-foreground">{t('chat.script.details')}</summary>
        <div className="mt-2 space-y-2"><span className="font-mono typography-micro">{call.name}</span>{rawDetails}</div>
      </details>
    </div>}
  </details>;
}

function ScriptCallRow({ call, live, renderCall }: { call: OperationCallSummary; live?: ChatToolExecutionState; renderCall(operation: Operation): React.ReactNode }) {
  const { t } = useI18n();
  const api = useOptionalConversationPresentation()?.api;
  const [open, setOpen] = React.useState(false);
  const [operation, setOperation] = React.useState<Operation>();
  const [error, setError] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const status = live?.status ?? scriptCallStatus(call);
  const label = scriptToolLabels[call.name];
  const savedCall = operation?.intent as { call?: { arguments?: unknown } } | undefined;
  const summary = getToolSummary({ toolName: call.name, arguments: live?.args ?? savedCall?.call?.arguments }).text;
  React.useEffect(() => {
    if (!open || !api) return;
    let active = true; setError(false);
    void api.operation(call.operationId).then(value => {
      if (active && value.id === call.operationId) setOperation(value);
    }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, call.operationId, status, open, retry]);
  return <details open={open} className="rounded-md" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1.5 pr-2 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden" style={{ paddingLeft: `${call.depth * 12 + 4}px` }}>
      <StatusIcon status={status} /><span className="min-w-0 flex-1" title={call.name}><span className="block truncate">{label ? t(label) : call.name}</span>
        {summary && summary !== call.name && <span className="block truncate typography-micro" title={summary}>{summary}</span>}</span>
      <span className="shrink-0 typography-micro">{call.cancelRequested && call.phase !== 'terminal' ? t('chat.children.stopping') : t(`chat.timeline.tools.${status}`)}</span>
      <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
    </summary>
    {open && <div className="ml-3 space-y-2 border-l border-border/50 py-2 pl-3">
      {error && <p role="alert" className="typography-meta text-muted-foreground">{t('chat.script.loadFailed')} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>{t('chat.script.retry')}</button></p>}
      {operation ? renderCall(operation) : !error && <Icon name="loader-4" className="size-3.5 animate-spin" />}
    </div>}
  </details>;
}
