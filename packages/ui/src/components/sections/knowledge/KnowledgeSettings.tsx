import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_HELPER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useWorkbenchWorkspace } from '@/lib/extensions/workbench-workspace';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import {
  loadKnowledgeCatalog,
  loadKnowledgeChain,
  loadOrganizerStatus,
  retireKnowledgeCatalogItem,
  retryOrganizerScope,
  reviewKnowledgeCatalogItem,
  saveKnowledgeCatalogItem,
  type KnowledgeCatalogChain,
  type KnowledgeCatalogItem,
  type KnowledgeCatalogScope,
  type OrganizerStatus,
} from './knowledgeCatalogRequest';
import { listBots } from '@/lib/bots';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { useHarnessSettings } from '../harness/useHarnessSettings';
import { MemorySources } from './MemorySources';

const statusKey = (item: KnowledgeCatalogItem): I18nKey => (
  item.invalidAt !== undefined
    ? 'settings.knowledge.status.retired'
    : `settings.knowledge.status.${item.status}`
);

const natureKey = (item: KnowledgeCatalogItem): I18nKey => (
  `settings.knowledge.nature.${item.nature ?? 'experience'}`
);

export const KnowledgeSettings: React.FC = () => {
  const { t } = useI18n();
  const workspace = useWorkbenchWorkspace();
  const searchTarget = useSettingsSearchTarget();
  const [scope, setScope] = React.useState<KnowledgeCatalogScope>(searchTarget === 'knowledge.user' ? 'user' : 'workspace');
  const [bots, setBots] = React.useState<Array<{ id: string; name: string }>>([]);
  const [botsError, setBotsError] = React.useState<string | null>(null);
  const [botId, setBotId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [showRetired, setShowRetired] = React.useState(false);
  const harness = useHarnessSettings();
  const [items, setItems] = React.useState<KnowledgeCatalogItem[]>([]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [chain, setChain] = React.useState<KnowledgeCatalogChain | null>(null);
  const [draft, setDraft] = React.useState({ content: '', trigger: '' });
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // The catalog request carries the owner in the workspaceId slot; a Bot's
  // store is addressed by its `bot:<id>` scope id.
  const workspaceId = scope === 'bot'
    ? (botId ? `bot:${botId}` : undefined)
    : workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const contextKey = `${scope}:${workspaceId ?? ''}`;
  const currentContextKey = React.useRef(contextKey);
  currentContextKey.current = contextKey;
  const contextGeneration = React.useRef(0);
  const requestGeneration = React.useRef(0);
  const loadedContextKey = React.useRef<string | null>(null);
  const refreshController = React.useRef<AbortController | null>(null);
  const actionController = React.useRef<AbortController | null>(null);
  const resetContext = React.useCallback(() => {
    contextGeneration.current += 1;
    requestGeneration.current += 1;
    refreshController.current?.abort();
    actionController.current?.abort();
    loadedContextKey.current = null;
    setItems([]);
    setSelectedId(null);
    setChain(null);
    setDraft({ content: '', trigger: '' });
    setBusy(false);
    setLoading(false);
  }, []);
  const selected = loadedContextKey.current === contextKey
    ? items.find((item) => item.id === selectedId) ?? null
    : null;
  const queryNeedle = query.trim().toLowerCase();
  const visible = loadedContextKey.current === contextKey
    ? items.filter((item) => (showRetired || item.invalidAt === undefined)
      && (!queryNeedle
        || item.content.toLowerCase().includes(queryNeedle)
        || item.trigger.toLowerCase().includes(queryNeedle)
        || (item.source?.kind ?? '').toLowerCase().includes(queryNeedle)))
    : [];

  React.useEffect(() => {
    let cancelled = false;
    void listBots().then((rows) => {
      if (cancelled) return;
      const active = rows.filter((bot) => !bot.archived);
      setBots(active.map((bot) => ({ id: bot.id, name: bot.name })));
      setBotsError(null);
      setBotId((current) => current && active.some((bot) => bot.id === current) ? current : active[0]?.id ?? null);
    }).catch((error) => {
      if (!cancelled) {
        setBots([]);
        setBotsError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => { cancelled = true; };
  }, []);

  const refresh = React.useCallback(async () => {
    const requestId = ++requestGeneration.current;
    const generation = contextGeneration.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    if ((scope === 'workspace' && workspace.status !== 'ready') || (scope === 'bot' && !workspaceId)) {
      if (
        generation === contextGeneration.current
        && requestId === requestGeneration.current
        && currentContextKey.current === contextKey
      ) {
        loadedContextKey.current = contextKey;
        setItems([]);
        setSelectedId(null);
        setChain(null);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      const next = await loadKnowledgeCatalog(scope, workspaceId, controller.signal);
      if (
        controller.signal.aborted
        || generation !== contextGeneration.current
        || requestId !== requestGeneration.current
        || currentContextKey.current !== contextKey
      ) return;
      loadedContextKey.current = contextKey;
      setItems(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
    } catch (error) {
      if (
        !controller.signal.aborted
        && generation === contextGeneration.current
        && requestId === requestGeneration.current
        && currentContextKey.current === contextKey
      ) {
        toast.error(error instanceof Error ? error.message : t('settings.knowledge.empty.none'));
      }
    } finally {
      if (
        !controller.signal.aborted
        && generation === contextGeneration.current
        && requestId === requestGeneration.current
        && currentContextKey.current === contextKey
      ) setLoading(false);
    }
  }, [contextKey, scope, t, workspace.status, workspaceId]);

  React.useEffect(() => {
    resetContext();
    void refresh();
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type !== 'harness-knowledge-changed') return;
      if (event.scope !== scope) return;
      if (scope === 'workspace' && event.workspaceId && workspaceId && event.workspaceId !== workspaceId) return;
      // For bot scope the event's workspaceId slot carries the bot id.
      if (scope === 'bot' && event.workspaceId && workspaceId && event.workspaceId !== workspaceId) return;
      void refresh();
    });
    return () => {
      contextGeneration.current += 1;
      requestGeneration.current += 1;
      refreshController.current?.abort();
      actionController.current?.abort();
      unsubscribe();
    };
  }, [refresh, resetContext, scope, workspaceId, botId]);

  React.useEffect(() => {
    if (!selected) {
      setDraft({ content: '', trigger: '' });
      setChain(null);
      return;
    }
    setDraft({ content: selected.content, trigger: selected.trigger });
    const controller = new AbortController();
    void loadKnowledgeChain(selected.scope, selected.id, workspaceId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setChain(next);
    }).catch(() => {
      if (!controller.signal.aborted) setChain(null);
    });
    return () => controller.abort();
  }, [selected, workspaceId]);

  const run = React.useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const generation = contextGeneration.current;
    const controller = new AbortController();
    actionController.current?.abort();
    actionController.current = controller;
    setBusy(true);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted || generation !== contextGeneration.current) return;
      await refresh();
    } catch (error) {
      if (controller.signal.aborted || generation !== contextGeneration.current) return;
      if (error instanceof Error && 'code' in error && error.code === 'conflict') {
        toast.error(t('harness.knowledge.conflict'));
        await refresh();
      } else {
        toast.error(error instanceof Error ? error.message : t('settings.knowledge.empty.none'));
      }
    } finally {
      if (generation === contextGeneration.current) setBusy(false);
      if (actionController.current === controller) actionController.current = null;
    }
  }, [busy, refresh, t]);

  const changeScope = React.useCallback((next: KnowledgeCatalogScope) => {
    if (next === scope) return;
    currentContextKey.current = `${next}:${workspaceId ?? ''}`;
    resetContext();
    setScope(next);
  }, [resetContext, scope, workspaceId]);

  React.useEffect(() => {
    if (searchTarget === 'knowledge.user') changeScope('user');
    if (searchTarget === 'knowledge.workspace') changeScope('workspace');
  }, [searchTarget, changeScope]);

  const autoOrganize = harness.harness?.knowledge.autoOrganize;
  const [organizer, setOrganizer] = React.useState<OrganizerStatus | null>(null);
  const [organizerError, setOrganizerError] = React.useState<string | null>(null);
  const [organizerBusy, setOrganizerBusy] = React.useState(false);

  // Organizer progress belongs to the source scope's own store — workspace or
  // `bot:<id>`. The user scope is a proposal target, never a source, so it
  // has no organizer view.
  React.useEffect(() => {
    if (scope === 'user' || !workspaceId) {
      setOrganizer(null);
      setOrganizerError(null);
      return;
    }
    const controller = new AbortController();
    void loadOrganizerStatus(scope, workspaceId, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) { setOrganizer(status); setOrganizerError(null); }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setOrganizer(null);
          setOrganizerError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, [scope, workspaceId]);

  const reloadOrganizer = React.useCallback(async () => {
    if (scope === 'user' || !workspaceId) return;
    try {
      setOrganizer(await loadOrganizerStatus(scope, workspaceId));
      setOrganizerError(null);
    } catch (error) {
      setOrganizer(null);
      setOrganizerError(error instanceof Error ? error.message : String(error));
    }
  }, [scope, workspaceId]);

  return (
    <>
      <SettingsSection
        title={t(scope === 'workspace'
          ? 'settings.knowledge.section.workspace'
          : scope === 'bot' ? 'settings.knowledge.section.bot' : 'settings.knowledge.section.user')}
        divider={false}
        settingsItem={scope === 'workspace' ? 'knowledge.workspace' : scope === 'bot' ? 'knowledge.bot' : 'knowledge.user'}
        headerAction={(
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant={scope === 'workspace' ? 'secondary' : 'ghost'} size="xs" className="!font-normal" onClick={() => changeScope('workspace')}>
              {t('harness.knowledge.scope.workspace')}
            </Button>
            <Button type="button" variant={scope === 'user' ? 'secondary' : 'ghost'} size="xs" className="!font-normal" onClick={() => changeScope('user')}>
              {t('harness.knowledge.scope.user')}
            </Button>
            <Button type="button" variant={scope === 'bot' ? 'secondary' : 'ghost'} size="xs" className="!font-normal" onClick={() => changeScope('bot')} disabled={bots.length === 0}>
              {t('harness.knowledge.scope.bot')}
            </Button>
            {scope === 'bot' && bots.length > 1 ? (
              <select
                value={botId ?? ''}
                aria-label={t('harness.knowledge.scope.bot')}
                onChange={(event) => {
                  setBotId(event.target.value || null);
                  currentContextKey.current = `bot:${event.target.value || ''}`;
                  resetContext();
                }}
                className="rounded-md border border-border bg-background px-1.5 py-0.5 typography-micro"
              >
                {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            ) : null}
            <input
              value={query}
              aria-label={t('settings.knowledge.search')}
              placeholder={t('settings.knowledge.search')}
              onChange={(event) => setQuery(event.target.value)}
              className="w-40 rounded-md border border-border bg-background px-2 py-0.5 typography-micro"
            />
            <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setShowRetired((value) => !value)}>
              {t(showRetired ? 'settings.knowledge.filter.all' : 'settings.knowledge.filter.current')}
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={loading} onClick={() => void refresh()} className="!font-normal gap-1.5">
              <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t('settings.languageSupport.actions.refresh')}
            </Button>
          </div>
        )}
      >
        {scope === 'workspace' && workspace.status === 'none' ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.empty.noWorkspace')}</p>
        ) : null}
        {scope === 'workspace' && workspace.status === 'error' ? (
          <p className="typography-micro text-[var(--status-error)]">{workspace.errorMessage}</p>
        ) : null}
        {scope === 'bot' && botsError ? (
          <p role="alert" className="typography-micro text-[var(--status-error)]">{botsError}</p>
        ) : null}
        {scope === 'bot' && bots.length === 0 && !botsError ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.empty.noBot')}</p>
        ) : null}
        {visible.length === 0 && (scope === 'user' || workspace.status === 'ready' || (scope === 'bot' && botId)) ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.empty.none')}</p>
        ) : null}
        <div className="grid gap-3 @xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            {visible.map((item) => (
              <button
                key={`${item.scope}:${item.id}`}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${selectedId === item.id ? 'border-primary bg-primary/5' : 'border-border/60'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="typography-micro text-muted-foreground">
                    #{item.id}{item.nature ? ` · ${t(natureKey(item))}` : ''}
                  </span>
                  <span className="typography-micro text-muted-foreground">{t(statusKey(item))}</span>
                </div>
                <p className="mt-1 line-clamp-2 typography-ui text-foreground">{item.content}</p>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
              <SettingsFieldRow label={t('harness.knowledge.content')}>
                <textarea
                  value={draft.content}
                  aria-label={t('harness.knowledge.content')}
                  disabled={busy || selected.invalidAt !== undefined || selected.status === 'dismissed'}
                  onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 typography-ui text-foreground"
                />
              </SettingsFieldRow>
              <SettingsFieldRow label={t('harness.knowledge.trigger')}>
                <input
                  value={draft.trigger}
                  aria-label={t('harness.knowledge.trigger')}
                  disabled={busy || selected.invalidAt !== undefined || selected.status === 'dismissed'}
                  onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 typography-ui text-foreground"
                />
              </SettingsFieldRow>
              <p className={SETTINGS_HELPER_CLASS}>
                {t('settings.knowledge.source')}: {selected.source
                  ? [selected.source.kind, selected.source.sessionId, selected.source.threadId].filter(Boolean).join(' · ')
                  : t('settings.knowledge.source.none')}
                {selected.source?.sessionId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal ml-1"
                    onClick={() => void openPiSessionFromNavigation({ sessionId: selected.source!.sessionId! }).catch((error) => {
                      toast.error(error instanceof Error ? error.message : String(error));
                    })}
                  >
                    {t('settings.knowledge.source.open')}
                  </Button>
                ) : null}
              </p>
              <MemorySources key={`${contextKey}:${selected.id}`} scope={selected.scope} id={selected.id} workspaceId={workspaceId} />
              <p className={SETTINGS_HELPER_CLASS}>
                {t('settings.knowledge.recallCount', { count: selected.recallCount })}
                {' · '}
                {selected.recalledAt
                  ? t('settings.knowledge.recalledAt', { at: String(selected.recalledAt) })
                  : t('settings.knowledge.neverRecalled')}
              </p>
              <div className="flex flex-wrap gap-2">
                {selected.status !== 'dismissed' && selected.invalidAt === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy || !draft.content.trim()}
                    onClick={() => void run(async (signal) => {
                      if (!draft.content.trim()) throw new Error(t('harness.knowledge.contentRequired'));
                      await saveKnowledgeCatalogItem(selected, draft, workspaceId, signal);
                    })}
                  >
                    {t('harness.knowledge.save')}
                  </Button>
                ) : null}
                {selected.status === 'suggested' && selected.invalidAt === undefined ? (
                  <>
                    <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void run((signal) => reviewKnowledgeCatalogItem(selected, 'dismiss', workspaceId, [], signal))}>
                      {t('harness.knowledge.dismiss')}
                    </Button>
                    <Button type="button" size="xs" disabled={busy} onClick={() => void run((signal) => reviewKnowledgeCatalogItem(selected, 'accept', workspaceId, [], signal))}>
                      {t('harness.knowledge.accept')}
                    </Button>
                  </>
                ) : null}
                {selected.invalidAt === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t('settings.knowledge.deleteConfirm'))) return;
                      void run((signal) => retireKnowledgeCatalogItem(selected, workspaceId, signal));
                    }}
                  >
                    {t('settings.knowledge.delete')}
                  </Button>
                ) : null}
              </div>
              <div>
                <h4 className="typography-ui-label text-muted-foreground">{t('settings.knowledge.chain')}</h4>
                {chain && chain.chain.length > 1 ? (
                  <ol className="mt-2 space-y-1">
                    {chain.chain.map((item) => (
                      <li key={item.id} className={SETTINGS_HELPER_CLASS}>
                        #{item.id} {item.content}
                        {item.invalidAt !== undefined ? ` · ${t('settings.knowledge.status.retired')}` : ''}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.chain.empty')}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.knowledge.automation.title')}
        settingsItem="knowledge.automation"
        contentClassName="space-y-2"
      >
        <p className={SETTINGS_HELPER_CLASS}>
          {t('settings.knowledge.automation.model')}: {organizer?.model
            ? `${organizer.model.providerId} / ${organizer.model.modelId}`
            : t('settings.knowledge.automation.modelUnset')}
        </p>
        {(['workspace', 'user', 'bot'] as const).map((scope) => (
          <label key={scope} className="flex items-center gap-2 typography-ui">
            <input
              type="checkbox"
              checked={autoOrganize?.[scope] === true}
              disabled={!autoOrganize}
              onChange={(event) => harness.update({
                knowledge: { autoOrganize: { [scope]: event.target.checked } },
              })}
            />
            {t(`settings.knowledge.automation.autoOrganize.${scope}`)}
          </label>
        ))}
        {scope !== 'user' && workspaceId ? (
          <div className="space-y-2 pt-2">
            {organizerError ? <p role="alert" className="typography-micro text-[var(--status-error)]">{organizerError}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <h4 className="typography-ui-label text-muted-foreground">{t('settings.knowledge.organizer.title')}</h4>
              <Button
                variant="outline"
                size="sm"
                disabled={organizerBusy || !organizer?.enabled}
                onClick={() => {
                  setOrganizerBusy(true);
                  void retryOrganizerScope(scope, workspaceId)
                    .then(() => {
                      // The run settles after a debounce — refresh again once
                      // it has had time to move rows out of failed/prepared.
                      void reloadOrganizer();
                      setTimeout(() => void reloadOrganizer(), 3_000);
                    })
                    .catch((error) => toast.error(error instanceof Error ? error.message : t('settings.knowledge.organizer.title')))
                    .finally(() => setOrganizerBusy(false));
                }}
              >
                {t('settings.knowledge.organizer.retry')}
              </Button>
            </div>
            {!organizer ? null : organizer.rows.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.organizer.empty')}</p>
            ) : (
              <ul className="space-y-1">
                {organizer.rows.map((row) => (
                  <li key={row.key} className={SETTINGS_HELPER_CLASS}>
                    <span className="font-medium">{row.key}</span>
                    {` · ${t(`settings.knowledge.organizer.status.${row.status}` as I18nKey)}`}
                    {row.produced && row.produced.length > 0 ? ` · ${row.produced.map((id) => `#${id}`).join(', ')}` : ''}
                    {row.lastError ? ` — ${row.lastError}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
};
