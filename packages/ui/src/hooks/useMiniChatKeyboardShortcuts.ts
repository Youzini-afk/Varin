import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { cycleThreadModel } from '@/lib/agent-runtime/keyboardActions';
import { toast } from '@/components/ui';

export const useMiniChatKeyboardShortcuts = () => {
  const overrides = useUIStore(state => state.shortcutOverrides);
  React.useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const matches = (id: string) => eventMatchesShortcut(event, getEffectiveShortcutCombo(id, overrides));
      if (matches('focus_input')) { event.preventDefault(); focusChatInput(); return; }
      if (matches('open_model_selector')) { event.preventDefault(); useUIStore.getState().setModelSelectorOpen(!useUIStore.getState().isModelSelectorOpen); return; }
      if (matches('expand_input')) { event.preventDefault(); useUIStore.getState().toggleExpandedInput(); return; }
      if (matches('new_chat')) { event.preventDefault(); void startThreadFromNavigation().then(focusChatInput); return; }
      if (matches('new_mini_chat') && canUseElectronDesktopIPC()) {
        event.preventDefault(); void invokeDesktop('desktop_open_draft_mini_chat_window', { directory: useDirectoryStore.getState().currentDirectory || '' }); return;
      }
      const forward = matches('cycle_favorite_model_forward'); const backward = matches('cycle_favorite_model_backward');
      const thinking = matches('cycle_thinking_variant');
      if (!forward && !backward && !thinking) return;
      event.preventDefault();
      void cycleThreadModel(thinking ? undefined : forward ? 1 : -1).catch(error => toast.error(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [overrides]);
};
