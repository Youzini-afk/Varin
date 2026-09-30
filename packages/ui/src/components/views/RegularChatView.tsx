import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { refreshBotSessionIndex, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { ChatView } from './ChatView';

/** Keep the shared Pi selection from mounting a Bot conversation in ordinary shells. */
export const RegularChatView: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18n();
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const index = useBotSessionIndex();

  React.useEffect(() => { void refreshBotSessionIndex(runtimeKey); }, [runtimeKey]);

  if (index.runtimeKey !== runtimeKey || index.loading || (index.ids === null && !index.error)) return null;
  if (index.error) return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center typography-meta">
    <span className="text-destructive">{index.error}</span>
    <Button variant="outline" size="sm" onClick={() => void refreshBotSessionIndex(runtimeKey, true)}>{t('research-workbench.retry')}</Button>
  </div>;
  if (sessionId && index.ids?.has(sessionId)) return null;
  return <ChatView active={active} />;
};
