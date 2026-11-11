import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadModel, type ThreadSubmit } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { threadComposerKey, useThreadStore } from '@/stores/useThreadStore';
import { deliverThreadInput } from './threadInputDelivery';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';

/** A peripheral action uses the same native draft/receipt path as the composer. */
export async function submitThreadPrompt(identity: ThreadIdentity, text: string, model?: ThreadModel, directory?: string, goalObjective?: string): Promise<void> {
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!api) throw new Error('Thread execution is unavailable');
  const owner = getRuntimeEndpointGeneration();
  const key = threadComposerKey(useThreadStore.getState().hostKey, identity);
  const draft = useThreadDraftStore.getState();
  const previous = draft.drafts[key];
  if (previous?.firstSend) throw new Error('Resolve the first message before sending another request');
  let selectedModel = model ?? previous?.model;
  if (!selectedModel) {
    const settings = await createModelConnectionsHttpAPI(owner).readSettings(previous?.sourceSelection?.resourceOwner.kind === 'managed_host' ? undefined : directory, undefined, previous?.projectId);
    const effective = { ...settings.global, ...(settings.projectTrusted ? settings.project : {}) };
    if (typeof effective.defaultProvider === 'string' && typeof effective.defaultModel === 'string') {
      selectedModel = { providerId: effective.defaultProvider, modelId: effective.defaultModel };
    }
  }
  if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
  if (!selectedModel) throw new Error('Select a model before sending this request');
  const fingerprint = JSON.stringify([text, selectedModel, directory, goalObjective]);
  let input: ThreadSubmit;
  if (previous?.pendingInput) {
    if (previous.pendingInput.kind !== 'submit' || previous.pendingInput.fingerprint !== fingerprint) throw new Error('Resolve the pending input before sending a different request');
    input = previous.pendingInput.input;
  } else {
    draft.patch(key, { text, model: selectedModel, ...(directory ? { workspacePath: directory } : {}) });
    const snapshot = await api.snapshot(identity);
    if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
    if (snapshot.activeRun && !['completed', 'failed', 'cancelled'].includes(snapshot.activeRun.state)) throw new Error('This conversation has active work; send from its composer to choose queue or interrupt');
    let prepared = previous?.preparedSource;
    const selected = previous?.sourceSelection ?? (directory ? { resourceOwner: { kind: 'local' as const }, path: directory,
      mode: 'live_root' as const, contentMode: 'saved-files' as const, captureScopes: [] } : undefined);
    if (selected && !prepared) {
      if (selected.contentMode !== 'saved-files') throw new Error('Send from the composer to capture the selected editor drafts');
      const selection = 'selection' in selected ? selected.selection : undefined;
      const workspace = selection?.mode === 'native_workspace'
        ? { resourceOwner: selected.resourceOwner, workspaceId: selection.workspaceId }
        : await api.sources.resolve(identity, { resourceOwner: selected.resourceOwner, path: selected.path });
      if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
      if ('expectedWorkspaceId' in selected && selected.expectedWorkspaceId && selected.expectedWorkspaceId !== workspace.workspaceId) {
        throw new Error('The original project workspace has changed. Choose the source again before sending.');
      }
      prepared = await api.prepareSource({ ...identity, key: crypto.randomUUID(), resourceOwner: workspace.resourceOwner,
        workspaceId: workspace.workspaceId, mode: selected.mode, content: { mode: 'saved-files' }, captureScopes: selected.captureScopes,
        ...(selection ? { selection } : {}) });
      draft.patch(key, { preparedSource: prepared });
    }
    if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
    input = { ...identity, key: crypto.randomUUID(), expectedHead: snapshot.historyPage.head, text, model: selectedModel, ...(prepared ? { source: prepared.source } : {}) };
  }
  const pending = previous?.pendingInput ?? { kind: 'submit' as const, fingerprint, editorText: text, ...(goalObjective ? { goalObjective } : {}), status: 'sending' as const, input };
  draft.patch(key, { pendingInput: pending });
  await deliverThreadInput(api, pending, pendingInput => {
    draft.patch(key, current => current.pendingInput?.input.key === input.key ? { pendingInput } : {});
  });
  draft.patch(key, current => ({ text: current.text === text ? '' : current.text, pendingInput: current.pendingInput?.input.key === input.key ? undefined : current.pendingInput, preparedSource: current.pendingInput?.input.key === input.key ? null : current.preparedSource }));
}
