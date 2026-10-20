import { useI18n } from '@/lib/i18n';
import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadFamilyAPI, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import type { FamilyList, FamilyMember, FamilyRuns, FamilyRead, FamilyReadQuery, FamilyItem } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { ThreadContent } from './ThreadContent';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { ChildState } from '../conversation/childPresentation';
import { AgentAvatar } from '@/components/ui/AgentAvatar';

type Props = { api: ThreadFamilyAPI; mediaRead: ThreadsAPI['mediaRead']; identity: ThreadIdentity; observe?:ThreadsAPI['observe'] };
/** A follow-up's actual bound Run uses the same read-only history and original-record reader. */
export function ThreadRunHistory({ api, mediaRead, identity, runId }: Props & { runId: string }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <FamilyHistory key={JSON.stringify([host, identity.threadId, identity.branchId, runId])}
    api={api} mediaRead={mediaRead} identity={identity} host={host} threadId={identity.threadId} branchId={identity.branchId} fixedRunId={runId} />;
}
/** Other agents' persisted conversation is data. This panel never activates or controls their Runs. */
export function ThreadFamily(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const identity = React.useMemo(() => ({ runtime: 'agent' as const, threadId: props.identity.threadId, branchId: props.identity.branchId }), [props.identity.threadId, props.identity.branchId]);
  return <FamilyCard key={JSON.stringify([host, props.identity.threadId, props.identity.branchId])} {...props} identity={identity} host={host} />;
}
function FamilyCard({ api, mediaRead, identity, host, observe }: Props & { host: number }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return <section aria-label="Task family" className="space-y-2 typography-meta">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('harness.threads.viewAll')}</Button>
    {open && <FamilyMembers api={api} mediaRead={mediaRead} identity={identity} host={host} observe={observe} />}
  </section>;
}
function FamilyMembers({ api, mediaRead, identity, host, observe }: Props & { host: number }) {
  const { t } = useI18n();
  const [version, setVersion] = React.useState(0);
  const [reconnect, setReconnect] = React.useState(0);
  const [family, setFamily] = React.useState<FamilyList>();
  const [error, setError] = React.useState(false);
  const [selected, setSelected] = React.useState<FamilyMember>();
  const [scope,setScope]=React.useState<'current'|'history'>('current');
  const [cursor,setCursor]=React.useState<string>();
  React.useEffect(()=>{
    if(!observe)return;
    const controller=new AbortController();let queued=false;
    void observe(null,event=>{
      if('stream' in event || !/^(thread\.|run\.|child\.|message\.|input\.|operation\.|execution\.committed|delivery\.)/.test(event.kind))return;
      if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!controller.signal.aborted){setCursor(undefined);setVersion(value=>value+1);}});
    },{signal:controller.signal}).then(()=>{if(!controller.signal.aborted)setError(true);},()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[observe,reconnect]);
  React.useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void api.list(identity, { scope, cursor }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) {
        setFamily(previous=>({...result,members:cursor?[...(previous?.members??[]),...result.members.filter(member=>!previous?.members.some(old=>old.threadId===member.threadId))]:result.members}));
        setSelected(previous=>previous ? result.members.find(member=>member.threadId===previous.threadId)??previous:undefined);
      }
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, host, version, scope, cursor]);
  return <>
    <Button size="sm" variant="ghost" onClick={() => {setCursor(undefined);setVersion(value => value + 1);setReconnect(value=>value+1);}}>{t('chat.family.refresh')}</Button>
    <Button size="sm" variant="ghost" aria-pressed={scope==='history'} onClick={()=>{setScope(value=>value==='current'?'history':'current');setCursor(undefined);setFamily(undefined);}}>{t(scope==='current'?'chat.family.history':'chat.family.current')}</Button>
    {error ? <p role="alert">{t('chat.family.failed')}</p> : !family ? <p role="status">{t('common.loading')}</p> : <>
      {family.members.length === 0 && <p>{t('chat.family.empty')}</p>}
      <ul className="space-y-1">{family.members.map(member => <li key={member.threadId}>
        <Button variant="ghost" size="sm" className="max-w-full gap-2 truncate" aria-pressed={selected?.threadId === member.threadId} onClick={() => setSelected(member)}><AgentAvatar identity={member.threadId} avatar={member.avatar} size={20} />{member.name || member.task || t('chat.family.untitled')}</Button>
        {member.agentId && <button className="font-mono text-muted-foreground" title={member.agentId} onClick={()=>void navigator.clipboard.writeText(member.agentId!)}>{member.agentId}</button>}
        <ChildState state={member.state} />
      </li>)}</ul>
      {family.nextCursor && <Button variant="ghost" size="sm" onClick={()=>setCursor(family.nextCursor!)}>{t('chat.family.more')}</Button>}
    </>}
    {selected && <FamilyConversation key={selected.threadId} api={api} mediaRead={mediaRead} identity={identity} host={host} member={selected} />}
  </>;
}
function FamilyConversation({ api, mediaRead, identity, host, member }: Props & { host: number; member: FamilyMember }) {
  const { t } = useI18n();
  const [branchId, setBranchId] = React.useState(member.branches[0]?.branchId ?? '');
  const [error, setError] = React.useState<string>();
  return <div className="space-y-2 border-t pt-2">
    <label>{t('chat.family.branch')} <select className="rounded border border-border bg-background p-1" aria-label={t('chat.family.branch')} value={branchId} onChange={event => setBranchId(event.target.value)}>
      {member.branches.map((branch, index) => <option key={branch.branchId} value={branch.branchId}>{t('chat.family.branch')} {index + 1}</option>)}
    </select></label>
    {branchId && <Button size="sm" variant="ghost" onClick={() => void openThreadFromNavigation({ threadId: member.threadId, branchId }).catch(error => setError(String(error)))}>{t('harness.threads.openConversation')}</Button>}
    {error && <p role="alert">{error}</p>}
    {branchId && <FamilyHistory key={branchId} api={api} mediaRead={mediaRead} identity={identity} host={host} threadId={member.threadId} branchId={branchId} />}
  </div>;
}
function FamilyHistory({ api, mediaRead, identity, host, threadId, branchId, fixedRunId }: Props & { host: number; threadId: string; branchId: string; fixedRunId?: string }) {
  const { t } = useI18n();
  const [runs, setRuns] = React.useState<FamilyRuns>();
  const [runCursor, setRunCursor] = React.useState<string>();
  const [runsRevision, setRunsRevision] = React.useState(0);
  const [runsError, setRunsError] = React.useState(false);
  const [runId, setRunId] = React.useState(fixedRunId ?? '');
  const [text, setText] = React.useState('');
  const [read, setRead] = React.useState<{ query: FamilyReadQuery; anchor?: string; cursor?: string; revision: number }>({ query: { kind: 'recent' }, revision: 0 });
  const [page, setPage] = React.useState<FamilyRead>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [itemId, setItemId] = React.useState<string>();
  const runScope = runId ? { runId } : {};
  React.useEffect(() => {
    if (fixedRunId) return;
    const controller = new AbortController(); setRunsError(false);
    void api.runs(identity, { threadId, branchId, cursor: runCursor }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRuns(previous => ({ ...result, runs: runCursor ? [...(previous?.runs ?? []), ...result.runs] : result.runs }));
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRunsError(true); });
    return () => controller.abort();
  }, [api, identity, host, threadId, branchId, runCursor, runsRevision, fixedRunId]);
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setPage(undefined); setItemId(undefined);
    void api.read(identity, { threadId, branchId, ...(runId ? { runId } : {}), query: read.query, anchor: read.anchor, cursor: read.cursor }, controller.signal).then(result => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) { setPage(result); setLoading(false); }
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, [api, identity, host, threadId, branchId, runId, read]);
  const latest = () => setRead(value => ({ query: { kind: 'recent' }, revision: value.revision + 1 }));
  return <div aria-label="Family conversation history" className="space-y-2">
    {!fixedRunId && <label>{t('chat.family.execution')} <select className="rounded border border-border bg-background p-1" aria-label={t('chat.family.execution')} value={runId} onChange={event => { setRunId(event.target.value); latest(); }}>
      <option value="">{t('chat.family.all')}</option>
      {runs?.runs.map((run, index) => <option key={run.runId} value={run.runId}>{t('chat.family.execution')} {index + 1}</option>)}
    </select></label>}
    {runs?.nextCursor && <Button size="sm" variant="ghost" onClick={() => setRunCursor(runs.nextCursor!)}>{t('chat.family.earlierRuns')}</Button>}
    {runsError && <p role="alert">{t('chat.family.failed')}<Button size="sm" variant="ghost" onClick={() => setRunsRevision(value => value + 1)}>{t('chat.family.retry')}</Button></p>}
    <div className="flex flex-wrap gap-2">
      <input aria-label="Search family conversation" value={text} onChange={event => setText(event.target.value)} placeholder={t('chat.family.searchPlaceholder')} className="rounded border border-border bg-background px-2 py-1" />
      <Button size="sm" variant="outline" disabled={!text.length} onClick={() => setRead(value => ({ query: { kind: 'search', text, direction: 'older' }, revision: value.revision + 1 }))}>{t('chat.family.search')}</Button>
      <Button size="sm" variant="outline" onClick={latest}>{t('chat.family.latest')}</Button>
    </div>
    {loading && <p role="status">{t('common.loading')}</p>}
    {error && <p role="alert">{t('chat.family.failed')}<Button size="sm" variant="ghost" onClick={() => setRead(value => ({ ...value, revision: value.revision + 1 }))}>{t('chat.family.retry')}</Button></p>}
    {page && <>
      {page.items.length === 0 && <p>{t(page.scanComplete ? 'chat.family.noMatches' : 'chat.family.continueSearch')}</p>}
      {page.items.map(item => <article key={item.id} className="space-y-1 rounded border p-2">
        {item.bodyTruncated ? <><p>{t('chat.family.partial')}</p><pre className="whitespace-pre-wrap break-all">{item.preview}</pre></>
          : <ThreadContent api={{ mediaRead }} identity={identity} holder={{ kind: 'family', threadId, branchId, ...runScope, anchor: page.anchor, itemId: item.id }} parts={historyParts(item.body, item.source)} messageId={`family:${item.id}`} />}
        <Button size="sm" variant="ghost" onClick={() => setItemId(item.id)}>{t('chat.family.original')}</Button>
      </article>)}
      <div className="flex gap-2">
        {page.nextCursor && <Button size="sm" variant="outline" onClick={() => setRead(value => ({ ...value, anchor: page.anchor, cursor: page.nextCursor! }))}>{t('chat.family.more')}</Button>}
        {page.hasEarlier && page.items[0] && <Button size="sm" variant="ghost" onClick={() => setRead(value => ({ revision: value.revision + 1, anchor: page.anchor, query: { kind: 'range', beforeId: page.items[0]!.id, direction: 'older' } }))}>{t('chat.family.earlier')}</Button>}
        {page.hasLater && page.items.at(-1) && <Button size="sm" variant="ghost" onClick={() => setRead(value => ({ revision: value.revision + 1, anchor: page.anchor, query: { kind: 'range', afterId: page.items.at(-1)!.id, direction: 'newer' } }))}>{t('chat.family.later')}</Button>}
      </div>
      {itemId && <FamilyOriginal key={`${page.anchor}:${itemId}`} api={api} mediaRead={mediaRead} identity={identity} host={host} request={{ threadId, branchId, ...runScope, anchor: page.anchor, itemId }} />}
    </>}
  </div>;
}
function FamilyOriginal({ api, identity, host, request }: Props & { host: number; request: Parameters<ThreadFamilyAPI['item']>[1] }) {
  const { t } = useI18n();
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
    <p>{t('chat.family.original')}</p>
    {error ? <p role="alert">{t('chat.family.failed')}<Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>{t('chat.family.retry')}</Button></p> : !page ? <p role="status">{t('common.loading')}</p> : <>
      <p className="text-muted-foreground">{page.offset}–{page.nextOffset ?? page.totalBytes} / {page.totalBytes}</p>
      <pre className="whitespace-pre-wrap break-all">{page.text}</pre>
      {page.nextOffset !== null && <Button size="sm" variant="outline" onClick={() => setOffset(page.nextOffset!)}>{t('chat.family.next')}</Button>}
      {page.offset > 0 && <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>{t('chat.family.first')}</Button>}
    </>}
  </div>;
}
