import React from 'react';
import type { HarnessWebSearchProvider } from '@varin/protocol';
import { getRuntimeKey, runtimeFetch } from '@varin/application-client';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { OutboundNetworkSettings } from './OutboundNetworkSettings';

const providers = ['brave', 'exa', 'tavily', 'jina', 'searxng'] as const;
const providerName = (provider: HarnessWebSearchProvider) => provider === 'searxng' ? 'SearXNG' : provider[0]!.toUpperCase() + provider.slice(1);
const domainList = (value: string) => [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];

function SearchCredential({ provider }: { provider: HarnessWebSearchProvider }) {
  const { t } = useI18n();
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const state = React.useRef({ key: '', dirty: false, active: false, mounted: true, runtime: getRuntimeKey() });
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = `/api/harness/web-search/credentials/${provider}`;
  React.useEffect(() => {
    const lifecycle = state.current;
    lifecycle.mounted = true;
    const abort = new AbortController();
    void runtimeFetch(url, { cache: 'no-store', signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
      const result = await response.json() as { configured: boolean };
      if (!abort.signal.aborted) setConfigured(result.configured);
    }).catch((failure) => { if (!abort.signal.aborted) setError(String(failure)); });
    return () => { lifecycle.mounted = false; abort.abort(); };
  }, [url, t, attempt]);

  const save = React.useCallback(async () => {
    clearTimeout(timer.current);
    const pending = state.current;
    if (pending.active || !pending.dirty || !pending.key.trim()) return;
    pending.active = true;
    if (pending.mounted) { setBusy(true); setError(null); }
    try {
      while (pending.dirty) {
        if (getRuntimeKey() !== pending.runtime) throw new Error(t('settings.harness.credentialFailed'));
        const sent = pending.key;
        const response = await runtimeFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: sent.trim() }) });
        if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
        if (pending.key === sent) {
          // Keep the text while focused: a typing pause must not erase the
          // prefix before the user continues entering the same credential.
          pending.dirty = false;
        }
        if (pending.mounted) setConfigured(true);
      }
    } catch (failure) { if (pending.mounted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.active = false; if (pending.mounted) setBusy(false); }
  }, [url, t]);
  React.useEffect(() => () => { clearTimeout(timer.current); void save(); }, [save]);

  return <SettingsFieldRow label={t('settings.page.harness.web.search.apiKey')} controlClassName="@xl:flex-1 @xl:max-w-80">
    <div className="w-full space-y-2">
      {configured && !editing ? <div className="flex flex-wrap items-center gap-2">
        <span className="typography-meta text-muted-foreground">{t('settings.page.harness.web.search.configured')}</span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('settings.harness.replace')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
          setBusy(true); setError(null);
          void runtimeFetch(url, { method: 'DELETE' }).then((response) => {
            if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
            setConfigured(false);
          }).catch((failure) => setError(String(failure))).finally(() => setBusy(false));
        }}>{t('settings.harness.rules.remove')}</Button>
      </div> : <Input type="password" autoComplete="new-password" aria-label={t('settings.page.harness.web.search.apiKey')}
        value={key} placeholder={t('settings.page.harness.web.search.notConfigured')}
        onChange={(event) => {
          const value = event.target.value; setEditing(true); setKey(value); state.current.key = value; state.current.dirty = Boolean(value.trim());
          clearTimeout(timer.current); if (!(event.nativeEvent as InputEvent).isComposing) timer.current = setTimeout(() => { void save(); }, 650);
        }} onCompositionEnd={() => { clearTimeout(timer.current); timer.current = setTimeout(() => { void save(); }, 650); }}
        onBlur={() => { void save().then(() => { if (state.current.mounted && !state.current.dirty) { setEditing(false); setKey(''); state.current.key = ''; } }); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />}
      <p className="typography-meta text-muted-foreground">{t(busy ? 'settings.common.actions.saving' : 'settings.page.harness.web.search.apiKey.description')}</p>
      {error ? <div role="alert" className="typography-meta text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => { if (state.current.dirty) void save(); else { setError(null); setAttempt((value) => value + 1); } }}>{t('settings.harness.retry')}</Button></div> : null}
    </div>
  </SettingsFieldRow>;
}

export function WebSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const [provider, setProvider] = React.useState<HarnessWebSearchProvider | 'default'>(harness.web?.search?.provider ?? 'default');
  const providerRef = React.useRef(provider);
  const [endpoint, setEndpoint] = React.useState(harness.web?.search?.endpoint ?? '');
  const allow = harness.web?.domains?.allow;
  const allowEnabled = React.useRef(allow !== undefined);
  allowEnabled.current = allow !== undefined;
  const commitSearch = (nextProvider: typeof provider, nextEndpoint: string) => {
    if (providerRef.current !== nextProvider) return;
    if (nextProvider === 'default') { update({ web: { search: undefined } }); return; }
    if (nextProvider === 'searxng' && !nextEndpoint.trim()) return;
    update({ web: { search: { provider: nextProvider, endpoint: nextEndpoint.trim() || undefined, credentialRef: `varin-web-search-${nextProvider}` } } });
  };
  return <>
    <OutboundNetworkSettings />
    <SettingsSection title={t('settings.page.harness.section.web')} settingsItem="harness.web.search" contentClassName="space-y-5">
      <SettingsCheckboxRow checked={harness.tools.websearch !== false} onChange={(enabled) => update({ tools: { websearch: enabled } })}
        ariaLabel={t('settings.page.harness.web.search.enabled')} label={t('settings.page.harness.web.search.enabled')} />
      <SettingsFieldRow label={t('settings.page.harness.web.search.provider')} description={t('settings.page.harness.web.search.provider.description')}>
        <Select value={provider} onValueChange={(value) => {
          const next = value as typeof provider; providerRef.current = next; setProvider(next); setEndpoint(''); commitSearch(next, '');
        }}>
          <SelectTrigger size="settings" className="w-64" aria-label={t('settings.page.harness.web.search.provider')}><SelectValue>{provider === 'default' ? t('settings.page.harness.web.search.default') : providerName(provider)}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="default">{t('settings.page.harness.web.search.default')}</SelectItem>{providers.map((item) => <SelectItem key={item} value={item}>{providerName(item)}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      {provider === 'default' ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.web.search.default.description')}</p> : null}
      {provider === 'searxng' ? <SettingsFieldRow label={t('settings.page.harness.web.search.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={endpoint} placeholder="http://127.0.0.1:8080" aria-label={t('settings.page.harness.web.search.endpoint')}
          validate={(value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? null : t('settings.harness.validUrl'); } catch { return t('settings.harness.validUrl'); } }}
          onCommit={(value) => { setEndpoint(value); commitSearch(provider, value); }} />
      </SettingsFieldRow> : null}
      {provider !== 'default' ? <SearchCredential key={provider} provider={provider} /> : null}
      {provider === 'searxng' && !endpoint ? <p className="typography-meta text-muted-foreground">{t('settings.harness.completeFields')}</p> : null}
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.web.render')} settingsItem="harness.web.render">
      <SettingsCheckboxRow checked={harness.web?.render === true} onChange={(render) => update({ web: { render } })}
        disabled={!isDesktopLocalOriginActive()} ariaLabel={t('settings.page.harness.web.render')}
        label={t('settings.page.harness.web.render')} description={t('settings.page.harness.web.render.description')} />
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.web.documentReading.title')}
      description={t('settings.page.harness.web.documentReading.description')}
      settingsItem="harness.document-reading" contentClassName="space-y-4">
      <HarnessModelField harness={harness} update={update} slot="reader" />
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.doclingCommand')}
        description={t('settings.page.harness.web.documentReading.executableHint')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.doclingCommand}
          placeholder="docling" aria-label={t('settings.page.harness.web.documentReading.doclingCommand')}
          onCommit={(value) => update({ documentReading: { doclingCommand: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.tesseractCommand')}
        description={t('settings.page.harness.web.documentReading.executableHint')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.tesseractCommand}
          placeholder="tesseract" aria-label={t('settings.page.harness.web.documentReading.tesseractCommand')}
          onCommit={(value) => update({ documentReading: { tesseractCommand: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.web.documentReading.ocrLanguage')}
        controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={harness.documentReading.ocrLanguage}
          placeholder="eng" aria-label={t('settings.page.harness.web.documentReading.ocrLanguage')}
          onCommit={(value) => update({ documentReading: { ocrLanguage: value.trim() || undefined } })} />
      </SettingsFieldRow>
      <p className="typography-meta text-muted-foreground">
        {t('settings.page.harness.web.documentReading.defaultsRestored')}
      </p>
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.web.domains.title')} description={t('settings.page.harness.web.domains.description')}
      settingsItem="harness.web.domains" contentClassName="space-y-5">
      <SettingsCheckboxRow checked={allow !== undefined} onChange={(enabled) => { allowEnabled.current = enabled; update({ web: { domains: { allow: enabled ? [] : undefined } } }); }}
        ariaLabel={t('settings.page.harness.web.domains.allowEnabled')} label={t('settings.page.harness.web.domains.allowEnabled')}
        description={t('settings.page.harness.web.domains.allowEnabled.description')} />
      {allow !== undefined ? <SettingsFieldRow label={t('settings.page.harness.web.domains.allow')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={allow.join(', ')} onCommit={(value) => { if (allowEnabled.current) update({ web: { domains: { allow: domainList(value) } } }); }}
          aria-label={t('settings.page.harness.web.domains.allow')} placeholder="example.com, docs.example.com" />
      </SettingsFieldRow> : null}
      <SettingsFieldRow label={t('settings.page.harness.web.domains.block')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={(harness.web?.domains?.block ?? []).join(', ')} onCommit={(value) => update({ web: { domains: { block: domainList(value) } } })}
          aria-label={t('settings.page.harness.web.domains.block')} placeholder="ads.example.com" />
      </SettingsFieldRow>
    </SettingsSection>
  </>;
}
