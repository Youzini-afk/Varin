import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI, type ThreadContextHistory, type ThreadHistoryItem } from '@varin/application-client';
import { HistoryPresentation } from '@/components/conversation/historyPresentation';
import type { ChatTextContent, ChatThinkingContent } from '@/components/conversation/types';
import type { ContextJobRow } from '@/lib/contextPresentation';
import { PartialJson } from '@/lib/interactive-ui/partial-json';

type Part = ChatTextContent | ChatThinkingContent;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Read via the parent-owned job. The auxiliary Thread is never selected or admitted by this view. */
export function useContextJobHistory(api: ThreadsAPI, identity: ThreadIdentity, row: ContextJobRow | undefined, active: boolean) {
  const [view, setView] = React.useState<{ owner: string; page?: ThreadContextHistory; live: Part[]; error?: string; loading: boolean }>({ owner: '', live: [], loading: false });
  const runId = row?.run.id;
  const jobBranchId = row?.job.receipt.branch_id;
  const running = !!row && !['completed', 'failed', 'cancelled'].includes(row.run.state);
  const owner = JSON.stringify([getRuntimeEndpointGeneration(), identity.threadId, identity.branchId, runId]);
  const generation = React.useRef(0), refresh = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    const current = ++generation.current, host = getRuntimeEndpointGeneration();
    const abort = new AbortController();
    const valid = () => !abort.signal.aborted && generation.current === current && host === getRuntimeEndpointGeneration();
    const live = new Map<string, Part>();
    const committedRequests = new Set<string>();
    const textReaders = new Map<string, { raw: string; parser: PartialJson }>();
    let frame: number | undefined;
    let request = '', stream = '', sequence = -1, pending = false, dirty = false;
    setView(old => old.owner === owner ? { ...old, loading: !!runId && active } : { owner, loading: !!runId && active, live: [] });
    if (!runId || !active) return () => abort.abort();
    const read = async () => {
      dirty = true; if (pending) return;
      pending = true;
      try {
        while (dirty && valid()) {
          dirty = false;
          const page = await api.contextHistory(identity, runId);
          if (!valid()) return;
          const committed = new Set(page.items.map(item => String(record(item.content).id ?? item.id)));
          for (const item of page.items) if (item.source === 'assistant' && item.modelRequest) committedRequests.add(item.modelRequest.requestId);
          if (committedRequests.has(request)) { live.clear(); textReaders.clear(); }
          for (const [key, part] of live) if (part.id && committed.has(part.id)) live.delete(key);
          setView(old => ({ owner, page: { ...page, items: mergeItems(old.owner === owner ? old.page?.items ?? [] : [], page.items) }, live: [...live.values()], loading: false }));
        }
      } catch (error) { if (valid()) setView(old => ({ ...old, owner, loading: false, error: error instanceof Error ? error.message : String(error) })); }
      finally { pending = false; }
    };
    refresh.current = read;
    void read();
    const observe = async () => {
      while (valid()) {
      try {
        await api.observe(null, event => {
          if (!valid()) return;
          if (!('stream' in event)) {
            if (event.subject === runId || event.subject === jobBranchId || event.subject === identity.branchId) void read();
            return;
          }
          if (event.stream !== 'progress' || event.runId !== runId || committedRequests.has(event.requestId)) return;
          const key = `${event.kernelEpoch}:${event.streamId}`;
          if (key === stream && event.sequence <= sequence) return;
          if (stream && stream !== key || request !== event.requestId || sequence >= 0 && event.sequence !== sequence + 1) { live.clear(); textReaders.clear(); void read(); }
          stream = key; sequence = event.sequence; request = event.requestId;
          const batch = record(event.event);
          if (batch.kind !== 'batch' || !Array.isArray(batch.events)) return;
          for (const item of batch.events) {
            const payload = record(item), data = record(payload.data);
            if (payload.kind !== 'provider' || !['text_delta', 'reasoning_delta'].includes(String(data.kind)) || typeof data.item_id !== 'string' || typeof data.text !== 'string') continue;
            const partKey = `${data.kind}:${data.item_id}`, old = live.get(partKey);
            const id = `model-item:${new TextEncoder().encode(request).length}:${request}:${data.item_id}`;
            if (data.kind === 'text_delta') {
              const reader = textReaders.get(partKey) ?? { raw: '', parser: new PartialJson() };
              reader.raw += data.text; textReaders.set(partKey, reader);
              const parsed = reader.parser.feed(data.text) as { summary?: unknown } | undefined;
              live.set(partKey, { type: 'text', id, text: typeof parsed?.summary === 'string' ? parsed.summary : reader.raw.trimStart().startsWith('{') ? '' : reader.raw });
            } else live.set(partKey, { type: 'thinking', id, thinking: (old?.type === 'thinking' ? old.thinking : '') + data.text });
          }
          frame ??= requestAnimationFrame(() => { frame = undefined; if (valid()) setView(old => ({ ...old, owner, live: [...live.values()] })); });
        }, { signal: abort.signal });
      } catch (error) { if (valid()) setView(old => ({ ...old, error: String(error) })); }
      if (!valid()) break;
      live.clear(); textReaders.clear(); stream = ''; sequence = -1;
      setView(old => ({ ...old, live: [] })); void read();
      // Use the same reconnect cadence as the main Thread projection.
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1000); abort.signal.addEventListener('abort', finish, { once: true });
      });
      }
    };
    if (running) void observe();
    return () => { abort.abort(); if (frame !== undefined) cancelAnimationFrame(frame); generation.current = current + 1; refresh.current = async () => {}; };
  }, [api, identity, owner, runId, jobBranchId, running, active]);
  React.useEffect(() => { if (active) void refresh.current(); }, [active, row?.run.revision, row?.job.published_revision]);
  const page = view.owner === owner ? view.page : undefined;
  const earlier = async () => {
    if (!page?.head || !page.previous || view.loading || !runId) return;
    const current = generation.current;
    setView(old => ({ ...old, loading: true }));
    try {
      const previous = await api.contextHistory(identity, runId, { headId: page.head, beforeId: page.previous });
      if (generation.current === current) setView(old => ({ ...old, loading: false, page: { ...old.page!, previous: previous.previous, items: mergeItems(previous.items, old.page?.items ?? []) } }));
    } catch (error) { if (generation.current === current) setView(old => ({ ...old, loading: false, error: String(error) })); }
  };
  const parts = React.useMemo(() => {
    const entries = new HistoryPresentation(owner).project(page?.items ?? [], undefined).entries;
    const committed = entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.filter((part): part is Part => part.type === 'text' || part.type === 'thinking') : []);
    const known = new Set(committed.map(part => part.id));
    return [...committed, ...(view.owner === owner ? view.live.filter(part => !known.has(part.id)) : [])];
  }, [page?.items, owner, view.owner, view.live]);
  return { ...view, page, parts, earlier, refresh: () => refresh.current() };
}
function mergeItems(before: ThreadHistoryItem[], after: ThreadHistoryItem[]): ThreadHistoryItem[] {
  const items = new Map(before.map(item => [item.id, item]));
  for (const item of after) items.set(item.id, item);
  return [...items.values()];
}
export function readableContextSummary(text: string): string {
  try { const value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); return typeof value.summary === 'string' ? value.summary : text; }
  catch { return text; }
}
