import React from 'react';
import {
  createExternalAgentsHttpAPI,
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointChanged,
  type ExternalAgentProfile,
  type ExternalAgentConfiguration,
  type ExternalAgentDetection,
  type ExternalAgentCapabilityCache,
  type ExternalAgentDefaults,
} from '@varin/application-client';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { HarnessIcon } from '@/components/thread/HarnessIcon';
import { openExternalUrl } from '@/lib/url';
import { externalThinkingOptions } from '@/components/thread/externalSessionChoice';

function AgentDefaultsFields({ value, cache, disabled, onChange }: {
  value: ExternalAgentDefaults | undefined;
  cache: ExternalAgentCapabilityCache | undefined;
  disabled: boolean;
  onChange(value: ExternalAgentDefaults | undefined): void;
}) {
  const { t } = useI18n();
  const capabilities = cache?.capabilities;
  const levels = externalThinkingOptions(value ?? {}, capabilities).levels ?? [];
  const fields = [
    { key: 'model' as const, label: t('external.model'), options: capabilities?.models ?? [] },
    { key: 'thinking' as const, label: t('chat.context.thinking'), options: levels.map(id => ({ id, name: id })) },
    { key: 'mode' as const, label: t('external.mode'), options: capabilities?.modes ?? [] },
  ];
  const change = (key: keyof ExternalAgentDefaults, selected: string) => {
    const next = { ...value };
    if (selected === 'inherit') delete next[key]; else next[key] = selected.slice('value:'.length);
    // Effort belongs to a particular model. Never leave a hidden override behind.
    if (key === 'model' && next.thinking && !externalThinkingOptions(next, capabilities).levels?.includes(next.thinking)) delete next.thinking;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return <fieldset className="space-y-3 rounded-lg border border-border/60 p-3" disabled={disabled}>
    <legend className="px-1 typography-meta font-medium">{t('external.defaultsTitle')}</legend>
    <p className="typography-meta text-muted-foreground">{t('external.defaultsHint')}</p>
    <p className="typography-meta text-muted-foreground">{cache
      ? `${t('external.defaultsCached')}${cache.agentVersion ? ` · ${cache.agentVersion}` : ''}`
      : t('external.defaultsUnavailable')}</p>
    {fields.filter(field => field.key !== 'thinking' || field.options.length || value?.thinking).map(field => {
      const selected = value?.[field.key];
      const stale = Boolean(selected && !field.options.some(option => option.id === selected));
      return <div key={field.key} className="space-y-1">
        <SettingsFieldRow label={field.label}>
          <Select value={selected ? `value:${selected}` : 'inherit'} disabled={disabled || (!field.options.length && !selected)}
            onValueChange={next => change(field.key, next)}>
            <SelectTrigger className="w-56 max-w-full" aria-label={`${t('external.defaultsTitle')} · ${field.label}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{t('external.inherit')}</SelectItem>
              {stale && <SelectItem value={`value:${selected}`} disabled>{selected} · {t('external.notReported')}</SelectItem>}
              {field.options.map(option => <SelectItem key={option.id} value={`value:${option.id}`}>{option.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        {stale && <p role="status" className="typography-meta text-muted-foreground">{t('external.defaultsStale')}</p>}
      </div>;
    })}
  </fieldset>;
}

export function ExternalAgentDefault() {
  const { t } = useI18n();
  const settings = useExternalAgents();
  const [error, setError] = React.useState('');
  return (
    <>
      <SettingsFieldRow label={t('external.default')}>
        <Select
          value={settings?.defaultAgent ?? 'varin'}
          disabled={!settings}
          onValueChange={(value) => {
            if (!settings) return;
            void createExternalAgentsHttpAPI()
              .configure(
                { agents: settings.agents, defaultAgent: value === 'varin' ? null : value },
                settings.revision,
                crypto.randomUUID(),
              )
              .then(
                () => useExternalAgentStore.getState().refresh(),
                (error) => setError(String(error)),
              );
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="varin">Varin</SelectItem>
            {settings?.agents
              .filter((v) => v.enabled || v.id === settings.defaultAgent)
              .map((v) => (
                <SelectItem key={v.id} value={v.id} disabled={!v.enabled}>
                  {v.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {error && (
        <p role="alert" className="text-destructive typography-meta">
          {error}
        </p>
      )}
    </>
  );
}
function ConfigurationRow({
  configuration,
  busy,
  profile,
  capabilityCache,
  save,
  remove,
}: {
  configuration: ExternalAgentConfiguration;
  busy: boolean;
  profile?: ExternalAgentProfile;
  capabilityCache?: ExternalAgentCapabilityCache;
  save(value: ExternalAgentConfiguration): Promise<void>;
  remove(): Promise<void>;
}) {
  const { t } = useI18n();
  const host = getRuntimeEndpointGeneration();
  const [expanded, setExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState(configuration);
  const [args, setArgs] = React.useState(JSON.stringify(configuration.args));
  const [detection, setDetection] = React.useState<ExternalAgentDetection>();
  const [detecting, setDetecting] = React.useState(false);
  const [error, setError] = React.useState('');
  const controller = React.useRef<AbortController | null>(null);
  const configurationKey = JSON.stringify(configuration);
  const lastConfigurationKey = React.useRef(configurationKey);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(() => {
    // A capability-cache refresh is not a settings edit. Preserve an unsaved form.
    if (lastConfigurationKey.current === configurationKey) return;
    lastConfigurationKey.current = configurationKey;
    setDraft(configuration);
    setArgs(JSON.stringify(configuration.args));
  }, [configuration, configurationKey]);
  const detect = React.useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setDetecting(true);
    setError('');
    try {
      const result = await createExternalAgentsHttpAPI(host).detect(configuration.id, request.signal);
      if (!request.signal.aborted && host === getRuntimeEndpointGeneration()) setDetection(result);
    } catch (error) {
      if (!request.signal.aborted && host === getRuntimeEndpointGeneration()) setError(String(error));
    } finally {
      if (!request.signal.aborted && host === getRuntimeEndpointGeneration()) setDetecting(false);
    }
  }, [host, configuration.id]);
  const detectionArguments = JSON.stringify(configuration.args);
  React.useEffect(() => {
    void detect();
    return () => controller.current?.abort();
  }, [detect, configuration.command, detectionArguments]);
  return (
    <section className="border-b border-border/60 py-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <HarnessIcon harness={configuration.harness} profileId={profile?.id} className="size-5" />
          <span className="min-w-0">
            <span className="block font-medium">{configuration.name}</span>
            <span className="block truncate typography-meta text-muted-foreground">
              {detecting
                ? t('external.detecting')
                : detection
                  ? `${t(`external.${detection.status}`)}${detection.version ? ` · ${detection.version}` : ''}`
                  : t('external.undetected')}
            </span>
          </span>
          <Icon
            name="arrow-down-s"
            className={`ml-1 size-4 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (detecting) {
              controller.current?.abort();
              setDetecting(false);
            } else void detect();
          }}
        >
          {t(detecting ? 'external.cancel' : 'external.detect')}
        </Button>
        <Switch
          aria-label={`${configuration.name} · ${t('external.enabled')}`}
          checked={configuration.enabled}
          disabled={busy}
          onCheckedChange={(enabled) =>
            void save({ ...configuration, enabled }).catch((error) => setError(String(error)))
          }
        />
      </div>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          <form
            className="space-y-4 pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              setError('');
              try {
                const parsed: unknown = JSON.parse(args);
                if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string'))
                  throw new Error(t('external.arguments'));
                void save({ ...draft, args: parsed }).then(
                  () => setDetection(undefined),
                  (error) => setError(String(error)),
                );
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            {profile && <div className="space-y-2 rounded-lg bg-muted/40 p-3 typography-meta text-muted-foreground">
              <p>{profile.description}</p>
              <p>{t('external.platforms')}: {profile.platforms.join(' · ')}</p>
              <p>{t('external.profileLaunch')}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all">{profile.launch.command} {JSON.stringify(profile.launch.args)}</pre>
              {profile.authentication && <p className="whitespace-pre-wrap">{profile.authentication}</p>}
              {profile.compatibility && <p className="whitespace-pre-wrap">{profile.compatibility}</p>}
              {profile.installUrl && <Button type="button" size="sm" variant="outline" onClick={() => void openExternalUrl(profile.installUrl!).catch(error => setError(String(error)))}>{t('external.installGuide')}</Button>}
            </div>}
            <p className="typography-meta text-muted-foreground">{t('external.detectionScope')}</p>
            <label className="block space-y-2 typography-meta">
              <span>{t('external.name')}</span>
              <Input value={draft.name} onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))} />
            </label>
            <label className="block space-y-2 typography-meta">
              <span>{t('external.command')}</span>
              <Input
                value={draft.command}
                onChange={(e) => setDraft((v) => ({ ...v, command: e.target.value }))}
                spellCheck={false}
              />
            </label>
            <label className="block space-y-2 typography-meta">
              <span>{t('external.arguments')}</span>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
            </label>
            <AgentDefaultsFields value={draft.defaults} disabled={busy}
              cache={draft.command === configuration.command && args === JSON.stringify(configuration.args) ? capabilityCache : undefined}
              onChange={defaults => setDraft(value => {
                const next = { ...value };
                if (defaults) next.defaults = defaults; else delete next.defaults;
                return next;
              })} />
            {detection?.executable && (
              <p className="break-all typography-meta text-muted-foreground">{detection.executable}</p>
            )}
            <Button disabled={busy} type="submit">
              {t('external.save')}
            </Button>
            {configuration.harness === 'acp' && !profile && (
              <Button
                disabled={busy}
                type="button"
                variant="ghost"
                className="ml-2 text-destructive"
                onClick={() => void remove().catch((error) => setError(String(error)))}
              >
                {t('external.remove')}
              </Button>
            )}
          </form>
        </div>
      </div>
      {(error || detection?.message) && (
        <p role="alert" className="mt-3 break-words typography-meta text-destructive">
          {error || detection?.message}
        </p>
      )}
    </section>
  );
}
export function ExternalAgentsPage() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ExternalAgentsSettings key={host} host={host} />;
}
function ExternalAgentsSettings({ host }: { host: number }) {
  const { t } = useI18n();
  const settings = useExternalAgents();
  const loadError = useExternalAgentStore((state) => state.error);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const remove = async (id: string) => {
    if (!settings) return;
    setSaving(true);
    try {
      await createExternalAgentsHttpAPI(host).configure(
        {
          agents: settings.agents.filter((a) => a.id !== id),
          defaultAgent: settings.defaultAgent === id ? null : settings.defaultAgent,
        },
        settings.revision,
        crypto.randomUUID(),
      );
      if (host === getRuntimeEndpointGeneration()) await useExternalAgentStore.getState().refresh();
    } finally {
      if (host === getRuntimeEndpointGeneration()) setSaving(false);
    }
  };
  const save = async (configuration: ExternalAgentConfiguration) => {
    if (!settings || host !== getRuntimeEndpointGeneration()) return;
    const generation = host;
    setSaving(true);
    try {
      const agents = settings.agents.some((v) => v.id === configuration.id)
        ? settings.agents.map((v) => (v.id === configuration.id ? configuration : v))
        : [...settings.agents, configuration];
      await createExternalAgentsHttpAPI(generation).configure(
        { agents, defaultAgent: settings.defaultAgent },
        settings.revision,
        crypto.randomUUID(),
      );
      if (generation === getRuntimeEndpointGeneration()) await useExternalAgentStore.getState().refresh();
    } finally {
      if (generation === getRuntimeEndpointGeneration()) setSaving(false);
    }
  };
  return (
    <SettingsPageLayout title={t('external.title')}>
      <p className="mb-5 text-sm text-muted-foreground">{t('external.description')}</p>
      {(error || loadError) && (
        <p role="alert" className="text-destructive typography-meta">
          {error || loadError}
        </p>
      )}
      {settings?.agents.map((configuration) => (
        <ConfigurationRow
          key={configuration.id}
          configuration={configuration}
          capabilityCache={settings.capabilityCache?.[configuration.id]}
          profile={settings.profiles?.find(profile => profile.id === configuration.id)}
          busy={saving}
          save={save}
          remove={() => remove(configuration.id)}
        />
      ))}
      {settings?.profiles?.filter(profile => !settings.agents.some(agent => agent.id === profile.id)).map(profile => <section key={profile.id} className="space-y-2 border-b border-border/60 py-5">
        <div className="flex items-center gap-3"><HarnessIcon harness={profile.harness} profileId={profile.id} /><span className="flex-1 font-medium">{profile.name}</span>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void save({ id: profile.id, name: profile.name,
            harness: profile.harness, enabled: false, command: profile.launch.command, args: profile.launch.args }).catch(error => setError(String(error)))}>{t('external.addProfile')}</Button>
        </div>
        <p className="typography-meta text-muted-foreground">{profile.description}</p>
        <p className="typography-meta text-muted-foreground">{t('external.platforms')}: {profile.platforms.join(' · ')}</p>
        {profile.authentication && <p className="typography-meta text-muted-foreground">{profile.authentication}</p>}
        {profile.installUrl && <Button type="button" variant="ghost" size="sm" onClick={() => void openExternalUrl(profile.installUrl!).catch(error => setError(String(error)))}>{t('external.installGuide')}</Button>}
      </section>)}
      <Button
        className="mt-5"
        variant="outline"
        disabled={!settings || saving}
        onClick={() =>
          void save({
            id: crypto.randomUUID(),
            name: 'ACP Agent',
            harness: 'acp',
            enabled: false,
            command: 'agent',
            args: [],
          }).catch((error) => setError(String(error)))
        }
      >
        <Icon name="add" className="mr-2 size-4" />
        {t('external.add')}
      </Button>
    </SettingsPageLayout>
  );
}
