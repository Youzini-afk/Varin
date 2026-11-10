import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import { useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';

import type { EditorState } from '@codemirror/state';
import { composerHistoryReferences } from '@/components/chat/composer/editor/markerHistory';
import { composerClipboardReferences, subscribeComposerClipboard } from '@/components/chat/composer/editor/markerClipboard';

const pending = new Map<string, { identity: ThreadIdentity; host: number; sending?: boolean; waitingForInput?: boolean }>();
function referencesInDraft(draft: ThreadDraft, includeHistory = true): ContentReference[] {
  return [
    ...(includeHistory ? draft.retainedContentReferences ?? [] : []),
    ...(draft.markerObjects ?? []).flatMap(object => { const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference; return reference ? [reference] : []; }),
    ...(draft.firstSend?.contentReferences ?? []),
    ...(draft.externalInput?.contentReferences ?? []),
    ...(draft.collaboration?.attempts?.flatMap(attempt => attempt.request.contentReferences ?? []) ?? []),
    ...[draft.pendingInput, ...Object.values(draft.interactionSends ?? {}).map(send => send.pending)].flatMap(input => input?.input.contentReferences ?? []),
  ];
}
// Resource roots follow the actual CodeMirror history, including redo. Idle work is coalesced
// per draft; no private history representation or second persistent history owner is introduced.
const historySweeps = new Map<string, () => void>();
const sweptHistories = new Map<string, { state?: EditorState; retained: readonly ContentReference[]; active: string }>();
function activeHistoryRoots(draft: ThreadDraft): Set<string> {
  const roots = new Set(referencesInDraft(draft, false).map(reference => reference.ref));
  for (const reference of draft.retainedContentReferences ?? []) if ([draft.pendingInput, ...Object.values(draft.interactionSends ?? {}).map(send => send.pending)].some(input => input?.input.text.includes(reference.ref))) roots.add(reference.ref);
  return roots;
}
function scheduleHistorySweep(key: string, draft: ThreadDraft | undefined) {
  if (!draft) { historySweeps.get(key)?.(); historySweeps.delete(key); sweptHistories.delete(key); return; }
  const retained = draft.retainedContentReferences ?? [], active = activeHistoryRoots(draft), signature = [...active].sort().join('\n');
  if (!retained.some(reference => !active.has(reference.ref))) { historySweeps.get(key)?.(); historySweeps.delete(key); sweptHistories.delete(key); return; }
  const swept = sweptHistories.get(key);
  if (swept && swept.state === draft.editorState && swept.retained === retained && swept.active === signature || historySweeps.has(key)) return;
  const run = () => {
    historySweeps.delete(key);
    const current = useThreadDraftStore.getState().drafts[key];
    if (!current) { sweptHistories.delete(key); return; }
    const state = current.editorState, roots = activeHistoryRoots(current), active = [...roots].sort().join('\n');
    if (state) for (const reference of composerHistoryReferences(state)) roots.add(reference.ref);
    const before = current.retainedContentReferences ?? [], retained = before.filter(reference => roots.has(reference.ref));
    const latest = useThreadDraftStore.getState().drafts[key];
    if (latest !== current || latest?.editorState !== state) { scheduleHistorySweep(key, latest); return; }
    sweptHistories.set(key, { state, retained: retained.length === before.length ? before : retained, active });
    if (retained.length !== before.length) useThreadDraftStore.getState().patch(key, candidate => candidate === current && candidate.editorState === state ? { retainedContentReferences: retained } : {});
  };
  if (typeof globalThis.requestIdleCallback === 'function') {
    const id = globalThis.requestIdleCallback(run, { timeout: 1000 });
    historySweeps.set(key, () => globalThis.cancelIdleCallback(id));
  } else {
    const timer = setTimeout(run, 250);
    historySweeps.set(key, () => clearTimeout(timer));
  }
}
function flush(inputChanged = false) {
  if (!pending.size) return;
  const drafts = Object.values(useThreadDraftStore.getState().drafts);
  for (const [ref, request] of pending) {
    if (request.sending || request.host !== getRuntimeEndpointGeneration() || inputChanged && !request.waitingForInput) continue;
    // The editor can change while its captured submission is still in flight.
    // Keep that original snapshot until admission succeeds or is explicitly rejected.
    if (composerClipboardReferences().some(reference => reference.ref === ref) || drafts.some(draft => referencesInDraft(draft).some(reference => reference.ref === ref) || [draft.pendingInput, ...Object.values(draft.interactionSends ?? {}).map(send => send.pending)].some(input => input?.input.text.includes(ref)))) { request.waitingForInput = true; continue; }
    request.waitingForInput = false;
    request.sending = true;
    void Promise.resolve().then(() => createInteractiveUiHttpAPI(request.host).releaseSelection(request.identity, ref)).then(() => {
      if (pending.get(ref) === request) pending.delete(ref);
    }, () => { request.sending = false; });
  }
}
useThreadDraftStore.subscribe((next, previous) => {
  for (const key of new Set([...Object.keys(next.drafts), ...Object.keys(previous.drafts)])) if (next.drafts[key] !== previous.drafts[key]) scheduleHistorySweep(key, next.drafts[key]);
  const retained = new Set(Object.values(next.drafts).flatMap(draft => referencesInDraft(draft)).map(reference => reference.ref));
  for (const reference of Object.values(previous.drafts).flatMap(draft => referencesInDraft(draft))) if (!retained.has(reference.ref)) releaseUiSelection(reference);
  flush(true);
});
subscribeComposerClipboard(previous => {
  const retained = new Set(composerClipboardReferences().map(reference => reference.ref));
  for (const reference of previous) if (!retained.has(reference.ref)) releaseUiSelection(reference);
  flush(true);
});
subscribeRuntimeEndpointWillChange(() => { pending.clear(); for (const cancel of historySweeps.values()) cancel(); historySweeps.clear(); sweptHistories.clear(); });
export const retryUiSelectionReleases = () => flush();

/** Discard only the draft root. The Host retains references still owned by accepted inputs. */
export function releaseUiSelection(reference: ContentReference | undefined, host = getRuntimeEndpointGeneration()): void {
  if (reference?.source.kind !== 'ui' || !reference.ref.startsWith('ui-selection:')) return;
  const identity = reference.source.thread;
  if (!identity) return;
  if (!pending.has(reference.ref)) pending.set(reference.ref, { identity, host });
  flush();
}
