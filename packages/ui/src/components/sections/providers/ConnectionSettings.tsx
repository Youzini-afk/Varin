import React from 'react';
import type { ModelChannel, ChannelTypeInfo, ModelConnectionOptions, ConnectionAuthentication, AuthorizationState } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { AuthorizationPanel } from '../shared/AuthorizationPanel';
import { JsonObjectField } from '../shared/JsonObjectField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

interface Props {
  draft: ModelChannel; type: ChannelTypeInfo; busy: boolean; advanced: boolean; secret: string;
  authorization: AuthorizationState | null;
  edit(patch: Partial<ModelChannel>): void;
  editConnection(patch: Partial<ModelConnectionOptions>): void;
  validity(key: string, valid: boolean): void;
  setSecret(value: string): void;
  cancelAuthorization(): void;
  onSignIn(provider: string): void;
  onSignOut(): void;
  onAuthorizationReply(value: string): Promise<void>;
  onAuthorizationCancel(): Promise<void>;
}
export function ConnectionSettings({ draft, type, busy, advanced, secret, authorization, edit, editConnection, validity, setSecret, cancelAuthorization, onSignIn, onSignOut, onAuthorizationReply, onAuthorizationCancel }: Props) {
  const { t } = useI18n();
  const labels: Record<string, string> = { deployment: t('settings.models.parameter.deployment'), apiVersion: t('settings.models.parameter.apiVersion'), project: t('settings.models.parameter.project'), location: t('settings.models.parameter.location'), region: t('settings.models.parameter.region'), imageApi: t('settings.models.parameter.imageApi') };
  return <>
    <div hidden={advanced}>
      <SettingsSection title={t('settings.models.connection')} divider={false}>
          <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.name')}><Input aria-label={t('settings.models.name')} value={draft.name} disabled={busy} onChange={event => edit({ name: event.target.value })} /></SettingsFieldRow>
          <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.endpoint')}><Input aria-label={t('settings.models.endpoint')} value={draft.baseUrl} disabled={busy} onChange={event => edit({ baseUrl: event.target.value })} /></SettingsFieldRow>
          <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.authentication')}><Select value={draft.authentication.kind} disabled={busy} onValueChange={kind => { cancelAuthorization(); setSecret(''); edit({ authentication: kind === 'credential' ? { kind, reference: '' } : kind === 'environment' ? { kind, variable: '' } : kind === 'anthropic-federation' ? { kind, identityTokenFile: '', organizationId: '', federationRuleId: '' } : { kind } as ConnectionAuthentication }); }}>
            <SelectTrigger size="settings" aria-label={t('settings.models.authentication')}><SelectValue /></SelectTrigger><SelectContent>{type.authentication.map(kind => <SelectItem key={kind} value={kind}>{t(`settings.models.auth.${kind}`)}</SelectItem>)}</SelectContent>
          </Select></SettingsFieldRow>
          {draft.authentication.kind === 'credential' ? <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.apiKey')}><Input type="password" aria-label={t('settings.models.apiKey')} autoComplete="off" value={secret} disabled={busy} placeholder={draft.authentication.reference ? t('settings.models.credentialSaved') : ''} onChange={event => { setSecret(event.target.value); }} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'credential' && type.oauthProviders?.length ? <div className="flex flex-wrap gap-2">{type.oauthProviders.map(provider => <Button key={provider.id} variant="outline" disabled={busy || authorization?.status === 'pending'} onClick={() => onSignIn(provider.id)}>{t('settings.mcp.signIn')} · {provider.name}</Button>)}</div> : null}
          {draft.authentication.kind === 'credential' && draft.authentication.reference ? <Button size="sm" variant="ghost" disabled={busy || authorization?.status === 'pending'} onClick={onSignOut}>{t('settings.models.removeCredential')}</Button> : null}
          {authorization ? <AuthorizationPanel key={authorization.id} state={authorization} onReply={onAuthorizationReply} onCancel={onAuthorizationCancel} /> : null}
          {draft.authentication.kind === 'environment' ? <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.environment')}><Input aria-label={t('settings.models.environment')} value={draft.authentication.variable} disabled={busy} onChange={event => edit({ authentication: { kind: 'environment', variable: event.target.value } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'google-adc' ? <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.credentialFile')}><Input value={draft.authentication.file ?? ''} disabled={busy} onChange={event => edit({ authentication: event.target.value ? { kind: 'google-adc', file: event.target.value } : { kind: 'google-adc' } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'aws-chain' ? <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.profile')}><Input value={draft.authentication.profile ?? ''} disabled={busy} onChange={event => edit({ authentication: event.target.value ? { kind: 'aws-chain', profile: event.target.value } : { kind: 'aws-chain' } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'anthropic-federation' ? <>
            <p className="typography-meta text-muted-foreground">{t('settings.models.federationHint')}</p>
            {(['identityTokenFile', 'organizationId', 'federationRuleId', 'serviceAccountId', 'workspaceId'] as const).map(key => {
              const authentication = draft.authentication as Extract<ConnectionAuthentication, { kind: 'anthropic-federation' }>;
              return <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" key={key} label={t(`settings.models.federation.${key}`)}><Input
                value={authentication[key] ?? ''} disabled={busy} autoComplete="off" aria-label={t(`settings.models.federation.${key}`)}
                onChange={event => {
                  const next = { ...authentication };
                  if (!event.target.value && (key === 'workspaceId' || key === 'serviceAccountId')) delete next[key];
                  else next[key] = event.target.value;
                  edit({ authentication: next });
                }} /></SettingsFieldRow>;
            })}
          </> : null}
          {Object.entries((type.parametersSchema.properties ?? {}) as Record<string, Record<string, JsonValue>>).map(([key, schema]) => <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" key={key} label={labels[key] ?? key}>
            {Array.isArray(schema.enum) ? <Select value={String(draft.parameters[key] ?? '__unset')} disabled={busy} onValueChange={value => { const parameters = { ...draft.parameters }; if (value === '__unset') delete parameters[key]; else parameters[key] = value; edit({ parameters }); }}><SelectTrigger size="settings" aria-label={labels[key] ?? key}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__unset">{t('settings.models.default')}</SelectItem>{schema.enum.map(value => <SelectItem key={String(value)} value={String(value)}>{String(value)}</SelectItem>)}</SelectContent></Select>
              : <Input value={String(draft.parameters[key] ?? '')} disabled={busy} aria-label={labels[key] ?? key} onChange={event => { const parameters = { ...draft.parameters }; if (event.target.value) parameters[key] = event.target.value; else delete parameters[key]; edit({ parameters }); }} />}
          </SettingsFieldRow>)}
      </SettingsSection>
    </div>
    <div hidden={!advanced}>
      <SettingsSection title={t('settings.models.advanced')} divider={false}>
          <details className="space-y-3"><summary className="cursor-pointer typography-meta">{t('settings.models.network')}</summary>
            <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.proxy')}><Select value={draft.connection?.proxy?.mode ?? 'host'} disabled={busy} onValueChange={mode => editConnection({ proxy: mode === 'host' ? undefined : mode === 'direct' ? { mode } : { mode: 'proxy', url: '' } })}>
              <SelectTrigger size="settings" aria-label={t('settings.models.proxy')}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="host">{t('settings.models.proxyHost')}</SelectItem><SelectItem value="direct">{t('settings.models.proxyDirect')}</SelectItem><SelectItem value="proxy">{t('settings.models.proxyCustom')}</SelectItem>
              </SelectContent></Select></SettingsFieldRow>
            {draft.connection?.proxy?.mode === 'proxy' ? <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.proxyUrl')}><Input aria-label={t('settings.models.proxyUrl')} value={draft.connection.proxy.url} disabled={busy} placeholder="http://127.0.0.1:8080" onChange={event => editConnection({ proxy: { mode: 'proxy', url: event.target.value } })} /></SettingsFieldRow> : null}
            <p className="typography-micro text-muted-foreground">{t('settings.models.proxyHint')}</p>
            <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" label={t('settings.models.headers')}><JsonObjectField value={draft.connection?.headers} label={t('settings.models.headers')} disabled={busy} validate={headers => Object.values(headers).every(value => typeof value === 'string')} onValidityChange={valid => validity('connection:headers', valid)} onChange={headers => {
              editConnection({ headers: headers as Record<string, string> | undefined });
            }} /></SettingsFieldRow>
            <p className="typography-micro text-muted-foreground">{t('settings.models.headersHint')}</p>
            <p className="typography-micro text-muted-foreground">{t('settings.models.pathsHint')}</p>
            {type.operations.filter(operation => operation !== 'decision' || type.protocol !== 'llama-cpp-classify').map(operation => <SettingsFieldRow controlClassName="w-full @xl:flex-1 @xl:max-w-xl" key={operation} label={t(`settings.models.operation.${operation}`)}><Input aria-label={`${t('settings.models.path')}: ${t(`settings.models.operation.${operation}`)}`} value={draft.connection?.paths?.[operation] ?? ''} disabled={busy} placeholder={t('settings.models.default')} onChange={event => {
              const paths = { ...draft.connection?.paths };
              if (event.target.value) paths[operation] = event.target.value; else delete paths[operation];
              editConnection({ paths: Object.keys(paths).length ? paths : undefined });
            }} /></SettingsFieldRow>)}
          </details>
          <details><summary className="cursor-pointer typography-meta">{t('settings.models.parameters')}</summary><JsonObjectField value={draft.parameters} label={t('settings.models.parameters')} disabled={busy} onValidityChange={valid => validity('channel', valid)} onChange={parameters => edit({ parameters: parameters ?? {} })} /></details>
      </SettingsSection>
    </div>
  </>;
}
