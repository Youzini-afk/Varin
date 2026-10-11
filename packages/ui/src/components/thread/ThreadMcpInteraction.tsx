import React from 'react';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadsAPI } from '@varin/application-client';
import { ThreadRequestError } from '@varin/application-client';
import type { McpElicitationField, McpElicitationResponse, McpInteractionItem } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { openExternalUrl } from '@/lib/url';
import { ThreadMcpSampling } from './ThreadMcpSampling';

type InteractionAPI = Pick<ThreadsAPI, 'listMcpInteractions' | 'readMcpInteraction' | 'respondMcpInteraction' | 'reviewMcpSamplingRequest' | 'reviewMcpSamplingOutput' | 'cancelOperation'>;
type Value = string | number | boolean | string[];
type Draft = Record<string, { included: boolean; value: Value | undefined }>;
const sameInteraction = (left: McpInteractionItem, right: McpInteractionItem) => left.record.id === right.record.id && left.record.binding.operationId === right.record.binding.operationId;
const newerInteraction = (retained: McpInteractionItem | undefined, incoming: McpInteractionItem) => retained && retained.record.revision >= incoming.record.revision ? retained : incoming;
const compactInteraction = ({ record, presentation, response, generation }: McpInteractionItem): McpInteractionItem => ({ record, presentation, response, ...(generation ? { generation } : {}) });
const canRespond = ({ record }: McpInteractionItem) => record.choice === null && (record.binding.source.kind === 'rpc_error'
  ? record.delivery === null : record.availability === 'live' && record.delivery === 'not_started');
const errorText = (error: unknown, localChoice: boolean): string => {
  if (error instanceof ThreadRequestError) {
    if (error.code === 'mcp_interaction_response_invalid') return localChoice ? 'This local choice was rejected. Refresh and try again.' : 'Check the requested fields and their limits, then send your response again.';
    if (error.status === 409 || error.code === 'mcp_interaction_not_live') return 'This request has changed or closed. Refresh it before taking another action.';
    if (error.code === 'mcp_interaction_owner_unavailable') return localChoice ? 'This local choice could not be saved. Refresh and try again.' : 'The original MCP connection is unavailable. Check that connection, then refresh this request.';
    if (error.status === 403) return 'This request does not belong to the selected conversation branch.';
  }
  return localChoice ? 'Your local choice could not be confirmed. Refresh this interaction or retry the same choice.'
    : 'The response could not be confirmed. Refresh this request or retry the same response.';
};
const initialDraft = (view: McpInteractionItem): Draft => {
  if (view.presentation.mode !== 'form') return {};
  const recorded = view.response?.action === 'accept' ? view.response.content : undefined;
  return Object.fromEntries(view.presentation.fields.map(field => {
    const value = recorded ? Object.hasOwn(recorded, field.name) ? recorded[field.name] : undefined : field.default;
    return [field.name, { included: recorded ? Object.hasOwn(recorded, field.name) : field.required || field.default !== undefined,
      value: Array.isArray(value) ? [...value] : value }];
  }));
};

