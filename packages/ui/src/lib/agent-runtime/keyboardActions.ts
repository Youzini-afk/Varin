import { getRuntimeEndpointGeneration, type ThreadModel } from '@varin/application-client';
import { useThreadStore, selectedComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useUIStore } from '@/stores/useUIStore';

export async function cycleThreadModel(direction?: -1 | 1): Promise<void> {
  const identity = useThreadStore.getState().selectedIdentity;
  const draftKey = selectedComposerKey(useThreadStore.getState());
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!draftKey || !api) return;
  const host = getRuntimeEndpointGeneration();
  const [snapshot, models] = await Promise.all([identity ? api.snapshot(identity) : null, api.listModels()]);
  if (host !== getRuntimeEndpointGeneration() || selectedComposerKey(useThreadStore.getState()) !== draftKey) return;
  const draft = useThreadDraftStore.getState().drafts[draftKey];
  if (draft?.firstSend) return;
  const run = snapshot?.activeRun;
  const config = (snapshot?.modelSelection.desired?.configuration ?? run?.configuration) as { providerId?: string; model?: string; thinkingLevel?: ThreadModel['thinkingLevel']; catalogModelId?: string } | undefined;
  const current = run && config?.providerId && config.model ? { providerId: config.providerId, modelId: config.catalogModelId ?? config.model, thinkingLevel: config.thinkingLevel } : draft?.model;
  let model: ThreadModel | undefined;
  if (direction) {
    const favorites = useUIStore.getState().favoriteModels;
    const available = favorites.flatMap(favorite => models.filter(model => model.providerId === favorite.providerID && model.modelId === favorite.modelID));
    if (!available.length) return;
    const index = available.findIndex(model => model.providerId === current?.providerId && model.modelId === current.modelId);
    const base = index === -1 ? (direction > 0 ? -1 : 0) : index;
    model = available[(base + direction + available.length) % available.length];
  } else {
    if (!current) return;
    const levels = models.find(model => model.providerId === current.providerId && model.modelId === current.modelId)?.thinkingLevels ?? [];
    if (!levels.length) return;
    model = { ...current, thinkingLevel: levels[(levels.indexOf(current.thinkingLevel ?? 'off') + 1) % levels.length] };
  }
  if (run && identity) await api.selectModel({ ...identity, runId: run.id, key: crypto.randomUUID(), model });
  else useThreadDraftStore.getState().patch(draftKey, { model });
}
export async function cancelSelectedThreadRun(): Promise<void> {
  const identity = useThreadStore.getState().selectedIdentity;
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!identity || !api) return;
  const host = getRuntimeEndpointGeneration();
  const snapshot = await api.snapshot(identity);
  if (host !== getRuntimeEndpointGeneration() || useThreadStore.getState().selectedIdentity !== identity) return;
  if (snapshot.activeRun) await api.cancelRun(snapshot.activeRun.id);
}
