import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { piSessionContextUsage } from '@/lib/pi-runtime/sessionStats';
import { piSessionTitle } from '@/components/pi-session/sessionPresentation';
import { useI18n } from '@/lib/i18n';

/** Session statistics stay in the Agent column, without subscribing the editor shell to streaming updates. */
export function IdeSessionHeader({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { sessionId, snapshot, stats, summary } = usePiSessionStore(useShallow(state => {
    const id = state.currentSessionId;
    const record = id ? state.records[id] : undefined;
    return { sessionId: id, snapshot: record?.snapshot, stats: record?.stats, summary: state.summaries.find(item => item.id === id) };
  }));
  const refreshStats = usePiSessionStore(state => state.refreshStats);
  const busy = Boolean(snapshot?.busy || snapshot?.isStreaming || snapshot?.isCompacting || snapshot?.retryAttempt);
  React.useEffect(() => {
    if (sessionId && !busy) void refreshStats(sessionId).catch(() => undefined);
  }, [sessionId, snapshot?.leafId, busy, refreshStats]);
  const usage = piSessionContextUsage(stats, snapshot);
  const title = summary ? piSessionTitle(summary, t('sessions.sidebar.session.untitled')) : 'Varin';
  return <div className="ide-agent-header flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <span className="min-w-0 flex-1 truncate typography-ui-label font-medium" title={title}>{title}</span>
    {usage && usage.totalTokens > 0 ? <ContextUsageDisplay
      totalTokens={usage.totalTokens}
      percentage={usage.contextLimit > 0 ? usage.totalTokens / usage.contextLimit * 100 : 0}
      colorPercentage={usage.percentage}
      contextLimit={usage.contextLimit}
      outputLimit={usage.outputLimit ?? 0}
      size="compact" hideIcon
      className="shrink-0" valueClassName="text-foreground tabular-nums"
    /> : null}
    {children}
  </div>;
}
