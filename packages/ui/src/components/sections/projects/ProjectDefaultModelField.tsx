import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type AgentSettingsSnapshot } from '@varin/application-client';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ProjectTrustSettings } from '@/components/sections/shared/ProjectTrustSettings';
import { Button } from '@/components/ui/button';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { useI18n } from '@/lib/i18n';

/** Edits the same project defaults consumed when a new conversation selects its model. */
export function ProjectDefaultModelField({ directory }: { directory: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trust = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<AgentSettingsSnapshot>();
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setSnapshot(undefined); setError(''); setBusy(false);
    void api.readSettings(directory, controller.signal).then(value => {
      if (current === generation.current) setSnapshot(value);
    }, cause => { if (!controller.signal.aborted && current === generation.current) setError(String(cause)); });
    return () => { generation.current = current + 1; controller.abort(); };
  }, [api, directory, trust, attempt]);
  const change = async (providerId: string, modelId: string) => {
    if (!snapshot?.projectTrusted || busy) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const value = await api.updateSettings({ cwd: directory, scope: 'project', expectedRevision: snapshot.projectRevision,
        set: providerId && modelId ? { defaultProvider: providerId, defaultModel: modelId } : {},
        remove: providerId && modelId ? [] : ['defaultProvider', 'defaultModel'] });
      if (current === generation.current) setSnapshot(value);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally { if (current === generation.current) setBusy(false); }
  };
  const value = (entry: unknown) => typeof entry === 'string' ? entry : '';
  return <div className="space-y-2">
    <ModelSelector providerId={value(snapshot?.project.defaultProvider)} modelId={value(snapshot?.project.defaultModel)}
      displayProviderId={value(snapshot?.project.defaultProvider) || value(snapshot?.global.defaultProvider)} displayModelId={value(snapshot?.project.defaultModel) || value(snapshot?.global.defaultModel)}
      disabled={!snapshot?.projectTrusted || busy} onChange={change} className="h-8 w-64 max-w-full" />
    {snapshot && !snapshot.projectTrusted && <ProjectTrustSettings directory={directory} />}
    {error && <p role="alert" className="typography-meta text-destructive">{error}<Button size="sm" variant="ghost" disabled={busy} onClick={retry}>{t('settings.harness.retry')}</Button></p>}
  </div>;
}
