import React from 'react';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, runtimeFetch } from '@varin/application-client';
import { Input } from '@/components/ui/input';
import { Btn, Note, OptionCards, Row, Section } from '../shared/kit';
import { useI18n } from '@/lib/i18n';

type NetworkSetting = { mode: 'auto' | 'direct' | 'proxy'; proxyUrl: string; noProxy: string; credentialRef?: string };
const DEFAULT: NetworkSetting = { mode: 'auto', proxyUrl: '', noProxy: '' };

export function OutboundNetworkSettings() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <OutboundNetworkContent key={generation} generation={generation} />;
}
function OutboundNetworkContent({ generation }: { generation: number }) {
  const { t } = useI18n();
  const live = React.useRef(true);
  const writing = React.useRef(false);
  const testing = React.useRef(false);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const isCurrent = React.useCallback(() => live.current && generation === getRuntimeEndpointGeneration(), [generation]);
  // Every follow-up is fenced before sending, including the credential write
  // after a settings save. A late old-Host response cannot redirect that secret.
  const request = React.useCallback(async <T,>(url: string, init?: RequestInit): Promise<{ response: Response; value: T }> => {
    if (!isCurrent()) throw new Error('Application Host changed. Reload settings.');
    const response = await runtimeFetch(url, init);
    const value = await response.json() as T;
    if (!isCurrent()) throw new Error('Application Host changed. Reload settings.');
    return { response, value };
  }, [isCurrent]);
  const [saved, setSaved] = React.useState<NetworkSetting>(DEFAULT);
  const [draft, setDraft] = React.useState<NetworkSetting>(DEFAULT);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [hasAuth, setHasAuth] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [testUrl, setTestUrl] = React.useState('https://example.com/');
  const testUrlId = React.useId();
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const host = (() => {
    try { return new URL(getRuntimeApiBaseUrl() || window.location.origin).origin; }
    catch { return getRuntimeApiBaseUrl() || window.location.origin; }
  })();

  const readHostState = React.useCallback(async () => {
    const { response, value: document } = await request<{ outboundNetwork?: Partial<NetworkSetting> }>('/api/config/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(t('settings.page.harness.network.loadFailed'));
    const { response: credentialResponse, value: credential } = await request<{ configured?: boolean }>('/api/harness/egress/credentials', { cache: 'no-store' });
    if (!credentialResponse.ok) throw new Error(t('settings.page.harness.network.loadFailed'));
    return { setting: { ...DEFAULT, ...document.outboundNetwork }, configured: credential.configured === true };
  }, [t, request]);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setResult(null);
    void readHostState().then(({ setting, configured }) => {
      if (!active) return;
      setSaved(setting);
      setDraft(setting);
      setHasAuth(configured);
      setError(null);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [readHostState]);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft) || Boolean(username || password);
  const save = async () => {
    if (writing.current || loading || !isCurrent()) return false;
    writing.current = true;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const url = draft.proxyUrl.trim();
      if (draft.mode === 'proxy') {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
          throw new Error(t('settings.page.harness.network.invalidProxy'));
        }
      }
      const changes: Record<string, unknown> = { outboundNetwork: { ...draft, proxyUrl: url } };
      const { response, value } = await request<{ outboundNetwork?: NetworkSetting }>('/api/config/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      });
      if (!response.ok) throw new Error(t('settings.page.harness.network.saveFailed'));
      const persisted = value.outboundNetwork ?? { ...draft, proxyUrl: url };
      setSaved(persisted);
      setDraft(persisted);
      const { response: statusResponse, value: status } = await request<{ configured?: boolean }>('/api/harness/egress/credentials', { cache: 'no-store' });
      if (statusResponse.ok) {
        setHasAuth(status.configured === true);
      }
      if (username || password) {
        const { response: credentialResponse } = await request('/api/harness/egress/credentials', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, credentialRef: persisted.credentialRef }),
        });
        if (!credentialResponse.ok) throw new Error(t('settings.page.harness.network.saveFailed'));
        setHasAuth(true);
      }
      setUsername(''); setPassword('');
      return true;
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : t('settings.page.harness.network.saveFailed'));
      return false;
    } finally { writing.current = false; if (isCurrent()) setSaving(false); }
  };

  const clearAuth = async () => {
    if (writing.current || loading || dirty || !isCurrent()) return;
    writing.current = true;
    setSaving(true); setError(null);
    try {
      const { response } = await request('/api/harness/egress/credentials', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialRef: saved.credentialRef }),
      });
      if (response.status === 409) {
        const current = await readHostState();
        setSaved(current.setting); setDraft(current.setting); setHasAuth(current.configured);
        setUsername(''); setPassword(''); setResult(null);
        setError(t('settings.page.harness.network.saveFailed'));
        return;
      }
      if (!response.ok) throw new Error(t('settings.page.harness.network.saveFailed'));
      setHasAuth(false); setUsername(''); setPassword(''); setResult(null);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { writing.current = false; if (isCurrent()) setSaving(false); }
  };

  const verify = async () => {
    if (loading || dirty || writing.current || testing.current || !isCurrent()) return;
    testing.current = true;
    setVerifying(true); setResult(null);
    try {
      const { response, value } = await request<{ ok?: boolean; status?: number; errorClass?: string; error?: string; policy?: { mode: string; source: string; proxyOrigin?: string } }>('/api/harness/egress/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: testUrl }),
      });
      if (!response.ok) throw new Error(value.error ?? t('settings.page.harness.network.verifyFailed'));
      setResult({ ok: value.ok === true, message: value.ok
        ? `${t('settings.page.harness.network.verifyOk')} HTTP ${value.status} · ${value.policy?.mode ?? '?'} · ${value.policy?.proxyOrigin ?? value.policy?.source ?? '?'}`
        : `${t('settings.page.harness.network.verifyFailed')} ${value.errorClass ?? 'http'}${value.status ? ` ${value.status}` : ''}: ${value.error ?? ''}` });
    } catch (cause) {
      if (isCurrent()) setResult({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
    finally { testing.current = false; if (isCurrent()) setVerifying(false); }
  };

  const modeLabel = t('settings.page.harness.network.mode');
  const proxyUrlLabel = t('settings.page.harness.network.proxyUrl');
  const noProxyLabel = t('settings.page.harness.network.noProxy');
  const usernameLabel = t('settings.page.harness.network.username');
  const passwordLabel = t('settings.page.harness.network.password');
  const testLabel = t('settings.page.harness.network.testUrl');

  return <>
    <Section title={modeLabel} raw>
      <OptionCards label={modeLabel} value={draft.mode}
        options={(['auto', 'direct', 'proxy'] as const).map(mode => ({
          value: mode, label: t(`settings.page.harness.network.${mode}`),
          description: t(`settings.page.harness.network.${mode}Hint`), disabled: loading || saving,
        }))}
        onChange={mode => { setDraft(current => ({ ...current, mode })); setResult(null); }} />
    </Section>
    {draft.mode === 'proxy' ? <Section title={t('settings.page.harness.network.proxy')}>
      <Row label={proxyUrlLabel}>
        <Input aria-label={proxyUrlLabel} className="w-72" value={draft.proxyUrl} placeholder="http://127.0.0.1:7890"
          onChange={event => setDraft(current => ({ ...current, proxyUrl: event.target.value }))} disabled={loading || saving} />
      </Row>
      <Row label={noProxyLabel}>
        <Input aria-label={noProxyLabel} className="w-72" value={draft.noProxy} placeholder="localhost, .example.org"
          onChange={event => setDraft(current => ({ ...current, noProxy: event.target.value }))} disabled={loading || saving} />
      </Row>
      <Row label={usernameLabel}>
        <Input aria-label={usernameLabel} className="w-72" value={username} autoComplete="off"
          onChange={event => setUsername(event.target.value)} disabled={loading || saving} />
      </Row>
      <Row label={passwordLabel}>
        <Input aria-label={passwordLabel} className="w-72" type="password" value={password} autoComplete="new-password"
          onChange={event => setPassword(event.target.value)} disabled={loading || saving} />
      </Row>
      {hasAuth ? <Row><Btn kind="ghost-danger" disabled={loading || saving || dirty} onClick={() => void clearAuth()}>
        {t('settings.page.harness.network.clearAuth')}
      </Btn></Row> : null}
    </Section> : null}
    <Section title={t('settings.page.harness.network.verify')} description={<>{t('settings.page.harness.network.host')} <span className="break-all">{host}</span></>}
      after={dirty ? <Note>{t('settings.page.harness.network.saveFirst')}</Note>
        : result ? <Note kind={result.ok ? 'ok' : 'err'}><span role={result.ok ? 'status' : undefined}>{result.message}</span></Note> : null}>
      <Row label={<label htmlFor={testUrlId}>{testLabel}</label>}>
        <form className="flex w-[24rem] max-w-full flex-wrap items-center gap-2"
          onSubmit={event => { event.preventDefault(); void verify(); }}>
          <Input id={testUrlId} className="min-w-0 flex-[1_1_14ch]" inputMode="url" value={testUrl}
            onChange={event => { setTestUrl(event.target.value); setResult(null); }} disabled={loading || verifying} />
          <Btn type="submit" busy={verifying} disabled={loading || saving || dirty || verifying}>{t('settings.models.testConnection')}</Btn>
        </form>
      </Row>
    </Section>
    <SettingsActionBar dirty={dirty} saving={saving} saveDisabled={loading} onSave={save}
      onCancel={() => { setDraft(saved); setUsername(''); setPassword(''); setError(null); setResult(null); }}
      error={error} />
  </>;
}
