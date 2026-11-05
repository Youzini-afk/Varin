import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ContentReference, type ThreadIdentity } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';

const pending = new Map<string, { identity: ThreadIdentity; host: number; sending?: boolean; waitingForInput?: boolean }>();
function flush(inputChanged = false) {
  if (!pending.size) return;
  const drafts = Object.values(useThreadDraftStore.getState().drafts);
  for (const [ref, request] of pending) {
    if (request.sending || request.host !== getRuntimeEndpointGeneration() || inputChanged && !request.waitingForInput) continue;
    // The editor can change while its captured submission is still in flight.
    // Keep that original snapshot until admission succeeds or is explicitly rejected.
    if (drafts.some(draft => [draft.pendingInput, ...Object.values(draft.interactionSends ?? {}).map(send => send.pending)]
      .some(input => input?.input.text.includes(ref)))) { request.waitingForInput = true; continue; }
    request.waitingForInput = false;
    request.sending = true;
    void Promise.resolve().then(() => createInteractiveUiHttpAPI(request.host).releaseSelection(request.identity, ref)).then(() => {
      if (pending.get(ref) === request) pending.delete(ref);
    }, () => { request.sending = false; });
  }
}
useThreadDraftStore.subscribe(() => flush(true));
subscribeRuntimeEndpointWillChange(() => pending.clear());
export const retryUiSelectionReleases = () => flush();

/** Discard only the draft root. The Host retains references still owned by accepted inputs. */
export function releaseUiSelection(reference: ContentReference | undefined, host = getRuntimeEndpointGeneration()): void {
  if (reference?.source.kind !== 'ui' || !reference.ref.startsWith('ui-selection:')) return;
  const identity = reference.source.thread;
  if (!identity) return;
  if (!pending.has(reference.ref)) pending.set(reference.ref, { identity, host });
  flush();
}
