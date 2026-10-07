import React from 'react';
import {
  type PackageDescriptor,
  type PiPackageScope,
  type RuntimeContextTarget,
} from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  findPiPackage,
  isPiPackageUpdatable,
  installPiPackage,
  listPiPackages,
  piPackageNameFromSource,
  removePiPackage,
  setPiPackageEnabled,
  updatePiPackages,
} from '@/lib/pi-runtime/packages';
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { getRuntimeKey } from '@varin/application-client';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { requestPluginSettingsTarget } from '@/lib/settings/plugin-settings-navigation';
import { RECOMMENDED_PACKAGES } from './recommended-packages';
type PackageAction = 'install' | 'remove' | 'set-enabled' | 'update' | 'update-all';

const PACKAGE_ACTION_SUCCESS_KEYS = {
  install: 'settings.varin.plugins.toast.install',
  remove: 'settings.varin.plugins.toast.remove',
  update: 'settings.varin.plugins.toast.update',
  'update-all': 'settings.varin.plugins.toast.updateAll',
} satisfies Record<Exclude<PackageAction, 'set-enabled'>, I18nKey>;

const packageActionLabel = (
  action: Exclude<PackageAction, 'set-enabled'> | null,
  expected: Exclude<PackageAction, 'set-enabled'>,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  if (action === expected) {
    return expected === 'install'
      ? t('settings.varin.recovery.actions.installing')
      : expected === 'remove'
        ? t('settings.varin.recovery.actions.removing')
        : expected === 'update-all'
          ? t('settings.varin.plugins.actions.updatingAll')
          : t('settings.varin.recovery.actions.updating');
  }
  return expected === 'install'
    ? t('settings.varin.recovery.actions.install')
    : expected === 'remove'
      ? t('settings.varin.recovery.actions.remove')
      : expected === 'update-all'
        ? t('settings.varin.plugins.actions.updateAll')
        : t('settings.varin.recovery.actions.update');
};

