import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { InferenceBinding, InferenceReceipt } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { ThreadOutput } from './ThreadMedia';
import { useI18n } from '@/lib/i18n';
import { canCancelOperation } from './threadOperations';

const operationCancelLabel = (operation: ThreadSnapshot['operations'][number]): string => {
  if ((operation.intent as { kind?: string } | null)?.kind === 'inference_request_v1') return 'Stop inference request';
  if (operation.mcp_resource_subscription) return 'Stop resource observation';
  if (operation.host_job?.mcpTask) return 'Request remote task cancellation';
  if (operation.executor === 'dispatch') return 'Cancel child task';
  if (operation.waiting_on?.startsWith('host-job-wait:')
    || (operation.execution_owner?.kind === 'kernel' && (operation.executor === 'wait_child'
      || operation.executor === 'wait_process' || (operation.executor === 'send' && operation.waiting_on !== null)))) {
    return 'Cancel observation wait';
  }
  return 'Cancel operation';
};

function InferenceStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const intent = operation.intent as { kind?: string; binding?: InferenceBinding } | null;
  if (intent?.kind !== 'inference_request_v1' || !intent.binding) return null;
  const state = operation.result?.kind === 'control'
    ? operation.result.value as { dispatched: boolean; recovered: boolean; receipt?: InferenceReceipt } : undefined;
  const receipt = state?.receipt;
  const problem = receipt?.problem;
  const preparation = intent.binding.requestKind === 'preparation';
  const explanation = problem === 'receipt_pending' ? preparation
    ? 'The preparation transport has stopped, but its original response is awaiting durable publication.'
    : 'The transport has stopped, but its original response is awaiting durable publication. Usage remains unknown until that receipt is stored.'
    : problem === 'owner_interrupted' ? preparation
      ? 'The original preparation executor was interrupted; this request will not be replayed.'
      : 'The original executor was interrupted. Remote usage is unconfirmed; this request will not be replayed.'
    : problem === 'invalid_response' ? 'The provider response was stored, but its model result was invalid. Check the selected protocol.'
    : problem === 'http_rejected' ? 'The provider rejected this request. Check the original connection and account.'
    : problem === 'transport_failed' ? 'The transport stopped without a complete response. Check the original service before requesting another inference.'
    : problem === 'not_dispatched' ? 'This request was not sent. Check its parent operation, Goal and current access before starting a new inference.'
    : problem === 'cancelled' ? 'Cancellation was requested. Any usage already received remains accounted.' : null;
  return <section aria-label="Inference request" className="space-y-1 text-xs text-muted-foreground">
    <p>{intent.binding.purpose} · {intent.binding.providerId} / {intent.binding.modelId} · {preparation ? 'Preparation' : 'Model compute'}</p>
    <p>{receipt?.requestStarted === false ? 'Not sent' : receipt?.requestStarted === true ? 'Transport started' : state?.dispatched ? 'Dispatch recorded; sending unconfirmed' : 'Awaiting dispatch'}
      {' · '}{receipt?.localExecutorStopped ? 'Local executor stopped' : 'Local executor stop unconfirmed'}</p>
    {preparation ? <p>Tokenization or template preparation; no model inference usage.</p>
      : <p>Input tokens: {receipt?.usage.inputTokens ?? 'unknown'} · Output tokens: {receipt?.usage.outputTokens ?? 'unknown'}</p>}
    {!preparation && receipt?.providerCompleted && receipt.usage.measurement === 'missing'
      && <p>The response does not establish input/output token usage or cost.</p>}
    {explanation && <p role="status">{explanation}</p>}
  </section>;
}

function McpTaskStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const job = operation.host_job;
  const link = job?.mcpTask;
  if (!link || job.binding.subject.kind !== 'mcp') return null;
  const problem = link.problem;
  const problemText = problem?.kind === 'owner' ? 'The original MCP connection or account is unavailable. Restore that connection to observe this task.'
    : problem?.kind === 'expired' ? 'The remote task retention period has elapsed. Its execution may still be running.'
    : problem?.kind === 'unsupported' ? problem.stage === 'cancel' ? 'This server does not support task cancellation. Check the original service.'
      : problem.stage === 'interaction' ? 'This task needs an interaction that this client does not support. Check the original service.'
      : 'The original service does not support this task operation. Check its task capabilities before retrying.'
    : problem?.kind === 'protocol' ? 'The server could not provide a valid task response. Check the original service; the task identity is retained.'
    : problem?.kind === 'transport' ? 'The original MCP connection could not be reached. Check its connection; observation can resume when it is available.' : null;
  return <section aria-label="Remote MCP task" className="space-y-1 text-xs text-muted-foreground">
    <p>{job.binding.subject.endpoint.server} · remote task {link.task.taskId}</p>
    <p>Remote status: {link.task.status.replaceAll('_', ' ')} · {link.resultReady ? 'Result stored' : 'Result not received'}</p>
    <p>{operation.external_receipt?.executor_stopped ? 'Executor stop confirmed' : 'Executor stop unconfirmed'}
      {operation.cancel_requested && ' · Cancellation requested'}</p>
    {link.task.status === 'cancelled' && !operation.external_receipt?.executor_stopped && <p>The server acknowledged cancellation. This does not prove execution has stopped.</p>}
    {link.task.status === 'input_required' && <p>The server is waiting for an interaction on the original task result stream.</p>}
    {link.availability === 'unavailable' && <p>Current task observation unavailable</p>}
    {problemText && <p role="status">{problemText} · {problem!.stage}{problem!.rpcCode !== undefined ? ` · RPC ${problem!.rpcCode}` : ''}</p>}
  </section>;
}

function McpResourceStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const subscription = operation.mcp_resource_subscription;
  if (!subscription) return null;
  const availability = {
    pending: 'Subscription acknowledgement pending',
    active: 'Resource observation active',
    gap: 'Resource observation gap: some updates may have been missed',
    unavailable: 'Resource observation unavailable',
    closed: 'Resource observation closed',
  }[subscription.availability];
  const cleanup = {
    not_requested: 'Remote cleanup not requested',
    shared: 'Remote subscription retained for other observers',
    acknowledged: 'Remote unsubscribe acknowledged',
    unknown: 'Remote cleanup unconfirmed',
  }[subscription.remoteCleanup];
  return <section aria-label="MCP resource observation" className="space-y-1 text-xs text-muted-foreground">
    <p>{subscription.binding.endpoint.server} · {subscription.binding.uri}</p>
    <p>{availability}</p>
    <p>{subscription.localReleased ? 'Local observation released' : 'Local observation retained'} · {cleanup}</p>
    {subscription.availability === 'gap' && <p>Read the resource explicitly if you need its current contents.</p>}
    {subscription.problem && <p role="status">{subscription.availability === 'closed' && subscription.localReleased
      ? 'Observation has ended locally. Check the original service if remote cleanup needs attention.'
      : 'Check the original MCP connection and resource access. Updates do not read the resource automatically.'}</p>}
  </section>;
}


export function ThreadOperationDetails({ api, identity, operation, readOnly, pending, waitingOn, onCancel, onOpenTerminal }: {
  api: ThreadsAPI; identity: ThreadIdentity; operation: ThreadSnapshot['operations'][number]; readOnly: boolean; pending: boolean;
  waitingOn?: string | null; onCancel(): void; onOpenTerminal(): void;
}) {
  const { t } = useI18n();
  return <div className="space-y-3 break-words typography-meta">
    <details className="typography-micro text-muted-foreground"><summary>{t('harness.overview.operations')}</summary><p>{operation.phase} · {operation.outcome} · {operation.effect}</p></details>
    <InferenceStatus operation={operation} />
    <McpTaskStatus operation={operation} />
    <McpResourceStatus operation={operation} />
    {operation.host_job?.mcpTaskResult && <ThreadOutput api={api} identity={identity} holder={{ kind: 'operation', operationId: operation.id, output: 'mcp_task_result' }} output={operation.host_job.mcpTaskResult} messageId={operation.id} />}
    {!readOnly && api.processes && operation.executor === 'process_spawn' && operation.call_completion?.kind === 'job_accepted'
      && (operation.intent as { call?: { arguments?: { mode?: string } } } | null)?.call?.arguments?.mode === 'pty'
      && <Button variant="outline" size="sm" disabled={pending} onClick={onOpenTerminal}>Open process terminal</Button>}
    {operation.call_completion && operation.call_completion.kind !== 'not_dispatched' && operation.call_completion.content && <ThreadOutput api={api} identity={identity} holder={{ kind: 'operation', operationId: operation.id, output: 'completion' }} output={operation.call_completion.content} messageId={operation.id + ':completion'} />}
    {operation.result?.kind === 'output' && <ThreadOutput api={api} identity={identity} holder={{ kind: 'operation', operationId: operation.id, output: 'result' }} output={operation.result.output} messageId={operation.id + ':result'} />}
    {operation.external_receipt && <ThreadOutput api={api} identity={identity} holder={{ kind: 'operation', operationId: operation.id, output: 'external_receipt' }} output={operation.external_receipt.result} messageId={operation.id + ':receipt'} />}
    {!readOnly && canCancelOperation(operation, waitingOn) && <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>{operationCancelLabel(operation)}</Button>}
  </div>;
}
