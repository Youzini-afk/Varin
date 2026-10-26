import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ThreadContextHistory, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import type { ContextJobRow } from '@/lib/contextPresentation';
import { readableContextSummary, useContextJobHistory } from './useContextJobHistory';

it('streams the selected job, reconciles its committed summary, and releases observation on collapse', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
  const element = window.document.getElementById('root')! as unknown as HTMLElement, root = createRoot(element);
  const identity: ThreadIdentity = { runtime: 'agent', threadId: 'parent-thread', branchId: 'parent-branch' };
  const row = { run: { id: 'summary-run', state: 'executing', revision: 1 }, job: { receipt: { branch_id: 'summary-branch' } } } as ContextJobRow;
  let page: ThreadContextHistory = { head: null, previous: null, items: [] };
  let listener!: Parameters<ThreadsAPI['observe']>[1], signal!: AbortSignal;
  const contextHistory = vi.fn(async () => page);
  const api = { contextHistory, observe: async (_cursor, next, options) => {
    listener = next; signal = options.signal;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } } satisfies Pick<ThreadsAPI, 'contextHistory' | 'observe'> as unknown as ThreadsAPI;
  function View({ active }: { active: boolean }) {
    const history = useContextJobHistory(api, identity, row, active);
    return <div>{history.parts.map(part => <p key={part.id}>{part.type === 'text' ? readableContextSummary(part.text) : part.thinking}</p>)}</div>;
  }
  const delta = (runId: string, sequence: number, text: string) => listener({ stream: 'progress', kernelEpoch: 'epoch', streamId: 'stream',
    threadId: 'summary-thread', branchId: 'summary-branch', runId, requestId: 'r', sequence,
    event: { kind: 'batch', events: [{ kind: 'provider', data: { kind: 'text_delta', item_id: 'answer', text } }] } } as Parameters<typeof listener>[0]);
  try {
    await act(async () => root.render(<View active />));
    expect(contextHistory).toHaveBeenCalledWith(identity, 'summary-run');
    await act(async () => { delta('unrelated-run', 1, 'wrong task'); delta('summary-run', 1, '{"summary":"Keep '); frame?.(0); });
    expect(element.textContent).toBe('Keep ');
    await act(async () => { delta('summary-run', 2, 'the goal"}'); frame?.(1); });
    expect(element.textContent).toBe('Keep the goal');
    page = { head: 'answer', previous: null, items: [{ id: 'answer', parent: null, thread_id: 'summary-thread', run_id: 'summary-run', source: 'assistant', provider: null,
      modelRequest: { requestId: 'r', providerFamily: 'openai-completions', modelId: 'model', contextTokens: null, usage: { measurement: 'missing', inputTokens: null, outputTokens: null } },
      content: { id: 'model-item:1:r:answer', content: { kind: 'text', text: '{"summary":"Keep the goal"}' } } }] };
    await act(async () => listener({ cursor: 1, subject: 'summary-run', revision: 2, kind: 'model.settled', data: {} }));
    expect(element.textContent).toBe('Keep the goal');
    expect(element.querySelectorAll('p')).toHaveLength(1);
    await act(async () => root.render(<View active={false} />));
    expect(signal.aborted).toBe(true);
    expect(element.textContent).toBe('Keep the goal');
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
