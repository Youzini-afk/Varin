import React from 'react';
import { ThreadRequestError, type ThreadIdentity, type ThreadModel, type ThreadModelInfo, type ThreadsAPI } from '@varin/application-client';
import type { McpInteractionItem, McpInteractionView, McpSamplingOutputAction } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type SamplingAPI = Pick<ThreadsAPI, 'readMcpInteraction' | 'reviewMcpSamplingRequest' | 'reviewMcpSamplingOutput' | 'cancelOperation'>;
interface Props {
  api: SamplingAPI;
  identity: ThreadIdentity;
  view: McpInteractionItem;
  update(view: McpInteractionItem): void;
  models: ThreadModelInfo[];
  selectedModel?: ThreadModel;
  modelError?: string;
}
const compact = ({ record, presentation, response, generation }: McpInteractionItem): McpInteractionItem => ({ record, presentation, response, ...(generation ? { generation } : {}) });
const modelKey = (model: ThreadModel) => JSON.stringify([model.providerId, model.modelId]);
const availableModel = (models: ThreadModelInfo[], model?: ThreadModel) => model && models.some(entry => modelKey(entry) === modelKey(model)) ? model : undefined;
const isLive = ({ record }: McpInteractionItem) => record.availability === 'live' && record.choice === null && record.delivery === 'not_started';
const json = (value: unknown) => JSON.stringify(value, null, 2);
const diagnostics: Record<string, string> = {
  mcp_sampling_request_invalid: 'The owner rejected this request. Check its fields and message content, then generate again.',
  mcp_sampling_tools_unsupported: 'The owner cannot use sampling tools. Edit tools, toolChoice or tool content before generating again.',
  mcp_sampling_task_unsupported: 'The owner cannot use task-augmented sampling. Edit the task field before generating again.',
  mcp_sampling_context_unsupported: 'The owner cannot include conversation or server context. Review includeContext before generating again.',
  mcp_sampling_metadata_unsupported: 'The owner cannot apply provider metadata. Review the metadata field before generating again.',
  mcp_sampling_audio_unsupported: 'The owner cannot use audio input. Review the message content before generating again.',
  mcp_sampling_media_invalid: 'The owner rejected the image MIME type or encoded bytes. Review the image content.',
  mcp_sampling_token_limit_unsupported: 'The selected adapter cannot enforce maxTokens. Choose another available model.',
  mcp_sampling_stop_sequences_unsupported: 'The selected adapter cannot apply stopSequences. Edit the request or choose another available model.',
  mcp_sampling_output_unsupported: 'The provider returned unsupported output. The original output is retained for review and will not be executed.',
  mcp_sampling_connection_lost: 'The original MCP connection was lost. Generation and response delivery must be checked separately.',
  mcp_sampling_goal_unavailable: 'The original Goal no longer allows this inference. Review its state, budget and recorded usage before generating again.',
  model_options: 'The owner rejected the selected model options. Review the model configuration before generating again.',
  unsupported_provider: 'The selected provider is unavailable for sampling. Choose another available model.',
  'model-protocol-unavailable': 'The selected model protocol is unavailable. Choose another registered model.',
  'model-thinking-level-unavailable': 'The selected thinking level is unavailable. Choose the model again to use its current registered options.',
  'model-thinking-output-capacity-insufficient': 'The model output capacity is too small for this thinking level. Review the model settings or choose another model.',
  'model-temperature-invalid': 'The selected model temperature is invalid. Review the model settings or choose another model.',
  'model-endpoint-missing': 'The selected model has no usable endpoint. Check its provider settings or choose another model.',
  'model-endpoint-invalid': 'The selected model endpoint is invalid. Check its provider settings or choose another model.',
  'model-endpoint-contains-credentials': 'The selected model endpoint contains credentials. Move authentication to the provider settings before generating.',
  'credential-scope-unavailable': 'The selected model account is unavailable. Check its provider connection and choose the model again.',
  'registered-model-not-found': 'The selected model is no longer available. Choose another model before generating.',
};
const diagnostic = (code: string) => Object.hasOwn(diagnostics, code) ? diagnostics[code] : undefined;
const rejectedRequest = (failure: unknown) => failure instanceof ThreadRequestError && failure.admission === 'not_started';
const errorText = (failure: unknown) => {
  if (failure instanceof ThreadRequestError) {
    if (rejectedRequest(failure)) return diagnostic(failure.code)
      ?? 'Model selection failed before generation started. Check the provider settings or choose another available model.';
    if (failure.status === 409) return 'This sampling review changed. Refresh the review before taking another action.';
    if (failure.status === 403) return 'This sampling request is unavailable in the selected conversation branch.';
    if (failure.code === 'mcp_interaction_owner_unavailable') return 'The original MCP connection is unavailable. Check that connection and refresh the review.';
  }
  return 'This action could not be confirmed. Refresh the review to check its recorded state before taking another action.';
};

