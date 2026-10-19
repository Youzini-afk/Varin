import React from 'react';
import type { ChildTask, DelegatedExecution } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI, ThreadSnapshot } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadChildReport } from '../thread/ThreadChildReport';
import { ThreadExecutions } from '../thread/ThreadExecutions';
import { ThreadIntegrationPanel } from '../thread/ThreadIntegrationPanel';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useI18n } from '@/lib/i18n';
import { ChildState, ChildFileResult } from './childPresentation';
import { childEnded, childTaskRows } from './childTaskRows';

/** A row follows the newest execution; each report still uses its own immutable owner. */
export function ChildTasks({ api, identity, children, executions, activity, directory, pending, cancel }: {
  api: ThreadsAPI; identity: ThreadIdentity; children: ChildTask[]; executions: DelegatedExecution[];
  pending: boolean; cancel?: (operationId: string) => Promise<unknown>;
  activity?: ThreadSnapshot['childActivity'];
  directory?:ThreadSnapshot['childDirectory'];
}) {
  const { t } = useI18n();
  const [error, setError] = React.useState<string>();
  const [showEnded,setShowEnded]=React.useState(false);
  const [opened,setOpened]=React.useState<Set<string>>(()=>new Set());
  const [historyPage,setHistoryPage]=React.useState<import('@varin/application-client').ThreadChildPage>();
  const [cursor,setCursor]=React.useState<string>();
  const [historyLoading,setHistoryLoading]=React.useState(false);
  const retained=React.useRef(new Map<string,ReturnType<typeof childTaskRows>[number]>());
  const listed=childTaskRows([...(historyPage?.children??[]),...children],[...(historyPage?.executions??[]),...executions],activity);
  const rows=[...new Map([...[...retained.current.values()].filter(row=>opened.has(row.child.operation_id)),...listed].map(row=>[row.child.operation_id,row])).values()];
  React.useEffect(()=>{
    for(const row of listed)if(opened.has(row.child.operation_id))retained.current.set(row.child.operation_id,row);
    for(const key of retained.current.keys())if(!opened.has(key))retained.current.delete(key);
  });
  const current=directory?new Set(directory.members.filter(member=>member.current).map(member=>member.threadId)):undefined;
  const active=rows.filter(row=>current?current.has(row.child.child_thread_id):!childEnded(row.state));
  const ended=rows.filter(row=>!active.includes(row));
  React.useEffect(()=>{
    if(!showEnded||!api.collaboration?.page)return;
    const controller=new AbortController();setHistoryLoading(true);
    void api.collaboration.page(identity,{scope:'history',...(cursor?{cursor}:{})},controller.signal).then(page=>{
      if(controller.signal.aborted)return;
      setHistoryPage(previous=>cursor&&previous?{directory:{...page.directory,members:[...previous.directory.members,...page.directory.members]},children:[...previous.children,...page.children],executions:[...previous.executions,...page.executions]}:page);
      setHistoryLoading(false);
    },error=>{if(!controller.signal.aborted){setError(String(error));setHistoryLoading(false);}});
    return()=>controller.abort();
  },[api.collaboration,identity.threadId,identity.branchId,showEnded,cursor]);
  const missingOpen=[...opened].filter(id=>!children.some(child=>child.operation_id===id)&&retained.current.has(id)).sort().join('|');
  React.useEffect(()=>{
    if(!missingOpen||!api.collaboration?.page)return;
    const controller=new AbortController();
    for(const id of missingOpen.split('|')) {
      const old=retained.current.get(id);if(!old)continue;
      void api.collaboration.page(identity,{scope:'all',query:old.child.child_thread_id},controller.signal).then(page=>{
        if(controller.signal.aborted)return;
        setHistoryPage(previous=>({directory:previous?.directory??page.directory,
          children:[...(previous?.children??[]).filter(child=>child.operation_id!==id),...page.children],
          executions:[...(previous?.executions??[]).filter(execution=>execution.child_operation_id!==id),...page.executions]}));
      },error=>{if(!controller.signal.aborted)setError(String(error));});
    }
    return()=>controller.abort();
  },[api.collaboration,identity.threadId,identity.branchId,missingOpen]);
  const open = async (child: ChildTask) => {
    try { setError(undefined); await openThreadFromNavigation({ threadId: child.child_thread_id, branchId: child.child_branch_id }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const renderRow = ({ child, latest, state, task }: typeof rows[number]) => {
    const report = latest?.report ?? (latest ? null : child.report);
    const result = latest?.code_result ?? child.code_result;
    return <details key={child.operation_id} className="group/child rounded-lg"
      hidden={!active.some(row=>row.child.operation_id===child.operation_id)&&!showEnded&&!opened.has(child.operation_id)}
      onToggle={event=>{const open=event.currentTarget.open;setOpened(previous=>{if(previous.has(child.operation_id)===open)return previous;const next=new Set(previous);if(open)next.add(child.operation_id);else next.delete(child.operation_id);return next;});}}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2 hover:bg-interactive-hover [&::-webkit-details-marker]:hidden">
        <Icon name="chat-3" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate typography-meta font-medium" title={task}>{child.name || child.input.name || task}</span>
        {child.agent_id && <span className="font-mono typography-micro text-muted-foreground">{child.agent_id}</span>}
        <ChildState state={latest?.cancel_requested && !childEnded(state) ? 'stopping' : state} />
      </summary>
      {opened.has(child.operation_id)&&<div className="space-y-3 border-l border-border/50 py-2 pl-3 ml-3">
        <p className="whitespace-pre-wrap break-words typography-meta">{task}</p>
        <ChildFileResult result={result} />
        {latest && <ThreadIntegrationPanel api={api} identity={identity} execution={latest} />}
        {report?.detail && <MarkdownRenderer messageId={`child:${latest?.execution_id ?? child.operation_id}`} content={report.detail} />}
        {report?.history_ids.map(itemId => <ThreadChildReport key={itemId} api={api} identity={identity}
          operationId={child.operation_id} executionId={latest?.execution_id} itemId={itemId} />)}
        <PreviousExecutions api={api} identity={identity} child={child} executionId={latest?.execution_id} />
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={() => void open(child)}>{t('harness.threads.openConversation')}</Button>
          {cancel && !report && !childEnded(state) && <Button variant="ghost" size="sm" disabled={pending || latest?.cancel_requested}
            onClick={() => void cancel(child.operation_id)}>{t('harness.threads.stop')}</Button>}
        </div>
      </div>}
    </details>;
  };
  return <div className="space-y-1" aria-label={t('harness.threads.title')}>
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    {[...active.map(renderRow),<button key="ended" className="flex items-center gap-1 py-1 typography-meta text-muted-foreground" aria-expanded={showEnded} onClick={()=>setShowEnded(value=>!value)}>
      <Icon name="arrow-right-s" className={showEnded?'size-3.5 rotate-90':'size-3.5'} />{t('chat.family.history')}
    </button>,...ended.map(renderRow)]}
    {showEnded&&historyPage?.directory.nextCursor&&<Button size="sm" variant="ghost" disabled={historyLoading} onClick={()=>setCursor(historyPage.directory.nextCursor!)}>{t('chat.family.more')}</Button>}
  </div>;
}

function PreviousExecutions({api,identity,child,executionId}:{api:ThreadsAPI;identity:ThreadIdentity;child:ChildTask;executionId?:string}) {
  const {t}=useI18n();const [open,setOpen]=React.useState(false);
  const [executions,setExecutions]=React.useState<DelegatedExecution[]>();
  const [error,setError]=React.useState<string>();
  React.useEffect(()=>{if(!open||!api.collaboration)return;const controller=new AbortController();
    void api.collaboration.executions(identity,child.operation_id,controller.signal).then(value=>{if(!controller.signal.aborted)setExecutions(value.slice(0,-1));},error=>{if(!controller.signal.aborted)setError(String(error));});
    return()=>controller.abort();},[api.collaboration,identity.threadId,identity.branchId,child.operation_id,executionId,open]);
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary className="cursor-pointer typography-meta text-muted-foreground">{t('chat.children.previousExecutions')}</summary>
    {error&&<p role="alert">{error}</p>}{executions&&<ThreadExecutions api={api} identity={identity} executions={executions}/>}</details>;
}
