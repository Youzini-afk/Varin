import { getRuntimeEndpointGeneration, registerRuntimeEndpointSwitchBlocker, type ThreadIdentity, type ThreadPrepareSource, type ThreadsAPI } from '@varin/application-client';
import { useThreadStore } from '@/stores/useThreadStore';
import { useThreadDraftStore, type ThreadFirstSend, type ThreadPendingInput } from '@/stores/useThreadDraftStore';
import { acknowledgeEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { getDocumentRegistry } from '@/lib/documents/session';
import { deliverThreadInput } from './threadInputDelivery';

const sending = new Map<string, Promise<string | undefined>>();
type Preparation = { input: ThreadPrepareSource; release?: () => Promise<void>; unsubscribe?: () => void };
const preparations = new Map<string, Preparation>();

/** An explicit first send owns creation and preparation, even if its composer is no longer mounted. */
export function sendThreadDraft(api: ThreadsAPI, draftKey: string, request: ThreadFirstSend): Promise<string | undefined> {
  const epoch = getRuntimeEndpointGeneration();
  const deliveryKey = JSON.stringify([epoch, draftKey, request.key]);
  const existing = sending.get(deliveryKey);
  if (existing) return existing;
  const assertHost = () => { if (epoch !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while sending the conversation'); };
  const patch = (update: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) => useThreadDraftStore.getState().patch(draftKey, update);
  const read = () => useThreadDraftStore.getState().drafts[draftKey];
  const releasePreparation = async () => {
    const prepared = preparations.get(deliveryKey);
    if (!prepared) return;
    await prepared.release?.(); prepared.unsubscribe?.(); preparations.delete(deliveryKey);
  };
  const prepare = async (identity: ThreadIdentity) => {
    const selected = request.sourceSelection ?? (request.workspacePath ? { path: request.workspacePath,
      resourceOwner: { kind: 'local' as const }, mode: 'live_root' as const, contentMode: 'saved-files' as const, captureScopes: [] } : undefined);
    if (!selected?.path.trim()) return null;
    let pending = preparations.get(deliveryKey);
    if (!pending) {
      const source = await api.sources.resolve(identity, { resourceOwner: selected.resourceOwner, path: selected.path });
      assertHost();
      let content: ThreadPrepareSource['content'] = { mode: 'saved-files' };
      let release: (() => Promise<void>) | undefined;
      if (selected.mode !== 'live_root' && selected.contentMode === 'surface-drafts') {
        if (source.resourceOwner.kind !== 'local') throw new Error('Editor drafts belong to this Host');
        const registry = getDocumentRegistry();
        const consumer = { kind: 'thread' as const, threadId: identity.threadId, branchId: identity.branchId };
        const context = await registry.captureAgentInputContext(consumer, source.workspaceId);
        release = () => registry.releaseAgentInputContext(consumer, context);
        if (epoch !== getRuntimeEndpointGeneration() || context.source === 'surface' && context.snapshot.status !== 'ready') {
          await release(); assertHost(); throw new Error('Editor drafts could not be captured');
        }
        content = { mode: 'surface-drafts', context };
      }
      pending = { input: { ...identity, key: `${request.key}:source`, resourceOwner: source.resourceOwner,
        workspaceId: source.workspaceId, mode: selected.mode, content, captureScopes: selected.captureScopes }, release };
      preparations.set(deliveryKey, pending);
      if (release) pending.unsubscribe = registerRuntimeEndpointSwitchBlocker(releasePreparation);
    }
    const source = await api.prepareSource(pending.input);
    patch({ preparedSource: source });
    await releasePreparation(); assertHost();
    return source;
  };
  patch({ firstSend: { ...request, status: 'sending', error: undefined }, sendError: undefined });
  const task = (async () => {
    try {
      const identity = await useThreadStore.getState().materializeDraft(draftKey);
      assertHost();
      if (!read().pendingInput) {
        const preparedSource = read().preparedSource ?? await prepare(identity);
        assertHost();
        for (const pdf of request.pdfs) {
          if (!read().pdfs?.some(item => item.id === pdf.id)) continue;
          const result = await api.materials.upload(identity, { filename: pdf.filename, mimeType: 'application/pdf', data: pdf.data });
          assertHost();
          const retained = result.status === 'ok' ? result.sourceSnapshot ?? result.snapshot : undefined;
          if (!retained?.snapshotId || retained.document?.kind !== 'pdf') throw new Error('PDF attachment could not be retained');
          const material = { snapshotId: retained.snapshotId, filename: pdf.filename, sourceHash: retained.document.source?.contentHash };
          patch(current => ({ pdfs: current.pdfs?.filter(item => item.id !== pdf.id), materials: [...current.materials,
            material] }));
        }
        const materials = read().materials.map(({ snapshotId }) => ({ snapshotId }));
        const input: ThreadPendingInput = { kind: 'submit', status: 'sending', fingerprint: request.key,
          editorText: request.editorText, editorContext: request.editorContext, inlineContext: request.inlineContext,
          preparedSource, goalObjective: request.goalObjective, goalBudget: request.goalBudget,
          input: { ...identity, key: request.key, expectedHead: null, text: request.text, images: request.images, materials,
            model: request.model, ...(preparedSource ? { source: preparedSource.source } : {}) } };
        patch({ pendingInput: input });
      }
      const original = read().pendingInput!;
      assertHost();
      const acceptedInputId = await deliverThreadInput(api, original, pendingInput => patch({ pendingInput }));
      acknowledgeEditorContextAttachments(original.editorContext ?? [], draftKey);
      for (const bucket of original.inlineContext ?? []) useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, bucket.drafts);
      patch(current => ({ firstSend: undefined, pendingInput: undefined, preparedSource: null,
        firstMessageReceipt: acceptedInputId ? { key: request.key, text: original.input.text, images: request.images, inputId: acceptedInputId } : undefined,
        ...(original.goalObjective ? { goalArmed: false } : {}),
        text: current.text === original.editorText ? '' : current.text,
        images: current.images.filter(image => !request.images.includes(image)),
        materials: current.materials.filter(material => !original.input.materials?.some(item => item.snapshotId === material.snapshotId)),
      }));
      return acceptedInputId;
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : String(failure);
      // Creation uncertainty retains the same key. After known creation, an unsent or
      // explicitly rejected input can be edited; unknown model admission retains its input.
      if (read()?.identity && !read().pendingInput) {
        patch({ firstSend: undefined, sendError: error }); await releasePreparation();
      } else patch({ firstSend: { ...request, status: 'failed', error } });
      throw failure;
    }
  })();
  sending.set(deliveryKey, task);
  void task.finally(() => { if (sending.get(deliveryKey) === task) sending.delete(deliveryKey); }).catch(() => {});
  return task;
}
