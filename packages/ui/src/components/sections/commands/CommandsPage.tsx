import React from 'react';
import type { PiCommandDescriptor, PiCommandSource } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@varin/application-client';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

const SOURCE_DETAILS: Readonly<Record<PiCommandSource, {
  descriptionKey: I18nKey;
  destination?: 'skills';
  labelKey: I18nKey;
}>> = {
  extension: {
    labelKey: 'settings.varin.commands.source.extension.title',
    descriptionKey: 'settings.varin.commands.source.extension.description',
  },
  skill: {
    labelKey: 'settings.varin.commands.source.skill.title',
    descriptionKey: 'settings.varin.commands.source.skill.description',
    destination: 'skills',
  },
};

const invocationOf = (command: PiCommandDescriptor): string => (
  `${command.name.startsWith('/') ? command.name : `/${command.name}`}${command.argumentHint ? ` ${command.argumentHint}` : ''}`
);

export const CommandsPage: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const [commands, setCommands] = React.useState<PiCommandDescriptor[]>([]);
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listPiCommands(runtimeTarget);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setCommands(next.slice().sort((left, right) => (
        left.source.localeCompare(right.source)
        || left.name.localeCompare(right.name)
      )));
      setLoaded(true);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setCommands([]);
      setLoaded(false);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setCommands([]);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(normalized)
      || command.description?.toLocaleLowerCase().includes(normalized)
      || command.source.toLocaleLowerCase().includes(normalized)
      || command.sourceInfo.path.toLocaleLowerCase().includes(normalized)
      || command.sourceInfo.source.toLocaleLowerCase().includes(normalized)
      || command.sourceInfo.scope.toLocaleLowerCase().includes(normalized)
    ));
  }, [commands, query]);

  const groups = React.useMemo(() => {
    const result = new Map<PiCommandSource, PiCommandDescriptor[]>();
    for (const command of filtered) {
      const current = result.get(command.source) ?? [];
      current.push(command);
      result.set(command.source, current);
    }
    return (['extension', 'skill'] as const)
      .map((source) => ({ commands: result.get(source) ?? [], source }))
      .filter((group) => group.commands.length > 0);
  }, [filtered]);

  return (
    <SettingsPageLayout
      title={t('settings.page.commands.title')}
      description={t('settings.varin.commands.description')}
      headerEnd={(
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
          {t('settings.varin.commands.actions.refresh')}
        </Button>
      )}
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="commands.catalog"
        title={t('settings.varin.commands.catalog.title')}
        description={t('settings.varin.commands.catalog.description')}
        divider={false}
      >
        <div className="max-w-xl">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.view.search.placeholder')}
            aria-label={t('settings.view.search.aria')}
          />
        </div>

        {loadError ? (
          <div className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {loadError}
          </div>
        ) : null}

        {groups.length > 0 ? (
          <div className="mt-5 space-y-5">
            {groups.map((group) => {
              const details = SOURCE_DETAILS[group.source];
              return (
                <section key={group.source} className="space-y-2">
                  <div className="flex flex-col gap-2 @xl:flex-row @xl:items-start @xl:justify-between">
                    <div>
                      <h3 className="typography-ui-label font-medium text-foreground">{t(details.labelKey)}</h3>
                      <p className="mt-0.5 typography-meta text-muted-foreground">{t(details.descriptionKey)}</p>
                    </div>
                    {details.destination ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 !font-normal"
                        onClick={() => setSettingsPage(details.destination!)}
                      >
                        {t('settings.varin.commands.actions.openSkills')}
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
                    {group.commands.map((command) => (
                      <div
                        key={`${group.source}:${command.name}`}
                        className="min-w-0 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <code className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                            {invocationOf(command)}
                          </code>
                          <span className="shrink-0 rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
                            {command.sourceInfo.scope}
                          </span>
                        </div>
                        {command.description ? (
                          <p className="mt-2 typography-meta text-muted-foreground">{command.description}</p>
                        ) : null}
                        <div className="mt-2 space-y-0.5 border-t border-border/50 pt-2 typography-micro text-muted-foreground">
                          <p className="break-all font-mono">{command.sourceInfo.path}</p>
                          <p className="break-all">
                            {command.sourceInfo.origin} · {command.sourceInfo.source}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : loaded ? (
          <div className="mt-5 rounded-xl border border-dashed border-border/70 p-5 text-center typography-meta text-muted-foreground">
            {t('chat.commandAutocomplete.empty')}
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center py-8 text-muted-foreground">
            <Icon name="loader-4" className="size-5 animate-spin" />
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
