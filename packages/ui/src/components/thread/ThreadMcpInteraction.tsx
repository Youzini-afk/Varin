import React from 'react';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { ThreadRequestError } from '@varin/application-client';
import type { McpElicitationField, McpElicitationResponse, McpInteractionView } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { openExternalUrl } from '@/lib/url';

type InteractionAPI = Pick<ThreadsAPI, 'listMcpInteractions' | 'readMcpInteraction' | 'respondMcpInteraction'>;
type Value = string | number | boolean | string[];
type Draft = Record<string, { included: boolean; value: Value | undefined }>;
const sameInteraction = (left: McpInteractionView, right: McpInteractionView) => left.record.id === right.record.id && left.record.binding.operationId === right.record.binding.operationId;
const newerInteraction = (retained: McpInteractionView | undefined, incoming: McpInteractionView) => retained && retained.record.revision >= incoming.record.revision ? retained : incoming;
const canRespond = ({ record }: McpInteractionView) => record.availability === 'live' && record.choice === null && record.delivery === 'not_started';
const errorText = (error: unknown): string => {
  if (error instanceof ThreadRequestError) {
    if (error.code === 'mcp_interaction_response_invalid') return 'Check the requested fields and their limits, then send your response again.';
    if (error.status === 409 || error.code === 'mcp_interaction_not_live') return 'This request has changed or closed. Refresh it before taking another action.';
    if (error.code === 'mcp_interaction_owner_unavailable') return 'The original MCP connection is unavailable. Check that connection, then refresh this request.';
    if (error.status === 403) return 'This request does not belong to the selected conversation branch.';
  }
  return 'The response could not be confirmed. Refresh this request or retry the same response.';
};
const initialDraft = (view: McpInteractionView): Draft => {
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

export function ThreadMcpInteraction({ api, identity, view, update }: {
  api: InteractionAPI; identity: ThreadIdentity; view: McpInteractionView; update(view: McpInteractionView): void;
}) {
  const [draft, setDraft] = React.useState(() => initialDraft(view));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [opening, setOpening] = React.useState(false);
  const [openResult, setOpenResult] = React.useState<string>();
  const [uncertain, setUncertain] = React.useState(false);
  const sending = React.useRef(false);
  const attempt = React.useRef<Parameters<InteractionAPI['respondMcpInteraction']>[0] | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { record, presentation } = view;
  const ready = canRespond(view) && !busy && !uncertain;
  const refresh = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(undefined);
    try {
      const result = await api.readMcpInteraction({ ...identity, operationId: record.binding.operationId, interactionId: record.id });
      if (alive.current) { update(result); if (!canRespond(result)) setUncertain(false); }
    } catch { if (alive.current) setError('This request could not be refreshed. Check the original MCP connection and try again.'); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const send = async (response?: McpElicitationResponse) => {
    if (sending.current || response && !ready || !response && !attempt.current) return;
    const input = response ? { ...identity, operationId: record.binding.operationId, interactionId: record.id, expectedRevision: record.revision, response } : attempt.current!;
    attempt.current = input; sending.current = true; setBusy(true); setError(undefined);
    try {
      const result = await api.respondMcpInteraction(input);
      if (alive.current) { update(result); setUncertain(false); }
    } catch (failure) {
      if (alive.current) {
        setError(errorText(failure));
        setUncertain(!(failure instanceof ThreadRequestError && failure.code === 'mcp_interaction_response_invalid'));
      }
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const accept = (event: React.FormEvent) => {
    event.preventDefault();
    if (presentation.mode === 'url') { void send({ action: 'accept' }); return; }
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
  const availability = { live: 'Original request is live', cancelled: 'Server cancelled this request', connection_lost: 'Original connection was lost', owner_unavailable: 'Original connection or account unavailable', rpc_closed: 'Original request channel closed' }[record.availability];
  const delivery = { not_started: 'Response not sent', sending: 'Response delivery started', sent: 'Response transport confirmed', unknown: 'Response delivery unconfirmed', not_sent: 'Response was not sent' }[record.delivery];
  return <article aria-label={`MCP request ${record.id}`} className="space-y-2 rounded border p-3 text-sm">
    <p className="font-medium">MCP server: {record.binding.endpoint.server}</p>
    <p className="break-all text-xs text-muted-foreground">Operation {record.binding.operationId}{record.binding.relation.kind === 'task' && ` · Remote task ${record.binding.relation.taskId}`}</p>
    <p className="whitespace-pre-wrap">{presentation.message}</p>
    <p className="text-xs text-muted-foreground">{availability} · {record.choice ? `Your choice: ${record.choice}` : 'No response chosen'} · {delivery}</p>
    {record.problem && <p role="status" className="text-xs">The original request needs attention. Check its connection and refresh; the request and any response are retained.</p>}
    {/* HTML required/pattern rules differ from JSON Schema (an empty required string can be valid). */}
    <form noValidate aria-label={`Respond to MCP request ${record.id}`} onSubmit={accept} className="space-y-3">
      {presentation.mode === 'form' ? presentation.fields.map(field => <Field key={field.name} field={field} draft={draft[field.name]!} disabled={!ready}
        change={entry => setDraft(current => ({ ...current, [field.name]: entry }))} />)
        : <div className="space-y-2">
          <p className="text-xs">Website host: {new URL(presentation.url).host}</p>
          <p className="break-all whitespace-pre-wrap">{presentation.url}</p>
          <Button type="button" variant="outline" size="sm" disabled={opening || !(record.choice === 'accept' || record.choice === null && record.availability === 'live')} onClick={() => void open()}>Open website</Button>
          {openResult && <p role="status" className="text-xs">{openResult}</p>}
          <p className="text-xs">{record.completionReported ? 'The server reported this external interaction complete.' : 'The server has not reported external completion.'}</p>
        </div>}
      {record.choice === null && <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>Accept</Button>
        <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={() => void send({ action: 'decline' })}>Decline</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!ready} onClick={() => void send({ action: 'cancel' })}>Cancel request</Button>
      </div>}
    </form>
    {view.response && <details><summary>Your recorded response</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(view.response, null, 2)}</pre></details>}
    {error && <p role="alert">{error}</p>}
    {uncertain && canRespond(view) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void send()}>Retry same response</Button>}
    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh request</Button>
  </article>;
}

/** A bounded page independent of active Operations. Opening or closing this view never cancels a server request. */
export function ThreadMcpInteractions({ api, identity, eventCursor }: { api: InteractionAPI; identity: ThreadIdentity; eventCursor: number }) {
  const [items, setItems] = React.useState<McpInteractionView[]>([]);
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
          return newerInteraction(retained, item);
        }));
        setNextCursor(page.nextCursor);
      }
    }, () => { if (!controller.signal.aborted) setError('MCP requests could not be loaded. Refresh to try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, identity, cursor, eventCursor, refresh]);
  const update = (view: McpInteractionView) => setItems(current => current.map(item => sameInteraction(item, view) ? newerInteraction(item, view) : item));
  const waiting = items.filter(canRespond);
  const history = items.filter(item => !canRespond(item));
  return <section aria-label="MCP server requests" className="mx-auto max-w-3xl space-y-2">
    <div className="flex items-center gap-2"><h3 className="text-sm font-medium">MCP server requests</h3>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh MCP requests</Button></div>
    {error && <p role="alert">{error}</p>}
    {!loading && !error && items.length === 0 && <p className="text-xs text-muted-foreground">No MCP requests on this page.</p>}
    {waiting.length > 0 && <p className="text-xs font-medium">Awaiting your response</p>}
    {waiting.map(view => <ThreadMcpInteraction key={`${view.record.binding.operationId}:${view.record.id}`} api={api} identity={identity} view={view} update={update} />)}
    {history.length > 0 && <p className="text-xs font-medium">Answered or closed requests</p>}
    {history.map(view => <ThreadMcpInteraction key={`${view.record.binding.operationId}:${view.record.id}`} api={api} identity={identity} view={view} update={update} />)}
    <div className="flex gap-2">
      {cursor && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => { setItems([]); setCursor(undefined); }}>Latest requests</Button>}
      {nextCursor && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => { setItems([]); setCursor(nextCursor); }}>More requests</Button>}
    </div>
  </section>;
}