/** Presentation of normalized owner fields only. The original owner validates the saved schema. */
function Field({ field, draft, disabled, change }: { field: McpElicitationField; draft: Draft[string]; disabled: boolean; change(value: Draft[string]): void }) {
  const id = React.useId();
  const set = (value: Value | undefined) => change({ ...draft, value });
  const inactive = disabled || !draft.included;
  const shared = { id, disabled: inactive, required: field.required, 'aria-label': field.title,
    'aria-describedby': `${id}-description`, className: 'w-full rounded border bg-transparent p-2 text-sm' };
  return <div className="space-y-1">
    <div className="flex items-center gap-2">
      {!field.required && <input type="checkbox" aria-label={`Include ${field.title}`} checked={draft.included} disabled={disabled}
        onChange={event => change({ ...draft, included: event.target.checked })} />}
      <label htmlFor={id}>{field.title}{field.required ? ' (required)' : ' (optional)'}</label>
    </div>
    {field.kind === 'boolean' ? <select {...shared} value={draft.value === undefined ? '' : String(draft.value)} onChange={event => set(event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">Choose a value</option><option value="true">Yes</option><option value="false">No</option>
    </select> : field.kind === 'enum' ? <select {...shared} value={draft.value === undefined ? '' : String(field.options?.findIndex(option => option.value === draft.value))} onChange={event => set(field.options?.[Number(event.target.value)]?.value)}>
      <option value="" disabled>Choose a value</option>{field.options?.map((option, index) => <option key={option.value} value={index}>{option.title}</option>)}
    </select> : field.kind === 'multi_enum' ? <div role="group" aria-label={field.title}>
      {field.options?.map(option => <label key={option.value} className="mr-3 inline-flex items-center gap-1">
        <input type="checkbox" disabled={inactive} checked={Array.isArray(draft.value) && draft.value.includes(option.value)}
          onChange={event => { const values = Array.isArray(draft.value) ? draft.value : []; set(event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value)); }} />{option.title}
      </label>)}
    </div> : field.kind === 'number' || field.kind === 'integer' ? <input {...shared} type="number" step={field.kind === 'integer' ? 1 : 'any'}
      min={field.minimum} max={field.maximum} value={draft.value === undefined ? '' : String(draft.value)} onChange={event => set(event.target.value)} />
      : <input {...shared} type="text" inputMode={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
        minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern} value={draft.value === undefined ? '' : String(draft.value)} onChange={event => set(event.target.value)} />}
    <p id={`${id}-description`} className="whitespace-pre-wrap text-xs text-muted-foreground">{field.description}
      {field.pattern && ` Pattern: ${field.pattern}.`}{field.format && ` Format: ${field.format}.`}{field.minimum !== undefined && ` Minimum: ${field.minimum}.`}{field.maximum !== undefined && ` Maximum: ${field.maximum}.`}
      {field.minLength !== undefined && ` Minimum length: ${field.minLength}.`}{field.maxLength !== undefined && ` Maximum length: ${field.maxLength}.`}
      {field.minItems !== undefined && ` Select at least ${field.minItems}.`}{field.maxItems !== undefined && ` Select at most ${field.maxItems}.`}</p>
  </div>;
}

function ThreadMcpElicitation({ api, identity, view, update }: {
  api: InteractionAPI; identity: ThreadIdentity; view: McpInteractionItem; update(view: McpInteractionItem): void;
}) {
  const [draft, setDraft] = React.useState(() => initialDraft(view));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [opening, setOpening] = React.useState(false);
  const [openResult, setOpenResult] = React.useState<string>();
  const [uncertain, setUncertain] = React.useState(false);
  const [evidence, setEvidence] = React.useState<Record<string, unknown>>();
  const [showEvidence, setShowEvidence] = React.useState(false);
  const sending = React.useRef(false);
  const attempt = React.useRef<Parameters<InteractionAPI['respondMcpInteraction']>[0] | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { record, presentation } = view;
  const source = record.binding.source;
  const errorSource = source.kind === 'rpc_error';
  const taskId = source.kind === 'rpc_error' ? source.taskId : source.relation.kind === 'task' ? source.relation.taskId : undefined;
  const ready = canRespond(view) && !busy && !uncertain;
  const refresh = async (inspect = false) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(undefined);
    try {
      const result = await api.readMcpInteraction({ ...identity, operationId: record.binding.operationId, interactionId: record.id });
      if (alive.current) {
        update(compactInteraction(result));
        if (inspect || showEvidence) { setEvidence(result.request); setShowEvidence(true); }
        if (!canRespond(result)) setUncertain(false);
      }
    } catch { if (alive.current) setError('This request could not be refreshed. Check the original MCP connection and try again.'); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const send = async (response?: McpElicitationResponse) => {
    if (sending.current || response && !ready || !response && !attempt.current) return;
    const input = response ? { ...identity, operationId: record.binding.operationId, interactionId: record.id, expectedRevision: record.revision, response } : attempt.current!;
    attempt.current = input; sending.current = true; setBusy(true); setError(undefined);
    try {
      const result = await api.respondMcpInteraction(input);
      if (alive.current) { update(compactInteraction(result)); setUncertain(false); }
    } catch (failure) {
      if (alive.current) {
        setError(errorText(failure, errorSource));
        setUncertain(!(failure instanceof ThreadRequestError && failure.code === 'mcp_interaction_response_invalid'));
      }
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const accept = (event: React.FormEvent) => {
    event.preventDefault();
    if (presentation.mode !== 'form') { if (presentation.mode === 'url') void send({ action: 'accept' }); return; }
    const content: Record<string, Value> = Object.create(null);
    for (const field of presentation.fields) {
      const entry = draft[field.name];
      if (!entry?.included) continue;
      if (field.kind === 'string') content[field.name] = entry.value === undefined ? '' : entry.value;
      else if (field.kind === 'multi_enum') content[field.name] = entry.value === undefined ? [] : entry.value;
      else if (field.kind === 'number' || field.kind === 'integer') {
        if (entry.value !== undefined && entry.value !== '') content[field.name] = Number(entry.value);
      } else if (entry.value !== undefined) content[field.name] = entry.value;
    }
    void send({ action: 'accept', content });
  };
  const open = async () => {
    if (presentation.mode !== 'url' || opening) return;
    setOpening(true); setOpenResult(undefined);
    try {
      // Called directly in the click handler, before any awaited network work.
      const opened = await openExternalUrl(presentation.url);
      if (alive.current) setOpenResult(opened ? 'The browser was asked to open this URL. External completion is still reported separately by the server.'
        : 'Opening this URL could not be confirmed. Check your browser and popup settings, or copy the exact URL above.');
    } catch { if (alive.current) setOpenResult('The browser could not open this URL. Copy the exact URL above to open it yourself.'); }
    finally { if (alive.current) setOpening(false); }
  };
  const availability = errorSource
    ? record.completionReported ? 'Server completion is recorded' : { live: 'External completion tracking is active', cancelled: 'External completion tracking was cancelled', connection_lost: 'Original connection was lost', owner_unavailable: 'External completion tracking is unavailable', rpc_closed: 'Original request channel closed' }[record.availability]
    : { live: 'Original request is live', cancelled: 'Server cancelled this request', connection_lost: 'Original connection was lost', owner_unavailable: 'Original connection or account unavailable', rpc_closed: 'Original request channel closed' }[record.availability];
  const delivery = record.delivery === null ? 'No MCP response applies'
    : { not_started: 'Response not sent', sending: 'Response delivery started', sent: 'Response transport confirmed', unknown: 'Response delivery unconfirmed', not_sent: 'Response was not sent' }[record.delivery];
  return <article aria-label={`MCP request ${record.id}`} className="space-y-2 rounded border p-3 text-sm">
    <p className="font-medium">MCP server: {record.binding.endpoint.server}</p>
    <p className="break-all text-xs text-muted-foreground">Operation {record.binding.operationId}{taskId && ` · Remote task ${taskId}`}</p>
    {source.kind === 'rpc_error' && <div className="space-y-1 text-xs">
      <p>The original RPC {source.method} (request {String(source.outgoingRequestId)}) ended with error -32042. Its result remains that error; any external effects are not established by this card.</p>
      <p>Your choice is saved locally. No MCP response is sent. Opening or completing the website does not retry the call, restart its Run, or grant the Agent permission.</p>
    </div>}
    <p className="whitespace-pre-wrap">{presentation.message}</p>
    <p className="text-xs text-muted-foreground">{availability} · {record.choice ? `${errorSource ? 'Local choice' : 'Your choice'}: ${record.choice}` : errorSource ? 'No local choice recorded' : 'No response chosen'} · {delivery}</p>
    {record.problem && <p role="status" className="text-xs">{errorSource
      ? 'External completion tracking needs attention. The original error and any local choice are retained.'
      : 'The original request needs attention. Check its connection and refresh; the request and any response are retained.'}</p>}
    {/* HTML required/pattern rules differ from JSON Schema (an empty required string can be valid). */}
    <form noValidate aria-label={`${errorSource ? 'Record choice for MCP interaction' : 'Respond to MCP request'} ${record.id}`} onSubmit={accept} className="space-y-3">
      {presentation.mode === 'form' ? presentation.fields.map(field => <Field key={field.name} field={field} draft={draft[field.name]!} disabled={!ready}
        change={entry => setDraft(current => ({ ...current, [field.name]: entry }))} />)
        : presentation.mode === 'url' && <div className="space-y-2">
          <p className="text-xs">Website host: {new URL(presentation.url).host}</p>
          <p className="break-all whitespace-pre-wrap">{presentation.url}</p>
          <Button type="button" variant="outline" size="sm" disabled={opening || !(errorSource || record.choice === 'accept' || record.choice === null && record.availability === 'live')} onClick={() => void open()}>Open website</Button>
          {openResult && <p role="status" className="text-xs">{openResult}</p>}
          <p className="text-xs">{record.completionReported ? 'The server reported this external interaction complete.' : 'The server has not reported external completion.'}</p>
        </div>}
      {record.choice === null && <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>{errorSource ? 'Accept locally' : 'Accept'}</Button>
        <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={() => void send({ action: 'decline' })}>{errorSource ? 'Decline locally' : 'Decline'}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!ready} onClick={() => void send({ action: 'cancel' })}>{errorSource ? 'Cancel locally' : 'Cancel request'}</Button>
      </div>}
    </form>
    {view.response && <details><summary>{errorSource ? 'Your recorded local choice' : 'Your recorded response'}</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(view.response, null, 2)}</pre></details>}
    {error && <p role="alert">{error}</p>}
    {uncertain && canRespond(view) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void send()}>{errorSource ? 'Retry same local choice' : 'Retry same response'}</Button>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh request</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} aria-expanded={showEvidence}
        onClick={() => showEvidence ? setShowEvidence(false) : evidence ? setShowEvidence(true) : void refresh(true)}>
        {showEvidence ? 'Hide original evidence' : errorSource ? 'Show original RPC error' : 'Show original server request'}
      </Button>
    </div>
    {showEvidence && evidence && <pre aria-label="Original MCP evidence" className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(evidence, null, 2)}</pre>}
  </article>;
}

