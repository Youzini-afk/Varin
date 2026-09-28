import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeKey, runtimeFetch } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';

type NetworkSetting = { mode: 'auto' | 'direct' | 'proxy'; proxyUrl: string; noProxy: string; credentialRef?: string };
const DEFAULT: NetworkSetting = { mode: 'auto', proxyUrl: '', noProxy: '' };

export function OutboundNetworkSettings() {
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const [saved, setSaved] = React.useState<NetworkSetting>(DEFAULT);
  const [draft, setDraft] = React.useState<NetworkSetting>(DEFAULT);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [hasAuth, setHasAuth] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [testUrl, setTestUrl] = React.useState('https://example.com/');
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const host = (() => {
    try { return new URL(getRuntimeApiBaseUrl() || window.location.origin).origin; }
    catch { return getRuntimeApiBaseUrl() || window.location.origin; }
  })();

  const readHostState = React.useCallback(async () => {
    const response = await runtimeFetch('/api/config/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(t('settings.page.harness.network.loadFailed'));
    const document = await response.json() as { outboundNetwork?: Partial<NetworkSetting> };
    const credentialResponse = await runtimeFetch('/api/harness/egress/credentials', { cache: 'no-store' });
    if (!credentialResponse.ok) throw new Error(t('settings.page.harness.network.loadFailed'));
    const credential = await credentialResponse.json() as { configured?: boolean };
    return { setting: { ...DEFAULT, ...document.outboundNetwork }, configured: credential.configured === true };
  }, [t]);

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
  }, [runtimeKey, readHostState]);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft) || Boolean(username || password);
  const save = async () => {
    if (saving || getRuntimeKey() !== runtimeKey) return;
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
      const response = await runtimeFetch('/api/config/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      });
      if (!response.ok) throw new Error(t('settings.page.harness.network.saveFailed'));
      const value = await response.json() as { outboundNetwork?: NetworkSetting };
      const persisted = value.outboundNetwork ?? { ...draft, proxyUrl: url };
      setSaved(persisted);
      setDraft(persisted);
      const statusResponse = await runtimeFetch('/api/harness/egress/credentials', { cache: 'no-store' });
      if (statusResponse.ok) {
        const status = await statusResponse.json() as { configured?: boolean };
        setHasAuth(status.configured === true);
      }
      if (username || password) {
        const credentialResponse = await runtimeFetch('/api/harness/egress/credentials', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, credentialRef: persisted.credentialRef }),
        });
        if (!credentialResponse.ok) throw new Error(t('settings.page.harness.network.saveFailed'));
        setHasAuth(true);
      }
      setUsername(''); setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.page.harness.network.saveFailed'));
    } finally { setSaving(false); }
  };

  const clearAuth = async () => {
    if (saving || getRuntimeKey() !== runtimeKey) return;
    setSaving(true); setError(null);
    try {
      const response = await runtimeFetch('/api/harness/egress/credentials', {
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  const verify = async () => {
    if (dirty || verifying || getRuntimeKey() !== runtimeKey) return;
    setVerifying(true); setResult(null); setError(null);
    try {
      const response = await runtimeFetch('/api/harness/egress/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: testUrl }),
      });
      const value = await response.json() as { ok?: boolean; status?: number; errorClass?: string; error?: string; policy?: { mode: string; source: string; proxyOrigin?: string } };
      if (!response.ok) throw new Error(value.error ?? t('settings.page.harness.network.verifyFailed'));
      setResult(value.ok
        ? `${t('settings.page.harness.network.verifyOk')} HTTP ${value.status} · ${value.policy?.mode ?? '?'} · ${value.policy?.proxyOrigin ?? value.policy?.source ?? '?'}`
        : `${t('settings.page.harness.network.verifyFailed')} ${value.errorClass ?? 'http'}${value.status ? ` ${value.status}` : ''}: ${value.error ?? ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setVerifying(false); }
  };

  return <SettingsSection title={t('settings.page.harness.network.title')} description={`${t('settings.page.harness.network.host')} ${host}`} contentClassName="space-y-5">
    <SettingsFieldRow label={t('settings.page.harness.network.mode')}>
      <Select value={draft.mode} onValueChange={(mode) => setDraft((current) => ({ ...current, mode: mode as NetworkSetting['mode'] }))} disabled={loading || saving}>
        <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t('settings.page.harness.network.auto')}</SelectItem>
          <SelectItem value="direct">{t('settings.page.harness.network.direct')}</SelectItem>
          <SelectItem value="proxy">{t('settings.page.harness.network.proxy')}</SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {draft.mode === 'auto' ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.network.autoHint')}</p> : null}
    {draft.mode === 'proxy' ? <>
      <SettingsFieldRow label={t('settings.page.harness.network.proxyUrl')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <Input value={draft.proxyUrl} placeholder="http://127.0.0.1:7890" onChange={(event) => setDraft((current) => ({ ...current, proxyUrl: event.target.value }))} disabled={loading || saving} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.network.noProxy')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <Input value={draft.noProxy} placeholder="localhost, .example.org" onChange={(event) => setDraft((current) => ({ ...current, noProxy: event.target.value }))} disabled={loading || saving} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.network.username')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <Input value={username} autoComplete="off" onChange={(event) => setUsername(event.target.value)} disabled={loading || saving} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.network.password')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <Input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} disabled={loading || saving} />
      </SettingsFieldRow>
      {hasAuth ? <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void clearAuth()}>{t('settings.page.harness.network.clearAuth')}</Button> : null}
    </> : null}
    <Button size="sm" disabled={loading || saving || !dirty} onClick={() => void save()}>{saving ? t('settings.common.actions.saving') : t('settings.page.harness.network.save')}</Button>
    <SettingsFieldRow label={t('settings.page.harness.network.testUrl')} controlClassName="@xl:flex-1 @xl:max-w-80">
      <Input value={testUrl} onChange={(event) => setTestUrl(event.target.value)} disabled={loading || verifying} />
    </SettingsFieldRow>
    <Button size="sm" variant="secondary" disabled={loading || saving || dirty || verifying} onClick={() => void verify()}>{t('settings.page.harness.network.verify')}</Button>
    {dirty ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.network.saveFirst')}</p> : null}
    {result ? <p role="status" className="typography-meta">{result}</p> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
  </SettingsSection>;
}
