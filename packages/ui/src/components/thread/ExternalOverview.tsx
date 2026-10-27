import React from 'react';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { useI18n } from '@/lib/i18n';
import { summarizePlan } from '@/lib/planSummary';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ChildState } from '@/components/conversation/childPresentation';
import { WorkOverviewControl } from './WorkOverviewControl';
import { Icon } from '@/components/icon/Icon';

export const ExternalOverview = React.memo(function ExternalOverview({
  id,
  status,
  planText,
  cwd,
  connected,
}: {
  id: string;
  status?: string;
  planText?: string;
  cwd: string;
  connected: boolean;
}) {
  const { t } = useI18n();
  const open = useWorkOverviewStore((state) => state.bySession[id]?.overview ?? false);
  const compact = useWorkOverviewStore((state) => state.bySession[id]?.compact ?? false);
  const disclosure = useWorkOverviewStore((state) => state.setDisclosure);
  const [detail, setDetail] = React.useState(false);
  const plan = React.useMemo(() => summarizePlan(planText ?? ''), [planText]);
  const state = (
    <div className="py-2 typography-meta">
      {status ? <ChildState state={status} /> : t(connected ? 'external.connected' : 'external.disconnected')}
    </div>
  );
  const preview = plan.total ? (
    <button
      className="w-full py-2 text-left typography-meta"
      type="button"
      onClick={() => {
        setDetail(true);
        disclosure(id, 'overview', true);
        disclosure(id, 'compact', false);
      }}
    >
      <span className="mb-3 flex items-center justify-between font-medium">
        <span>{t('harness.overview.plan')}</span>
        <span className="typography-micro font-normal tabular-nums text-muted-foreground">
          {plan.done}/{plan.total}
        </span>
      </span>
      {plan.items.slice(0, 3).map((item, index) => (
        <span key={index} className="mb-2 flex gap-2">
          <Icon
            name={item.status === 'completed' ? 'check' : 'checkbox-blank-circle'}
            className="mt-1 size-3 shrink-0 text-muted-foreground"
          />
          <span className="line-clamp-2 min-w-0 break-words">{item.text}</span>
        </span>
      ))}
    </button>
  ) : null;
  return (
    <WorkOverviewControl
      open={open}
      compactOpen={compact}
      attention={status === 'waiting_user' || status === 'failed' || status === 'interrupted'}
      rows={[]}
      onOpenChange={(value) => {
        disclosure(id, 'overview', value);
        if (value) setDetail(false);
      }}
      onCompactChange={(value) => disclosure(id, 'compact', value)}
      onSelect={() => setDetail(true)}
      status={state}
      compactContent={preview}
      detailTitle={detail ? t('harness.overview.plan') : undefined}
      onBack={() => setDetail(false)}
    >
      {detail ? (
        <MarkdownRenderer content={planText ?? ''} messageId={`external-plan:${id}`} variant="tool" />
      ) : (
        <>
          {state}
          {preview}
          <div className="mt-4 flex min-w-0 items-start gap-2 border-t border-border/50 pt-3 typography-micro text-muted-foreground">
            <Icon name="folder" className="size-3.5 shrink-0" />
            <span className="min-w-0 break-all">{cwd}</span>
          </div>
        </>
      )}
    </WorkOverviewControl>
  );
});
