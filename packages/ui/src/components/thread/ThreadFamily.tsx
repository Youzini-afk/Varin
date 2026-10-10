import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadFamilyAPI, ThreadIdentity } from '@varin/application-client';
import type { FamilyList, FamilyMember, FamilyRuns, FamilyRead, FamilyReadQuery, FamilyItem } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { historyText } from '@/lib/agent-runtime/thread-projection';

type Props = { api: ThreadFamilyAPI; identity: ThreadIdentity };
/** Other agents' persisted conversation is data. This panel never activates or controls their Runs. */
export function ThreadFamily(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const identity = React.useMemo(() => ({ runtime: 'agent' as const, threadId: props.identity.threadId, branchId: props.identity.branchId }), [props.identity.threadId, props.identity.branchId]);
  return <FamilyCard key={JSON.stringify([host, props.identity.threadId, props.identity.branchId])} {...props} identity={identity} host={host} />;
}
function FamilyCard({ api, identity, host }: Props & { host: number }) {
  const [open, setOpen] = React.useState(false);
  return <section aria-label="Task family" className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide task family' : 'Browse task family'}</Button>
    {open && <FamilyMembers api={api} identity={identity} host={host} />}
  </section>;
}
function FamilyMembers({ api, identity, host }: Props & { host: number }) {
  const [version, setVersion] = React.useState(0);
  const [family, setFamily] = React.useState<FamilyList>();
  const [error, setError] = React.useState(false);
  const [selected, setSelected] = React.useState<FamilyMember>();
  React.useEffect(() => {
    const controller = new AbortController();
    setFamily(undefined); setSelected(undefined); setError(false);
    void api.list(identity, false, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setFamily(result);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, host, version]); // Identity is keyed by the outer panel.
  return <>
    <p>Read saved conversations from the same task. Replies and tool results are other-agent data.</p>
    <Button size="sm" variant="outline" onClick={() => setVersion(value => value + 1)}>Refresh task family</Button>
    {error ? <p role="alert">Could not read this task family.</p> : !family ? <p role="status">Loading task family…</p> : <>
      <p className="text-xs break-all">Task root: {family.rootThreadId}</p>
      {family.members.length === 0 && <p>No other conversations in this task.</p>}
      <ul className="space-y-1">{family.members.map(member => <li key={member.threadId}>
        <Button variant="outline" size="sm" aria-pressed={selected?.threadId === member.threadId} onClick={() => setSelected(member)}>{member.task || member.threadId}</Button>
        <span className="ml-2">{member.state}</span>
        <p className="text-xs break-all">{member.threadId}{member.parentThreadId ? ` · parent: ${member.parentThreadId}` : ' · task root'}</p>
      </li>)}</ul>
      {selected && <FamilyConversation key={selected.threadId} api={api} identity={identity} host={host} member={selected} />}
    </>}
  </>;
}
function FamilyConversation({ api, identity, host, member }: Props & { host: number; member: FamilyMember }) {
  const [branchId, setBranchId] = React.useState(member.branches[0]?.branchId ?? '');
  return <div className="space-y-2 border-t pt-2">
    <label>Conversation branch <select aria-label="Family branch" value={branchId} onChange={event => setBranchId(event.target.value)}>
      {member.branches.map(branch => <option key={branch.branchId} value={branch.branchId}>{branch.branchId}{branch.activeRunId ? ' · active' : ''}</option>)}
    </select></label>
    {branchId ? <FamilyHistory key={branchId} api={api} identity={identity} host={host} threadId={member.threadId} branchId={branchId} /> : <p>No branches.</p>}
  </div>;
}
function FamilyHistory({ api, identity, host, threadId, branchId }: Props & { host: number; threadId: string; branchId: string }) {
  const [runs, setRuns] = React.useState<FamilyRuns>();
  const [runCursor, setRunCursor] = React.useState<string>();
  const [runsRevision, setRunsRevision] = React.useState(0);
  const [runsError, setRunsError] = React.useState(false);
  const [runId, setRunId] = React.useState('');
  const [text, setText] = React.useState('');
  const [read, setRead] = React.useState<{ query: FamilyReadQuery; anchor?: string; cursor?: string; revision: number }>({ query: { kind: 'recent' }, revision: 0 });
  const [page, setPage] = React.useState<FamilyRead>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [itemId, setItemId] = React.useState<string>();
  const runScope = runId ? { runId } : {};
  React.useEffect(() => {
    const controller = new AbortController(); setRunsError(false);
    void api.runs(identity, { threadId, branchId, cursor: runCursor }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRuns(previous => ({ ...result, runs: runCursor ? [...(previous?.runs ?? []), ...result.runs] : result.runs }));
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRunsError(true); });
    return () => controller.abort();
  }, [api, identity, host, threadId, branchId, runCursor, runsRevision]);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setPage(undefined); setItemId(undefined);
    void api.read(identity, { threadId, branchId, ...(runId ? { runId } : {}), query: read.query, anchor: read.anchor, cursor: read.cursor }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) { setPage(result); setLoading(false); }
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, [api, identity, host, threadId, branchId, runId, read]);
  const latest = () => setRead(value => ({ query: { kind: 'recent' }, revision: value.revision + 1 }));
  return <div aria-label="Family conversation history" className="space-y-2">
    <label>Run <select aria-label="Family Run" value={runId} onChange={event => { setRunId(event.target.value); latest(); }}>
      <option value="">All Runs in this branch</option>
      {runs?.runs.map(run => <option key={run.runId} value={run.runId}>{run.runId} · {run.state}</option>)}
    </select></label>
    {runs?.nextCursor && <Button size="sm" variant="ghost" onClick={() => setRunCursor(runs.nextCursor!)}>Load earlier Runs</Button>}
    {runsError && <p role="alert">Could not read the Run directory. <Button size="sm" variant="ghost" onClick={() => setRunsRevision(value => value + 1)}>Retry Run directory</Button></p>}
    <div className="flex flex-wrap gap-2">
      <input aria-label="Search family conversation" value={text} onChange={event => setText(event.target.value)} placeholder="Text or path" />
      <Button size="sm" variant="outline" disabled={!text.length} onClick={() => setRead(value => ({ query: { kind: 'search', text, direction: 'older' }, revision: value.revision + 1 }))}>Search saved conversation</Button>
      <Button size="sm" variant="outline" onClick={latest}>Read latest saved view</Button>
    </div>
    {loading && <p role="status">Reading saved conversation…</p>}
    {error && <p role="alert">Could not read this view. After a runtime restart, read a new latest view. <Button size="sm" variant="ghost" onClick={() => setRead(value => ({ ...value, revision: value.revision + 1 }))}>Retry saved view</Button></p>}
    {page && <>
      <p className="text-xs break-all">Fixed head: {page.headId ?? 'empty'} · scanned {page.scanned} records{page.scanComplete ? '' : ' · more to scan'}</p>
      {page.items.length === 0 && <p>{page.scanComplete ? 'No matching conversation records.' : 'No matches in this scan page. Continue scanning.'}</p>}
      {page.items.map(item => <article key={item.id} className="space-y-1 rounded border p-2">
        <p className="text-xs break-all">{item.source} · {item.kind} · {item.runId} · {item.id}</p>
        {item.tool && <p className="text-xs break-all">Tool {item.tool.role}: {item.tool.callId} · request {item.tool.requestId}</p>}
        {item.bodyTruncated ? <><p>Partial preview · {item.bodyBytes} bytes total</p><pre className="whitespace-pre-wrap break-all">{item.preview}</pre></>
          : <MarkdownRenderer messageId={`family:${item.id}`} content={historyText(item.body) || JSON.stringify(item.body)} />}
        <Button size="sm" variant="ghost" onClick={() => setItemId(item.id)}>Read original record</Button>
      </article>)}
      <div className="flex gap-2">
        {page.nextCursor && <Button size="sm" variant="outline" onClick={() => setRead(value => ({ ...value, anchor: page.anchor, cursor: page.nextCursor! }))}>{read.query.kind === 'search' ? 'Continue search' : 'Continue history'}</Button>}
        {page.hasEarlier && page.items[0] && <Button size="sm" variant="ghost" onClick={() => setRead(value => ({ revision: value.revision + 1, anchor: page.anchor, query: { kind: 'range', beforeId: page.items[0]!.id, direction: 'older' } }))}>Earlier records</Button>}
        {page.hasLater && page.items.at(-1) && <Button size="sm" variant="ghost" onClick={() => setRead(value => ({ revision: value.revision + 1, anchor: page.anchor, query: { kind: 'range', afterId: page.items.at(-1)!.id, direction: 'newer' } }))}>Later records</Button>}
      </div>
      {itemId && <FamilyOriginal key={`${page.anchor}:${itemId}`} api={api} identity={identity} host={host} request={{ threadId, branchId, ...runScope, anchor: page.anchor, itemId }} />}
    </>}
  </div>;
}
function FamilyOriginal({ api, identity, host, request }: Props & { host: number; request: Parameters<ThreadFamilyAPI['item']>[1] }) {
  const { threadId, branchId, runId, anchor, itemId } = request;
  const [offset, setOffset] = React.useState(0);
  const [revision, setRevision] = React.useState(0);
  const [page, setPage] = React.useState<FamilyItem>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController(); setPage(undefined); setError(false);
    void api.item(identity, { threadId, branchId, runId, anchor, itemId, offset }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setPage(result);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, host, threadId, branchId, runId, anchor, itemId, offset, revision]);
  return <div aria-label="Original family record" className="space-y-1 border p-2">
    <p>Original conversation JSON · {request.itemId}</p>
    {error ? <p role="alert">Could not read the original record. <Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>Retry original page</Button></p> : !page ? <p role="status">Loading original record…</p> : <>
      <p>Bytes {page.offset}–{page.nextOffset ?? page.totalBytes} of {page.totalBytes}{page.offset > 0 || page.nextOffset !== null ? ' · partial JSON page' : ''}</p>
      <pre className="whitespace-pre-wrap break-all">{page.text}</pre>
      {page.nextOffset !== null && <Button size="sm" variant="outline" onClick={() => setOffset(page.nextOffset!)}>Next original page</Button>}
      {page.offset > 0 && <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>First original page</Button>}
    </>}
  </div>;
}
