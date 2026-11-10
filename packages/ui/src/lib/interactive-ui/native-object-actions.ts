import { nativeObjectLabel as t } from './native-object-labels';
import React from 'react';
import { getRuntimeKey } from '@varin/application-client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { captureFileQuote } from '@/components/conversation/captureFileQuote';
import { getRuntimeEndpointGeneration, type ContentReference } from '@varin/application-client';
import { useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { useThreadStore } from '@/stores/useThreadStore';
import { useThreadContextUsageStore, contextUsageKey } from '@/stores/useThreadContextUsageStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { resolveNativeObject } from './native-objects';
/** The opener only dispatches to existing conversation-local owners and navigation. */
export function useNativeObjectOpener() {
  const conversation = useOptionalConversationPresentation();
  const material = React.useContext(MaterialLinkContext);
  return React.useCallback(async (ref: string): Promise<void> => {
    if (!conversation) throw new Error(t('ui.native.ownerUnavailable'));
    const host = getRuntimeEndpointGeneration();
    const plan = ref.startsWith('plan:') && conversation.api.plan ? await conversation.api.plan.read(conversation.identity) : undefined;
    if (host !== getRuntimeEndpointGeneration()) throw new Error(t('ui.native.connectionChanged'));
    const object = resolveNativeObject(ref, { snapshot: conversation.snapshot, threads: useThreadStore.getState().threads, plan,
      usage: useThreadContextUsageStore.getState().views[contextUsageKey(conversation.identity)]?.usage });
    if (object.kind === 'unavailable') throw new Error(object.title);
    if (object.kind === 'thread') { await openThreadFromNavigation(object); return; }
    if (object.kind === 'file') { await conversation.openFile(object.callId, object.path); return; }
    if (object.kind === 'material') { if (!material) throw new Error(t('ui.native.materialUnavailable')); material(object.ref, object.title); return; }
    if (!conversation.openSection) throw new Error(t('ui.native.detailsUnavailable'));
    conversation.openSection(object.section);
  }, [conversation, material]);
}
export function useNativeObjectActions() {
  const apis = React.useContext(RuntimeAPIContext);
  const open = useNativeObjectOpener();
  const conversation = useOptionalConversationPresentation();
  const reference = React.useCallback(async (ref: string): Promise<ContentReference> => {
    if (!conversation) throw new Error(t('ui.native.ownerUnavailable'));
    const host = getRuntimeEndpointGeneration();
    const plan = ref.startsWith('plan:') && conversation.api.plan ? await conversation.api.plan.read(conversation.identity) : undefined;
    const object = resolveNativeObject(ref, { snapshot: conversation.snapshot, threads: useThreadStore.getState().threads, plan,
      usage: useThreadContextUsageStore.getState().views[contextUsageKey(conversation.identity)]?.usage });
    if (object.kind === 'unavailable') throw new Error(object.title);
    // Only a resolved file owner may confer a readable file reference; paths alone are not evidence.
    if (object.kind === 'file') {
      if (!apis) throw new Error(t('ui.native.ownerUnavailable'));
      return captureFileQuote({ path: object.path, runtimeKey: getRuntimeKey(),
        open: () => conversation.openFile(object.callId, object.path),
        resolve: async () => {
          const target = await conversation.fileTarget(object.callId, object.path);
          return { path: workspacePathFromResourceId(target.root, target.resourceId), directory: target.root,
            resource: { workspaceId: target.workspaceId, resourceId: target.resourceId } };
        } }, conversation.identity, apis.files, conversation.api.attachments);
    }
    if (host !== getRuntimeEndpointGeneration()) throw new Error(t('ui.native.connectionChanged'));
    const capturedAt = new Date().toISOString();
    const state = 'state' in object ? object.state : undefined;
    return { ref: `object-selection:${crypto.randomUUID()}`, title: object.title,
      text: [object.title, state].filter(Boolean).join('\n'),
      source: { kind: 'object', thread: { ...conversation.identity }, objectRef: ref, capturedAt, ...(state ? { state } : {}) } };
  }, [apis, conversation]);
  return { open, reference };
}
