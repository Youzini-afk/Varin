import { getRuntimeEndpointGeneration, ThreadRequestError, type ThreadsAPI } from '@varin/application-client';
import type { ThreadPendingInput } from '@/stores/useThreadDraftStore';
import { observeMessageTime } from '@varin/protocol';

const deliveries = new Map<string, Promise<string | undefined>>();
/** Reopening the view while a send is still in flight joins its original observation. */
export function deliverThreadInput(api: ThreadsAPI, original: ThreadPendingInput, update: (pending: ThreadPendingInput | undefined) => void): Promise<string | undefined> {
  const key = JSON.stringify([getRuntimeEndpointGeneration(), original.input.threadId, original.input.branchId, original.input.key]);
  const existing = deliveries.get(key);
  if (existing) return existing;
  if (!original.input.clientTime) {
    original = { ...original, input: { ...original.input, clientTime: observeMessageTime() } } as ThreadPendingInput;
    update(original);
  }
  const delivery = deliver(api, original, update);
  deliveries.set(key, delivery);
  const settled = () => { if (deliveries.get(key) === delivery) deliveries.delete(key); };
  void delivery.then(settled, settled);
  return delivery;
}

/** A failed observation is not a rejected input. Only the sending owner's explicit
 * pre-admission result can release a first attempt; earlier uncertainty remains sticky. */
async function deliver(api: ThreadsAPI, original: ThreadPendingInput, update: (pending: ThreadPendingInput | undefined) => void): Promise<string | undefined> {
  let pending = original;
  try {
    if (pending.kind === 'enqueue') return (await api.enqueue(pending.input)).input_id;
    else if (pending.kind === 'continue') return (await api.collaboration!.continueChild(pending.input)).receipt?.input_id;
    else {
      if (!pending.acceptedRunId) {
        const receipt = await api.submit(pending.input);
        pending = { ...pending, acceptedRunId: receipt.run_id, acceptedInputId: receipt.input_id };
        // Persist the accepted identity before the separate Goal action can fail or unmount.
        update(pending);
      }
      if (pending.goalObjective) await api.goals.start({ runtime: pending.input.runtime, threadId: pending.input.threadId,
        branchId: pending.input.branchId, runId: pending.acceptedRunId!, key: `${pending.input.key}:goal`, objective: pending.goalObjective,
        budget: pending.goalBudget === undefined ? null : { maxOutputTokens: pending.goalBudget } });
      return pending.acceptedInputId;
    }
  } catch (error) {
    const rejected = original.status !== 'unknown' && !(pending.kind === 'submit' && pending.acceptedRunId)
      && error instanceof ThreadRequestError && error.admission === 'not_started';
    update(rejected ? undefined : { ...pending, status: 'unknown' });
    throw error;
  }
}
