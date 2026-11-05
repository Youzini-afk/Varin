import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadPlanAPI, type ThreadPlanState } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';

type State = { plan?: ThreadPlanState; error?: string };
/** One read/event subscription per plan owner, never one polling loop per inline row. */
export function createNativePlanObservation(api: ThreadPlanAPI, identity: ThreadIdentity, host: number) {
  let state: State = {}, generation = 0, stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const refresh = async () => {
    const request = ++generation;
    try {
      const plan = await api.read(identity);
      if (request !== generation || host !== getRuntimeEndpointGeneration()) return;
      if (plan.identity.threadId !== identity.threadId || plan.identity.branchId !== identity.branchId) throw new Error('Plan owner mismatch');
      state = { plan };
    } catch (error) { if (request !== generation || host !== getRuntimeEndpointGeneration()) return; state = { error: error instanceof Error ? error.message : String(error) }; }
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        stop = subscribeVarinEvents(event => {
          if (event.type === 'stream-ready' || event.type === 'plan-changed' && event.threadId === identity.threadId && event.branchId === identity.branchId) void refresh();
        });
      }
      return () => { listeners.delete(listener); if (!listeners.size) { generation++; stop?.(); stop = undefined; } };
    },
  };
}
const owners = new WeakMap<ThreadPlanAPI, Map<string, ReturnType<typeof createNativePlanObservation>>>();
export function nativePlanObservation(api: ThreadPlanAPI, identity: ThreadIdentity, host: number) {
  let entries = owners.get(api); if (!entries) { entries = new Map(); owners.set(api, entries); }
  const key = JSON.stringify([host, identity.threadId, identity.branchId]);
  let entry = entries.get(key);
  if (!entry) { entry = createNativePlanObservation(api, identity, host); entries.set(key, entry); }
  return entry;
}