const PackageStatus: React.FC<{ packageInfo?: PackageDescriptor }> = ({ packageInfo }) => {
  const { t } = useI18n();
  const configured = packageInfo !== undefined;
  const installed = packageInfo?.installed === true;
  const enabled = packageInfo?.enabled === true;
  return (
    <span className={configured && installed && enabled
      ? 'typography-micro text-[var(--status-success)]'
      : configured && !installed
        ? 'typography-micro text-[var(--status-warning)]'
        : 'typography-micro text-muted-foreground'}>
      {configured && installed && enabled
        ? t('settings.varin.recovery.status.configured')
        : configured && !installed
          ? t('settings.varin.plugins.status.missing')
          : configured
            ? t('settings.varin.plugins.status.disabled')
            : t('settings.varin.recovery.status.notConfigured')}
    </span>
  );
};

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const targetKey = `${runtimeKey}:${activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`}`;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const [packages, setPackages] = React.useState<PackageDescriptor[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [customSource, setCustomSource] = React.useState('');
  const [installScope, setInstallScope] = React.useState<PiPackageScope>('global');
  const [recommendedExpanded, setRecommendedExpanded] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<{
    action: PackageAction;
    scope?: PiPackageScope;
    source?: string;
  } | null>(null);
  const refreshGenerationRef = React.useRef(0);
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const actionTargetKey = targetKey;
    const requestRuntimeKey = runtimeKey;
    setLoading(true);
    setLoadError(null);

    const isCurrent = () => (
      generation === refreshGenerationRef.current
      && actionTargetKey === targetKeyRef.current
      && requestRuntimeKey === getRuntimeKey()
    );
    const setPackageList = (next: PackageDescriptor[]) => {
      setPackages([...next].sort((left, right) => (
        left.scope.localeCompare(right.scope)
        || left.name.localeCompare(right.name)
        || left.source.localeCompare(right.source)
      )));
      setLoaded(true);
    };
    try {
      const next = await listPiPackages(runtimeTarget);
      if (isCurrent()) setPackageList(next);
    } catch (error) {
      if (isCurrent()) {
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoaded(false);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [runtimeKey, runtimeTarget, targetKey]);

  React.useEffect(() => {
    setPackages([]);
    setLoaded(false);
    setBusyAction(null);
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  const runPackageAction = React.useCallback(async (
    action: PackageAction,
    source?: string,
    scope: PiPackageScope = installScope,
    enabled?: boolean,
  ) => {
    if (action !== 'update-all' && !source) return;
    const actionTargetKey = targetKey;
    const actionGeneration = refreshGenerationRef.current;
    const requestRuntimeKey = runtimeKey;
    const isCurrent = () => (
      mountedRef.current
      && actionGeneration === refreshGenerationRef.current
      && actionTargetKey === targetKeyRef.current
      && requestRuntimeKey === getRuntimeKey()
    );
    setBusyAction(source
      ? action === 'update'
        ? { action, source }
        : { action, scope, source }
      : { action });
    try {
      if (action === 'install') {
        await installPiPackage(runtimeTarget, source!, scope);
      } else if (action === 'remove') {
        const result = await removePiPackage(runtimeTarget, source!, scope);
        if (!result.removed) throw new Error(`Pi package is not configured: ${source}`);
      } else if (action === 'set-enabled') {
        await setPiPackageEnabled(runtimeTarget, source!, scope, enabled === true);
      } else if (action === 'update') {
        await updatePiPackages(runtimeTarget, source!);
      } else {
        await updatePiPackages(runtimeTarget);
      }
      notifyPiRuntimeCatalogChanged('package');
      if (isCurrent()) {
        setBusyAction(null);
        if (action !== 'set-enabled') toast.success(t(PACKAGE_ACTION_SUCCESS_KEYS[action]));
        await refresh();
      }
    } catch (error) {
      console.error(`Failed to ${action} Pi package:`, error);
      if (isCurrent()) {
        toast.error(t('settings.varin.plugins.toast.failed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (
        mountedRef.current
        && actionGeneration === refreshGenerationRef.current
        && actionTargetKey === targetKeyRef.current
        && requestRuntimeKey === getRuntimeKey()
      ) setBusyAction(null);
    }
  }, [installScope, refresh, runtimeKey, runtimeTarget, t, targetKey]);

  const openPackageConfiguration = React.useCallback((entry: PackageDescriptor) => {
    requestPluginSettingsTarget(entry.name, undefined, `${entry.scope}:${entry.source}`);
    setSettingsPage('plugin-settings');
  }, [setSettingsPage]);

  const normalizedCustomSource = customSource.trim();
  const customPackage = normalizedCustomSource
    ? packages.find((candidate) => (
      candidate.scope === installScope && candidate.source === normalizedCustomSource
    ))
      ?? findPiPackage(packages, piPackageNameFromSource(normalizedCustomSource), installScope)
    : undefined;
  const missingRecommended = RECOMMENDED_PACKAGES.filter((item) => (
    findPiPackage(packages, item.name, installScope) === undefined
  ));
  const customPackageUpdatable = customPackage
    ? isPiPackageUpdatable(customPackage.source)
    : false;
  const isBusy = busyAction !== null;
  const recommendedToggleLabel = t(
    recommendedExpanded
      ? 'sessions.sidebar.group.collapseAria'
      : 'sessions.sidebar.group.expandAria',
    { label: t('settings.varin.plugins.recommended.title') },
  );

  return (
    <SettingsPageLayout
      title={t('settings.page.plugins.title')}
      description={t('settings.varin.plugins.description')}
      className="max-w-6xl"
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="plugins.packages"
        title={t('settings.varin.plugins.configured.title')}
        description={t('settings.varin.plugins.configured.description')}
        divider={false}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-3">
          <div className="max-w-3xl">
            <p className="typography-meta text-muted-foreground">
              {t('settings.varin.plugins.ownership')}
            </p>
            <p className="mt-1 typography-micro text-muted-foreground">
              {t('settings.varin.plugins.actions.updateAllDescription')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={installScope} onValueChange={(value) => setInstallScope(value as PiPackageScope)}>
              <SelectTrigger className="h-7 w-36 typography-micro" aria-label="Package install scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">User packages</SelectItem>
                <SelectItem value="project">Project packages</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={isBusy || !loaded || packages.length === 0}
              onClick={() => void runPackageAction('update-all')}
              className="!font-normal"
              title={t('settings.varin.plugins.actions.updateAllDescription')}
            >
              {packageActionLabel(
                busyAction?.action === 'set-enabled' ? null : busyAction?.action ?? null,
                'update-all',
                t,
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isBusy || loading}
              onClick={() => void refresh()}
              className="!font-normal gap-1.5"
            >
              <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t('settings.varin.recovery.actions.refresh')}
            </Button>
          </div>
        </div>

        {loaded && packages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.varin.plugins.configured.empty')}
          </div>
        ) : null}

        {packages.map((entry) => {
          const matchingAction = busyAction?.source === entry.source
            && (busyAction.action === 'update' || busyAction.scope === entry.scope)
            ? busyAction.action
            : null;
          const action = matchingAction === 'set-enabled' ? null : matchingAction;
          return (
            <div key={`${entry.scope}:${entry.source}`} className="rounded-lg border border-border/60 px-3 py-3">
              <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon
                      name="plug-2"
                      className={entry.installed && entry.enabled
                        ? 'size-4 text-[var(--status-success)]'
                        : entry.installed
                          ? 'size-4 text-muted-foreground'
                          : 'size-4 text-[var(--status-warning)]'}
                    />
                    <span className="typography-ui-label text-foreground">{entry.name}</span>
                    <PackageStatus packageInfo={entry} />
                    <span className="rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
                      {entry.scope === 'project' ? 'project' : 'user'}
                    </span>
                    {entry.version ? (
                      <span className="typography-micro text-muted-foreground">v{entry.version}</span>
                    ) : null}
                    {entry.structured ? (
                      <span className="rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
                        {t('settings.varin.plugins.status.structured')}
                      </span>
                    ) : null}
                  </div>
                  <p className="break-all font-mono typography-micro text-muted-foreground">{entry.source}</p>
                  {entry.resolvedPath ? (
                    <p className="break-all font-mono typography-micro text-muted-foreground/80">{entry.resolvedPath}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Switch
                    checked={entry.enabled}
                    disabled={isBusy || !entry.installed}
                    onCheckedChange={(checked) => void runPackageAction(
                      'set-enabled',
                      entry.source,
                      entry.scope,
                      checked,
                    )}
                    aria-label={t('settings.varin.plugins.actions.activationAria', { name: entry.name })}
                  />
                  {isPiPackageUpdatable(entry.source) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isBusy}
                      onClick={() => void runPackageAction('update', entry.source)}
                      className="!font-normal"
                      title={t('settings.varin.plugins.actions.updateSourceDescription')}
                    >
                      {packageActionLabel(action, 'update', t)}
                    </Button>
                  ) : (
                    <span className="px-1.5 typography-micro text-muted-foreground">Local source</span>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={isBusy}
                    onClick={() => openPackageConfiguration(entry)}
                    className="!font-normal"
                  >
                    {t('settings.varin.plugins.actions.configure')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={isBusy}
                    onClick={() => void runPackageAction('remove', entry.source, entry.scope)}
                    className="!font-normal text-muted-foreground"
                  >
                    {packageActionLabel(action, 'remove', t)}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

        {loadError ? (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-error)]/10 px-3 py-2 text-[var(--status-error)]">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words typography-meta">{loadError}</p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="plugins.source"
        title={t('settings.varin.plugins.source.title')}
        description={t('settings.varin.plugins.source.description')}
      >
        <form
          className="flex flex-col gap-2 @xl:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!normalizedCustomSource) return;
            if (customPackage && !customPackageUpdatable) return;
            void runPackageAction(
              customPackage ? 'update' : 'install',
              customPackage?.source ?? normalizedCustomSource,
              installScope,
            );
          }}
        >
          <Input
            value={customSource}
            onChange={(event) => setCustomSource(event.target.value)}
            placeholder={t('settings.varin.plugins.source.placeholder')}
            disabled={isBusy}
            className="min-w-0 flex-1 font-mono"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!normalizedCustomSource || isBusy || (customPackage !== undefined && !customPackageUpdatable)}
            className="shrink-0 !font-normal"
          >
            {customPackage && !customPackageUpdatable
              ? 'Configured local package'
              : packageActionLabel(
                busyAction?.source === (customPackage?.source ?? normalizedCustomSource)
                  && (busyAction.action === 'update' || busyAction.scope === installScope)
                  ? busyAction.action === 'set-enabled' ? null : busyAction.action
                  : null,
                customPackage ? 'update' : 'install',
                t,
              )}
          </Button>
        </form>
      </SettingsSection>

      <SettingsSection
        settingsItem="plugins.recommended"
        title={t('settings.varin.plugins.recommended.title')}
        description={t('settings.varin.plugins.recommended.description')}
        headerAction={(
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setRecommendedExpanded((expanded) => !expanded)}
            aria-expanded={recommendedExpanded}
            aria-label={recommendedToggleLabel}
            title={recommendedToggleLabel}
          >
            <Icon
              name="arrow-down-s"
              className={recommendedExpanded
                ? 'size-4 rotate-180 transition-transform duration-200'
                : 'size-4 transition-transform duration-200'}
            />
          </Button>
        )}
        contentClassName={recommendedExpanded ? undefined : 'hidden'}
      >
        <div className="space-y-5">
          {RECOMMENDED_PACKAGES.map((item) => {
            const configured = findPiPackage(packages, item.name, installScope);
            const source = configured?.source ?? item.source;
            const action = busyAction?.source === source && busyAction.scope === installScope
              ? busyAction.action
              : null;
            const packageAction = action === 'set-enabled' ? null : action;
            return (
              <div key={item.name} className="rounded-lg border border-border/60 px-3 py-3">
                <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon
                        name="plug-2"
                        className={configured?.installed && configured.enabled
                          ? 'size-4 text-[var(--status-success)]'
                          : configured?.installed
                            ? 'size-4 text-muted-foreground'
                            : configured
                            ? 'size-4 text-[var(--status-warning)]'
                            : 'size-4 text-muted-foreground'}
                      />
                      <span className="typography-ui-label text-foreground">{item.name}</span>
                      {loaded ? <PackageStatus packageInfo={configured} /> : null}
                    </div>
                    <p className="typography-meta text-muted-foreground">{t(item.descriptionKey)}</p>
                    <p className="break-all font-mono typography-micro text-muted-foreground">{source}</p>
                  </div>
                  {!configured && loaded ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isBusy}
                      onClick={() => void runPackageAction('install', item.source, installScope)}
                      className="!font-normal"
                    >
                      {packageActionLabel(packageAction, 'install', t)}
                    </Button>
                  ) : configured ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={configured.enabled}
                        disabled={isBusy || !configured.installed}
                        onCheckedChange={(checked) => void runPackageAction(
                          'set-enabled',
                          configured.source,
                          configured.scope,
                          checked,
                        )}
                        aria-label={t('settings.varin.plugins.actions.activationAria', { name: configured.name })}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={isBusy}
                        onClick={() => openPackageConfiguration(configured)}
                        className="!font-normal"
                      >
                        {t('settings.varin.plugins.actions.configure')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {loaded && missingRecommended.length === 0 ? (
            <p className="typography-meta text-[var(--status-success)]">
              {t('settings.varin.plugins.recommended.complete')}
            </p>
          ) : null}
        </div>
      </SettingsSection>

    </SettingsPageLayout>
  );
};
