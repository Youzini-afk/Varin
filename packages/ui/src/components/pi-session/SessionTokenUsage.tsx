import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

const METRICS = [
  ['input', 'contextSidebar.tokens.input'],
  ['output', 'contextSidebar.tokens.output'],
  ['cacheRead', 'contextSidebar.tokens.cacheRead'],
  ['cacheWrite', 'contextSidebar.tokens.cacheWrite'],
] as const;

export function SessionTokenUsage() {
  const { t } = useI18n();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const rows = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId]?.stats?.usageByModel : undefined
  ));
  const format = (value: number) => value.toLocaleString(getCurrentIntlLocale());
  const total = rows?.reduce((sum, row) => sum + row.tokens.total, 0) ?? 0;

  return (
    <section className="px-4 py-3" aria-label={t('header.services.sessionUsage')}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="typography-ui-header font-semibold text-foreground">{t('header.services.sessionUsage')}</h3>
        {rows && rows.length > 0 ? (
          <span className="whitespace-nowrap typography-ui-label tabular-nums text-muted-foreground">{format(total)} tokens</span>
        ) : null}
      </div>
      {!sessionId || rows?.length === 0 ? (
        <p className="py-3 typography-ui-label text-muted-foreground">{t('header.services.noSessionUsage')}</p>
      ) : !rows ? (
        <p className="py-3 typography-ui-label text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={JSON.stringify([row.provider, row.model])} className="rounded-lg bg-[var(--surface-muted)] p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="break-words typography-ui-label font-medium text-foreground">
                    {row.model ?? t('header.services.unattributedUsage')}
                  </div>
                  {row.provider ? <div className="break-words typography-micro text-muted-foreground">{row.provider}</div> : null}
                </div>
                <span className="shrink-0 typography-ui-label tabular-nums text-muted-foreground">
                  {t('contextSidebar.tokens.total')} {format(row.tokens.total)}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 typography-ui-label">
                {METRICS.map(([key, label]) => (
                  <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <dt className="text-muted-foreground">{t(label)}</dt>
                    <dd className="tabular-nums text-foreground">{format(row.tokens[key])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
