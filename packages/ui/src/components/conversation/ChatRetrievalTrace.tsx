import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { ThreadRetrievalTrace } from '@varin/application-client';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { HistoryPresentation } from './historyPresentation';
import { ConversationContext, useConversationPresentation } from './ConversationContext';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { getToolSummary } from '@/components/chat/message/parts/toolSummary';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { useI18n } from '@/lib/i18n';
import { ToolTargetScope } from './ToolTargetScope';
import { ToolTargetContext } from './toolTargetContext';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

export type RetrievalToolRenderer = (call: ChatToolCall, execution: ChatToolExecutionState | undefined,
  result: ChatToolResultMessage | undefined, executions: Record<string, ChatToolExecutionState>) => React.ReactNode;

/** Observe retained native history through the parent Operation, including after completion. */
export function ChatRetrievalTrace({ operationId, running, expanded, renderTool }: {
  operationId: string; running: boolean; expanded: boolean; renderTool: RetrievalToolRenderer;
}) {
  const conversation = useConversationPresentation();
  const { t } = useI18n();
  const reducedMotion=usePrefersReducedMotion();
  const scroll=React.useRef<HTMLDivElement>(null);
  const follow=React.useRef(true);
  const scrollPosition=React.useRef(0);
  const prepend=React.useRef<{height:number;top:number} | undefined>(undefined);
  const requestOwner=React.useRef<AbortController | undefined>(undefined);
  const [trace, setTrace] = React.useState<ThreadRetrievalTrace>();
  const [error, setError] = React.useState<string>();
  const [loadingEarlier, setLoadingEarlier] = React.useState(false);
  const earlier = React.useRef<{ headId: string; beforeId: string } | undefined>(undefined);
  const alive = React.useRef(false);
  const projection = React.useMemo(() => new HistoryPresentation(operationId), [operationId]);
  React.useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); requestOwner.current=controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await conversation.api.retrievalTrace(operationId, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setTrace(old => {
          const overlaps = old && next.history.items.some(item => old.history.items.some(prior => prior.id === item.id));
          if (!overlaps) earlier.current = next.history.head && next.history.previous
            ? { headId: next.history.head, beforeId: next.history.previous } : undefined;
          const seen = new Set(next.history.items.map(item => item.id));
          return { ...next, history: { ...next.history, items: overlaps
            ? [...old.history.items.filter(item => !seen.has(item.id)), ...next.history.items] : next.history.items } };
        });
        setError(undefined);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (running && !controller.signal.aborted) timer = setTimeout(read, 1000); }
    };
    void read();
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [conversation.api, operationId, running]);
  React.useLayoutEffect(()=>{
    const node=scroll.current;if(!node)return;
    if(prepend.current){node.scrollTop=prepend.current.top+node.scrollHeight-prepend.current.height;prepend.current=undefined;}
    else node.scrollTop=follow.current ? node.scrollHeight : scrollPosition.current;
  },[trace,expanded]);
  const view = React.useMemo(() => projection.project(trace?.history.items ?? [], trace ? {
    operations: trace.operations, activeRun: trace.run && !['completed', 'failed', 'cancelled'].includes(trace.run.state) ? trace.run : null,
  } : undefined), [trace, projection]);
  const results = new Map<string, ChatToolResultMessage>();
  const calls: Array<{ call: ChatToolCall; itemId: string }> = [];
  for (const entry of view.entries) if (entry.type === 'message') {
    if (entry.message.role === 'toolResult') results.set(entry.message.toolCallId, entry.message);
    else if (entry.message.role === 'assistant') for (const part of entry.message.content)
      if (part.type === 'toolCall') calls.push({ call: part, itemId: entry.id });
  }
  const fileTarget = async (callId: string, path: string) => {
    const host = getRuntimeEndpointGeneration();
    const itemId = calls.find(item => item.call.id === callId)?.itemId;
    if (!itemId) throw new Error(t('chat.files.no_source'));
    const target = await conversation.api.retrievalFileTarget(operationId, itemId, path);
    if (!alive.current || host !== getRuntimeEndpointGeneration()) throw new DOMException('Retrieval view changed', 'AbortError');
    if (target.kind === 'unavailable') throw new Error(t(`chat.files.${target.reason}`));
    return target;
  };
  const context = { ...conversation,
    identity: trace?.run ? {...conversation.identity,threadId:trace.run.thread_id,branchId:trace.run.branch_id} : conversation.identity,
    toolExecutions: view.toolExecutions, fileTarget,
    openFile: async (callId: string, path: string, line?: number) => {
      try {
        const target = await fileTarget(callId, path);
        revealResourceInEditor({ workspaceId: target.workspaceId, workspaceRoot: target.root, resourceId: target.resourceId,
          thread: conversation.identity, toolCallId: callId, ...(line ? { line } : {}) });
      } catch (failure) { if (alive.current && !(failure instanceof DOMException && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : String(failure)); }
    },
  };
  const loadEarlier = async () => {
    if (!earlier.current || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const owner=requestOwner.current;
      const next = await conversation.api.retrievalTrace(operationId, earlier.current,owner?.signal);
      if (!alive.current || owner?.signal.aborted) return;
      if(scroll.current){prepend.current={height:scroll.current.scrollHeight,top:scroll.current.scrollTop};follow.current=false;}
      earlier.current = next.history.head && next.history.previous ? { headId: next.history.head, beforeId: next.history.previous } : undefined;
      setTrace(old => old ? { ...old, history: { ...old.history, items: [...next.history.items.filter(item => !old.history.items.some(prior => prior.id === item.id)), ...old.history.items] } } : next);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current) setLoadingEarlier(false); }
  };
  const last = calls.at(-1)?.call;
  const active = Object.values(view.toolExecutions).find(execution => execution.status === 'running' || execution.status === 'waiting');
  const lastAssistantText = view.entries.flatMap(entry => {
    if (entry.type !== 'message') return [];
    const message = entry.message;
    if (message.role !== 'assistant' && !(message.role === 'custom' && message.customType === 'assistant')) return [];
    const text = typeof message.content === 'string' ? message.content
      : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    return text.trim() ? [{ id: entry.id, text }] : [];
  }).at(-1);
  const modelWorking = running && trace?.run?.state === 'generating' && !active;
  const action = active ? { id: active.operationId ?? active.toolCallId, name: active.name, arguments: active.args } : last;
  return <ConversationContext.Provider value={context}><ToolTargetContext.Provider value={null}>
    <ToolTargetScope entries={view.entries} executions={view.toolExecutions}>
      {running && lastAssistantText && <div className="line-clamp-3 break-words px-3 py-1 typography-meta text-muted-foreground">
        <MarkdownRenderer content={lastAssistantText.text} messageId={lastAssistantText.id} />
      </div>}
      {!expanded && (action || modelWorking) && <div className="overflow-hidden"><AnimatePresence initial={false} mode="popLayout"><motion.p key={modelWorking ? 'model' : action!.id}
        initial={reducedMotion?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reducedMotion?0:-8}}
        transition={{duration:reducedMotion?0:0.18}} className="truncate px-3 py-1 typography-meta text-muted-foreground" title={modelWorking ? undefined : action?.name}>
        {modelWorking ? t('chat.explore.modelWorking') : getToolSummary({toolName:action!.name,arguments:action!.arguments,details:results.get(action!.id)?.details}).text || action!.name}
      </motion.p></AnimatePresence></div>}
      <AnimatePresence initial={false}>{expanded && <motion.div key="trace" initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}}
        exit={{height:0,opacity:0}} transition={{duration:reducedMotion?0:0.22,ease:[0.22,1,0.36,1]}} className="overflow-hidden">
      <div ref={scroll} onScroll={event=>{const node=event.currentTarget;scrollPosition.current=node.scrollTop;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<24;}}
        className="max-h-[min(34rem,65vh)] overflow-auto overscroll-contain px-3" data-conversation-tool-scroll="true">
        {earlier.current && <button type="button" disabled={loadingEarlier} className="py-2 typography-meta text-muted-foreground hover:text-foreground" onClick={() => void loadEarlier()}>{t('chat.explore.earlier')}</button>}
        {calls.map(({ call }) => <React.Fragment key={call.id}>{renderTool(call, view.toolExecutions[call.id], results.get(call.id), view.toolExecutions)}</React.Fragment>)}
        {error && <p role="status" className="break-words py-2 typography-meta text-muted-foreground">{error}</p>}
      </div>
      </motion.div>}</AnimatePresence>
    </ToolTargetScope>
  </ToolTargetContext.Provider></ConversationContext.Provider>;
}
