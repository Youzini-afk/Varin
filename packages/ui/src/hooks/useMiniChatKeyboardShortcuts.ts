import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { threadIdentityKey, useThreadStore } from '@/stores/useThreadStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';

export const useMiniChatKeyboardShortcuts = () => {
  const overrides = useUIStore(state => state.shortcutOverrides);
  React.useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const matches = (id: string) => eventMatchesShortcut(event, getEffectiveShortcutCombo(id, overrides));
      if (matches('focus_input')) { event.preventDefault(); focusChatInput(); return; }
      if (matches('new_chat')) { event.preventDefault(); void startThreadFromNavigation().then(focusChatInput); return; }
      if (matches('new_mini_chat') && canUseElectronDesktopIPC()) {
        event.preventDefault(); void invokeDesktop('desktop_open_draft_mini_chat_window', { directory: useDirectoryStore.getState().currentDirectory || '' }); return;
      }
      const forward = matches('cycle_favorite_model_forward'); const backward = matches('cycle_favorite_model_backward');
      const thinking = matches('cycle_thinking_variant');
      if (!forward && !backward && !thinking) return;
      const { selectedIdentity, hostKey } = useThreadStore.getState(); const api = getRegisteredRuntimeAPIs()?.threads;
      if (!selectedIdentity || !api) return;
      event.preventDefault();
      void api.listModels().then(models => {
        if (hostKey !== useThreadStore.getState().hostKey) return;
        const key = threadIdentityKey(hostKey, selectedIdentity); const draft = useThreadDraftStore.getState().drafts[key] ?? EMPTY_THREAD_DRAFT;
        const current = draft.model ?? models[0]; if (!current) return;
        if (thinking) {
          const levels = models.find(model => model.providerId === current.providerId && model.modelId === current.modelId)?.thinkingLevels ?? [];
          if (levels.length) useThreadDraftStore.getState().patch(key, { model: { ...current, thinkingLevel: levels[(levels.indexOf(current.thinkingLevel ?? 'off') + 1) % levels.length] } });
        } else {
          const favorites = useUIStore.getState().favoriteModels.flatMap(favorite => models.filter(model => model.providerId === favorite.providerID && model.modelId === favorite.modelID));
          if (!favorites.length) return;
          const index = favorites.findIndex(model => model.providerId === current.providerId && model.modelId === current.modelId);
          useThreadDraftStore.getState().patch(key, { model: favorites[(index + (forward ? 1 : -1) + favorites.length) % favorites.length] });
        }
      }).catch(error => console.warn('Could not update the draft model', error));
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [overrides]);
};
