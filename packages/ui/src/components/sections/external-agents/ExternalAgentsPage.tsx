import React from 'react';
import {
  createExternalAgentsHttpAPI,
  getRuntimeEndpointGeneration,
  type ExternalAgentConfiguration,
  type ExternalAgentDetection,
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
  save,
  remove,
}: {
  configuration: ExternalAgentConfiguration;
  busy: boolean;
  save(value: ExternalAgentConfiguration): Promise<void>;
  remove(): Promise<void>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState(configuration);
  const [args, setArgs] = React.useState(JSON.stringify(configuration.args));
  const [detection, setDetection] = React.useState<ExternalAgentDetection>();
  const [detecting, setDetecting] = React.useState(false);
  const [error, setError] = React.useState('');
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(() => {
    setDraft(configuration);
    setArgs(JSON.stringify(configuration.args));
  }, [configuration]);
  const detect = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setDetecting(true);
    setError('');
    try {
      const result = await createExternalAgentsHttpAPI().detect(configuration.id, request.signal);
      if (!request.signal.aborted) setDetection(result);
    } catch (error) {
      if (!request.signal.aborted) setError(String(error));
    } finally {
      if (!request.signal.aborted) setDetecting(false);
    }
  };
  React.useEffect(() => {
    void detect();
    return () => controller.current?.abort();
  }, [configuration.id, configuration.command, JSON.stringify(configuration.args)]);
  return (
    <section className="border-b border-border/60 py-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <HarnessIcon harness={configuration.harness} className="size-5" />
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
            {detection?.executable && (
              <p className="break-all typography-meta text-muted-foreground">{detection.executable}</p>
            )}
            <Button disabled={busy} type="submit">
              {t('external.save')}
            </Button>
            {configuration.harness === 'acp' && (
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
  const { t } = useI18n();
  const settings = useExternalAgents();
  const loadError = useExternalAgentStore((state) => state.error);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const remove = async (id: string) => {
    if (!settings) return;
    setSaving(true);
    try {
      await createExternalAgentsHttpAPI().configure(
        {
          agents: settings.agents.filter((a) => a.id !== id),
          defaultAgent: settings.defaultAgent === id ? null : settings.defaultAgent,
        },
        settings.revision,
        crypto.randomUUID(),
      );
      await useExternalAgentStore.getState().refresh();
    } finally {
      setSaving(false);
    }
  };
  const save = async (configuration: ExternalAgentConfiguration) => {
    if (!settings) return;
    const generation = getRuntimeEndpointGeneration();
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
      await useExternalAgentStore.getState().refresh();
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
          busy={saving}
          save={save}
          remove={() => remove(configuration.id)}
        />
      ))}
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