/** A new owner or conversation gets a fresh reader and draft, even if request IDs are reused. */
export function ThreadMcpSampling(props: Props) {
  const [owner, setOwner] = React.useState({ api: props.api, epoch: 0 });
  if (owner.api !== props.api) setOwner({ api: props.api, epoch: owner.epoch + 1 });
  const key = JSON.stringify([owner.epoch, props.identity.runtime, props.identity.threadId, props.identity.branchId, props.view.record.binding.operationId, props.view.record.id]);
  return <SamplingReview key={key} {...props} />;
}

function SamplingReview({ api, identity, view, update, models, selectedModel, modelError }: Props) {
  const [expanded, setExpanded] = React.useState(false);
  const [detail, setDetail] = React.useState<McpInteractionView>();
  const [draft, setDraft] = React.useState<string>();
  const [chosen, setChosen] = React.useState<ThreadModel>();
  const [modelTouched, setModelTouched] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [uncertain, setUncertain] = React.useState<McpInteractionItem>();
  const [stopRequested, setStopRequested] = React.useState<string>();
  const alive = React.useRef(true);
  const reader = React.useRef<AbortController | null>(null);
  const sending = React.useRef(false);
  const latest = React.useRef(view);
  latest.current = view;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; reader.current?.abort(); }; }, []);
  const { record, generation, presentation } = view;
  const review = record.sampling?.review;
  const generationId = record.sampling?.generationOperationId;
  const selected = availableModel(models, modelTouched ? chosen : selectedModel);
  const ready = isLive(view) && !busy && !uncertain;
  const canGenerate = !generationId || generation?.phase === 'terminal';
  const requestReady = ready && review === 'request' && canGenerate;
  const currentDetail = detail?.record.revision === record.revision ? detail : undefined;
  const outputReady = ready && review === 'output' && expanded && currentDetail?.sampling?.output != null;
  const generating = generation && generation.phase !== 'terminal';

  const receive = (result: McpInteractionView, keepBodies: boolean) => {
    const current = latest.current;
    if (result.record.id !== current.record.id || result.record.binding.operationId !== current.record.binding.operationId
      || result.record.threadId !== identity.threadId || result.record.branchId !== identity.branchId
      || result.record.revision < current.record.revision) return false;
    update(compact(result));
    if (keepBodies) {
      setDetail(result);
      setDraft(value => value ?? json(result.sampling?.editedRequest ?? result.request));
    }
    return true;
  };
  const refresh = async () => {
    if (reader.current || sending.current) return;
    const controller = new AbortController(); reader.current = controller;
    setExpanded(true); setLoading(true); setError(undefined);
    try {
      const result = await api.readMcpInteraction({ ...identity, operationId: record.binding.operationId, interactionId: record.id }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (!receive(result, true)) { setError('A newer sampling state is already displayed. Refresh the review to load its details.'); return; }
      // An unchanged read cannot establish whether a timed-out mutation is still in flight.
      if (uncertain && (result.record.revision > uncertain.record.revision || !isLive(result)
        || result.record.sampling?.generationOperationId !== uncertain.record.sampling?.generationOperationId
        || result.generation?.cancelRequested && !uncertain.generation?.cancelRequested
        || result.generation?.phase === 'terminal' && uncertain.generation?.phase !== 'terminal')) setUncertain(undefined);
    } catch {
      if (alive.current && !controller.signal.aborted) setError('The sampling details could not be loaded. Check the original connection and refresh the review.');
    } finally {
      if (reader.current === controller) reader.current = null;
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  };
  const mutate = async (action: () => Promise<McpInteractionView>) => {
    if (sending.current) return;
    sending.current = true; reader.current?.abort(); reader.current = null; setLoading(false); setBusy(true); setError(undefined);
    try {
      const result = await action();
      if (alive.current) {
        if (!receive(result, expanded)) setError('A newer sampling state is already displayed. Refresh the review to load its details.');
        setUncertain(undefined);
      }
    } catch (failure) {
      if (alive.current) { setError(errorText(failure)); if (!rejectedRequest(failure)) setUncertain(view); }
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const requestChoice = (action: 'decline' | 'cancel') => {
    if (!ready || review !== 'request') return;
    void mutate(() => api.reviewMcpSamplingRequest({ ...identity, operationId: record.binding.operationId, interactionId: record.id, expectedRevision: record.revision, action }));
  };
  const generate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!requestReady || !expanded || !currentDetail || !selected || draft === undefined) return;
    let editedRequest: unknown;
    try { editedRequest = JSON.parse(draft); } catch { setError('Enter valid JSON for the reviewed request.'); return; }
    if (editedRequest === null || typeof editedRequest !== 'object' || Array.isArray(editedRequest)) { setError('The reviewed request must be a JSON object.'); return; }
    // Only JSON shape is checked here. The original owner validates all parameter semantics.
    void mutate(() => api.reviewMcpSamplingRequest({ ...identity, operationId: record.binding.operationId, interactionId: record.id,
      expectedRevision: record.revision, action: 'generate', model: selected, editedRequest: editedRequest as Record<string, unknown> }));
  };
  const outputChoice = (action: McpSamplingOutputAction) => {
    if (!ready || review !== 'output' || action === 'accept' && !outputReady) return;
    void mutate(() => api.reviewMcpSamplingOutput({ ...identity, operationId: record.binding.operationId, interactionId: record.id, expectedRevision: record.revision, action }));
  };
  const stop = async () => {
    if (sending.current || uncertain || !generating || generation.cancelRequested || stopRequested === generation.operationId) return;
    sending.current = true; setBusy(true); setError(undefined);
    reader.current?.abort(); reader.current = null; setLoading(false);
    try {
      const receipt = await api.cancelOperation(generation.operationId);
      if (alive.current) {
        if (receipt.id === generation.operationId && (receipt.cancel_requested || receipt.phase === 'terminal')) setStopRequested(generation.operationId);
        else { setUncertain(view); setError('The generation stop could not be confirmed. Refresh the review before taking another action.'); }
      }
    } catch (failure) { if (alive.current) { setUncertain(view); setError(errorText(failure)); } }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const toggle = () => {
    if (expanded) { reader.current?.abort(); reader.current = null; setLoading(false); setExpanded(false); }
    else void refresh();
  };
  const delivery = record.delivery === null ? 'No server delivery recorded' : {
    not_started: 'Response not sent', sending: 'Response delivery started', sent: 'Response transport confirmed',
    unknown: 'Response delivery unconfirmed', not_sent: 'Response was not sent',
  }[record.delivery];
  const availability = {
    live: 'Original request is live', cancelled: 'Server cancelled this request', connection_lost: 'Original connection was lost',
    owner_unavailable: 'Original connection or account unavailable', rpc_closed: 'Original request channel closed',
  }[record.availability];
  return <article aria-label={`MCP sampling request ${record.id}`} className="space-y-3 rounded border p-3 text-sm">
    <div className="space-y-1">
      <p className="font-medium">MCP sampling · {record.binding.endpoint.server}</p>
      <p className="break-all text-xs text-muted-foreground">Original operation {record.binding.operationId}</p>
      <p className="whitespace-pre-wrap">{presentation.message}</p>
      <p className="text-xs">Review the request and choose a model before generation. Sending the generated result to this server requires a separate review.</p>
      <p className="text-xs text-muted-foreground">{availability} · {record.choice ? `Your choice: ${record.choice}` : 'No server response chosen'} · {delivery}</p>
      {record.problem && <p role="status" className="text-xs">{diagnostic(record.problem) ?? 'The original server request needs attention. Its delivery status is shown separately from model generation.'}</p>}
    </div>
    {generation && <section aria-label="Sampling generation status" className="space-y-1 text-xs">
      <p>Generation operation {generation.operationId} · {generation.phase}{generation.outcome && ` · ${generation.outcome}`}</p>
      <p>Provider dispatch: {generation.dispatch}</p>
      {generation.model ? <p>Actual model: {generation.model.providerId ?? generation.model.providerFamily} / {generation.model.model} · maxTokens: {generation.model.maxTokens}</p>
        : <p>Actual model is not recorded yet.</p>}
      <p>Usage: {generation.usage.measurement} · Input: {generation.usage.inputTokens ?? 'unavailable'} · Output: {generation.usage.outputTokens ?? 'unavailable'} · Cached input: {generation.usage.cachedInputTokens ?? 'unavailable'}</p>
      {generation.cancelRequested && <p role="status">Generation stop requested. Provider completion and server delivery remain separate facts.</p>}
      {!generation.cancelRequested && stopRequested === generation.operationId && <p role="status">Generation stop control acknowledged. Refresh the review to check the recorded lifecycle; server delivery is separate.</p>}
      {generation.problem && <p role="status">{diagnostic(generation.problem) ?? 'Generation needs attention. Review the retained details; no automatic retry will run.'}</p>}
      {generating && <Button type="button" size="sm" variant="outline" disabled={busy || !!uncertain || generation.cancelRequested || stopRequested === generation.operationId} onClick={() => void stop()}>Stop generation</Button>}
    </section>}
    <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} disabled={!expanded && busy} onClick={toggle}>
      {expanded ? 'Hide sampling details' : review === 'output' ? 'Review generated output' : 'Review sampling request'}
    </Button>
    {expanded && <section aria-label="Sampling review details" className="space-y-3">
      {loading && <p role="status">Loading sampling details…</p>}
      {currentDetail ? <>
        <p className="font-medium">Original server request</p>
        <pre aria-label="Original sampling request" className="whitespace-pre-wrap break-all text-xs">{json(currentDetail.request)}</pre>
        {review === 'request' && canGenerate && <form noValidate aria-label="Review sampling generation" onSubmit={generate} className="space-y-2">
          <label className="block">Reviewed request JSON
            <Textarea aria-label="Reviewed sampling request JSON" rows={12} spellCheck={false} className="w-full rounded border bg-transparent p-2 font-mono text-xs"
              disabled={!requestReady} value={draft ?? ''} onChange={event => setDraft(event.target.value)} />
          </label>
          <p className="text-xs">All original fields are retained for review. The owner checks supported parameters; server model preferences are advisory.</p>
          <label className="block">Model for this generation
            <select aria-label="Sampling model" className="w-full rounded border bg-transparent p-2" disabled={!requestReady} value={selected ? modelKey(selected) : ''}
              onChange={event => { setModelTouched(true); const model = models.find(entry => modelKey(entry) === event.target.value); setChosen(model ? { providerId: model.providerId, modelId: model.modelId,
                ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}), ...(model.temperature !== undefined ? { temperature: model.temperature } : {}) } : undefined); }}>
              <option value="">Choose an available model</option>
              {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.providerId} / {model.name ?? model.modelId} ({model.modelId})</option>)}
            </select>
          </label>
          {selected && <p className="text-xs">Selected model: {selected.providerId} / {selected.modelId} · Thinking: {selected.thinkingLevel ?? 'registered default'} · Temperature: {selected.temperature ?? 'registered default'}</p>}
          {modelError && <p role="status">The model catalog could not be loaded. Refresh the conversation model catalog before generating.</p>}
          {!models.length && !modelError && <p role="status">No available model is listed. Load the conversation model catalog before generating.</p>}
          <Button type="submit" size="sm" disabled={!requestReady || !selected}>Generate for review</Button>
        </form>}
        {currentDetail.sampling?.editedRequest != null && <details><summary>Recorded reviewed request</summary><pre className="whitespace-pre-wrap break-all text-xs">{json(currentDetail.sampling.editedRequest)}</pre></details>}
        {currentDetail.sampling?.output != null && <div className="space-y-2"><p className="font-medium">Generated result for the original server</p>
          <p className="text-xs">Accepting sends this exact result to MCP server: {record.binding.endpoint.server}.</p>
          <pre aria-label="Generated sampling output" className="whitespace-pre-wrap break-all text-xs">{json(currentDetail.sampling.output)}</pre>
          {review === 'output' && <Button type="button" size="sm" disabled={!outputReady} onClick={() => outputChoice('accept')}>Accept and send to server</Button>}
        </div>}
        {currentDetail.sampling && <details><summary>Provider output and generation evidence</summary>
          <pre aria-label="Sampling generation evidence" className="whitespace-pre-wrap break-all text-xs">{json({ providerOutput: currentDetail.sampling.providerOutput, receipt: currentDetail.sampling.receipt, snapshot: currentDetail.sampling.snapshot })}</pre>
        </details>}
      </> : !loading && <p role="status">Refresh the review to load the details for this sampling state.</p>}
      <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => void refresh()}>Refresh sampling review</Button>
    </section>}
    {isLive(view) && review !== 'closed' && <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => review === 'output' ? outputChoice('decline') : requestChoice('decline')}>{review === 'output' ? 'Decline output' : 'Decline request'}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={!ready} onClick={() => review === 'output' ? outputChoice('cancel') : requestChoice('cancel')}>Cancel sampling request</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="status">No action will be retried automatically. Expand or refresh the review to check the original request and generation.</p>}
  </article>;
}
