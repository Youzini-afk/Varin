import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadIdentity } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore, threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { ThreadMaterials } from '@/components/thread/ThreadMaterials';
import { MaterialSnapshotReader } from '@/components/conversation/ChatMaterialsTool';

export function MaterialReaderPanel({ identity, snapshotId, title, line, onClose, readOnly }: {
  identity: ThreadIdentity; snapshotId: string; title: string; line?: number; onClose(): void; readOnly: boolean;
}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const api = useRuntimeAPIs().threads?.materials;
  const selected = useThreadStore(state => state.selectedIdentity);
  const draftKey = threadComposerKey(threadHostKey(), identity);
  const reader = React.useMemo(() => api ? { api, identity } : undefined, [api, identity]);
  if (!api || !reader) return null;
  const quote = !readOnly && selected?.threadId === identity.threadId && selected.branchId === identity.branchId ? (text: string) => {
    const current = useThreadStore.getState().selectedIdentity;
    if (host !== getRuntimeEndpointGeneration() || current?.threadId !== identity.threadId || current.branchId !== identity.branchId) return;
    useThreadDraftStore.getState().patch(draftKey, draft => ({ text: [draft.text, text.split('\n').map(line => '> ' + line).join('\n'), ''].filter(Boolean).join('\n\n') }));
  } : undefined;
  return <div className="tool-material-panel h-full overflow-auto p-4"><ThreadMaterials api={api} identity={identity}>
    <MaterialSnapshotReader key={JSON.stringify([host, identity.threadId, identity.branchId, snapshotId, line])} reader={reader} snapshotId={snapshotId} title={title} line={line} onClose={onClose} onQuote={quote} />
  </ThreadMaterials></div>;
}
