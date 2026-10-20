import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI, UiReceipt } from '@varin/application-client';
import { ThreadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { HistoryPresentation } from '../conversation/historyPresentation';
import { fileChangePhase, fileChangeTargets, type FileChangePhase } from '../conversation/fileChangePreview';
import type { ChatToolCall, ChatToolResultMessage } from '../conversation/types';

export type ThreadProduct =
  | { kind: 'file'; key: string; itemId: string; runId: string; call: ChatToolCall; path: string; deleted: boolean; phase: FileChangePhase }
  | { kind: 'ui'; key: string; itemId: string; runId: string; call: ChatToolCall; receipt: UiReceipt };

/** Original calls and receipts, never the current navigation project's Git status. */
export function threadProducts(history: ThreadSnapshot['history'], snapshot: ThreadSnapshot | undefined): ThreadProduct[] {
  const view = new HistoryPresentation('products').project(history, snapshot);
  const results = new Map<string, ChatToolResultMessage>();
  for (const entry of view.entries) if (entry.type === 'message' && entry.message.role === 'toolResult') results.set(entry.message.toolCallId, entry.message);
  const products = new Map<string, ThreadProduct>();
  for (const entry of view.entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    for (const original of entry.message.content) {
      if (original.type !== 'toolCall') continue;
      const args = original.arguments as { reference?: { name?: string }; arguments?: ChatToolCall['arguments'] } | null;
      const call = original.name === 'tool_invoke' && args?.reference?.name && args.arguments
        ? { ...original, name: args.reference.name, arguments: args.arguments } : original;
      const originalResult = results.get(call.id);
      const details = originalResult?.details as { reference?: unknown; result?: ChatToolResultMessage['details'] } | undefined;
      const result = original.name === 'tool_invoke' && details?.reference && details.result
        ? { ...originalResult!, details: details.result } : originalResult;
      for (const file of fileChangeTargets(call)) {
        const phase = fileChangePhase(view.toolExecutions[call.id], result, false, file.path);
        if (!['applied', 'draft', 'branch'].includes(phase)) continue;
        const key = JSON.stringify([entry.runId, file.path]);
        products.delete(key);
        products.set(key, { kind: 'file', key, itemId: entry.id, runId: entry.runId!, call, path: file.path, deleted: file.operation === 'delete', phase });
      }
      const receipt = result?.details as Partial<UiReceipt> | undefined;
      if (call.name === 'render_ui' && !result?.isError && receipt?.kind === 'ui' && receipt.ref && receipt.workRef && typeof receipt.title === 'string') {
        const key = receipt.workRef;
        products.delete(key);
        products.set(key, { kind: 'ui', key, itemId: entry.id, runId: entry.runId!, call, receipt: receipt as UiReceipt });
      }
    }
  }
  return [...products.values()].reverse();
}

/** This reader is independent of the timeline viewport. Older pages are read when the product list is browsed. */
export function useThreadProducts(api: ThreadsAPI, identity: ThreadIdentity, snapshot: ThreadSnapshot | undefined, active: boolean) {
  const window = React.useMemo(() => new ThreadHistoryWindow(api, identity, { usage: false }), [api, identity]);
  const subscribe = React.useCallback((listener: () => void) => active ? window.subscribe(listener) : () => {}, [active, window]);
  const history = React.useSyncExternalStore(subscribe, window.getSnapshot, window.getSnapshot);
  React.useEffect(() => { if (active && snapshot) window.accept(snapshot); }, [active, snapshot, window]);
  const products = React.useMemo(() => threadProducts(history.ready ? history.items : snapshot?.history ?? [], snapshot), [history.ready, history.items, snapshot]);
  // Finish the latest Run's page boundary so its file count is independent of snapshot capacity.
  const latestRun = snapshot?.activeRun?.id ?? snapshot?.thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run?.id;
  React.useEffect(() => {
    if (active && history.previous && !history.loading && !history.error && history.items.length && history.items.every(item => item.run_id === latestRun)) void window.loadEarlier();
  }, [active, history, latestRun, window]);
  return { products, history, loadEarlier: window.loadEarlier };
}