export function ThreadMcpInteraction({ api, identity, view, update, models = [], selectedModel, modelError }: {
  api: InteractionAPI; identity: ThreadIdentity; view: McpInteractionItem; update(view: McpInteractionItem): void;
  models?: ThreadModelInfo[]; selectedModel?: ThreadModel; modelError?: string;
}) {
  return view.record.mode === 'sampling' || view.presentation.mode === 'sampling'
    ? <ThreadMcpSampling api={api} identity={identity} view={view} update={update} models={models} selectedModel={selectedModel} modelError={modelError} />
    : <ThreadMcpElicitation api={api} identity={identity} view={view} update={update} />;
}

/** A bounded page independent of active Operations. Opening or closing this view never cancels a server request. */
export function ThreadMcpInteractions({ api, identity, eventCursor, models, selectedModel, modelError }: {
  api: InteractionAPI; identity: ThreadIdentity; eventCursor: number; models?: ThreadModelInfo[]; selectedModel?: ThreadModel; modelError?: string;
}) {
  const [items, setItems] = React.useState<McpInteractionItem[]>([]);
  const [cursor, setCursor] = React.useState<string>();
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void api.listMcpInteractions({ ...identity, ...(cursor ? { cursor } : {}), limit: 20 }, controller.signal).then(page => {
      if (!controller.signal.aborted) {
        setItems(current => page.items.map(item => {
          const retained = current.find(value => sameInteraction(value, item));
          return newerInteraction(retained, compactInteraction(item));
        }));
        setNextCursor(page.nextCursor);
      }
    }, () => { if (!controller.signal.aborted) setError('MCP requests could not be loaded. Refresh to try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, identity, cursor, eventCursor, refresh]);
  const update = (view: McpInteractionItem) => setItems(current => current.map(item => sameInteraction(item, view) ? newerInteraction(item, compactInteraction(view)) : item));
  const waiting = items.filter(canRespond);
  const history = items.filter(item => !canRespond(item));
  return <section aria-label="MCP server requests" className="mx-auto max-w-3xl space-y-2">
    <div className="flex items-center gap-2"><h3 className="text-sm font-medium">MCP server requests</h3>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh MCP requests</Button></div>
    {error && <p role="alert">{error}</p>}
    {!loading && !error && items.length === 0 && <p className="text-xs text-muted-foreground">No MCP requests on this page.</p>}
    {waiting.length > 0 && <p className="text-xs font-medium">Awaiting your choice</p>}
    {waiting.map(view => <ThreadMcpInteraction key={`${view.record.binding.operationId}:${view.record.id}`} api={api} identity={identity} view={view} update={update} models={models} selectedModel={selectedModel} modelError={modelError} />)}
    {history.length > 0 && <p className="text-xs font-medium">Answered or closed requests</p>}
    {history.map(view => <ThreadMcpInteraction key={`${view.record.binding.operationId}:${view.record.id}`} api={api} identity={identity} view={view} update={update} models={models} selectedModel={selectedModel} modelError={modelError} />)}
    <div className="flex gap-2">
      {cursor && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => { setItems([]); setCursor(undefined); }}>Latest requests</Button>}
      {nextCursor && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => { setItems([]); setCursor(nextCursor); }}>More requests</Button>}
    </div>
  </section>;
}
