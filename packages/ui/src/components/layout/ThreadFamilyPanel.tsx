import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadFamily } from '@/components/thread/ThreadFamily';
export function ThreadFamilyPanel() {
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  return identity && api?.family ? <ThreadFamily api={api.family} mediaRead={api.mediaRead} identity={identity} observe={api.observe} /> : <p className="p-4 text-sm">Open a conversation to browse its task family.</p>;
}
