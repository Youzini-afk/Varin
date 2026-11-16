import { createContext } from 'react';
import type { BotSummary, ThreadIdentity } from '@varin/application-client';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { BOT_CONVERSATION_PANEL_SCOPE } from './openConversationTree';

export const CONVERSATION_TOOL_MODES = ['tree', 'threads', 'context', 'activity', 'recovery', 'ui'] as const;
/** The shell supplies placement; the mounted conversation still owns its data and actions. */
export const ConversationToolsContext = createContext<{
  identity: ThreadIdentity | null;
  mode?: ContextPanelMode;
  active?: boolean;
  target: HTMLElement | null;
  bots: readonly BotSummary[];
  bot?: BotSummary;
} | null>(null);

export function openBotConversationTools(mode: ContextPanelMode = 'activity') {
  useUIStore.getState().openContextPanelTab(BOT_CONVERSATION_PANEL_SCOPE, { mode });
}

export function toggleBotConversationTools() {
  const state = useUIStore.getState();
  const panel = state.contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE];
  const active = panel?.tabs.find(tab => tab.id === panel.activeTabId);
  if (active && CONVERSATION_TOOL_MODES.some(mode => mode === active.mode)) state.toggleContextPanel(BOT_CONVERSATION_PANEL_SCOPE);
  else openBotConversationTools('tree');
}
