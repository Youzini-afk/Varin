import React from 'react';
import { ExternalAgentError, type ExternalConversationSnapshot } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ExternalAuthentication } from './ExternalAuthentication';

export function ExternalConnectionStatus({ snapshot, name, cwd, busy, cancelling, error, reconnectDisabled, onReconnect, onCancel, onAuthenticate }: {
  snapshot?: ExternalConversationSnapshot; name?: string; cwd?: string; busy?: boolean; cancelling?: boolean; error?: unknown;
  reconnectDisabled?: boolean; onReconnect(): void; onCancel?(): void; onAuthenticate?(methodId: string): void;
}) {
  const { t } = useI18n();
  const authentication = error instanceof ExternalAgentError ? error.details?.authentication : undefined;
  const cannotResume = snapshot?.connected && snapshot.capabilities?.resume === false;
  const errorText = error instanceof Error ? error.message : error ? String(error) : snapshot?.connection?.error;
  const status = busy ? 'preparing' : authentication ? 'authentication_required' : errorText ? 'failed'
    : snapshot?.connection?.status ?? (snapshot?.connected ? 'connected' : 'disconnected');
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" aria-label={`${t('external.details')}: ${t(`external.connection.${status}`)}`} className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover">
      {status === 'preparing' ? <Icon name="loader-4" className="size-3 animate-spin" /> : <span aria-hidden="true" className={status === 'connected' ? 'text-green-500' : status === 'failed' || status === 'authentication_required' ? 'text-amber-500' : ''}>●</span>}
      <span aria-live="polite">{t(`external.connection.${status}`)}</span>
    </button></DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="end" portalToBody className="max-w-[min(26rem,90vw)] p-3">
      <dl className="space-y-2 typography-meta">
        <div><dt>{name ?? snapshot?.conversation.harness}</dt><dd className="break-all text-muted-foreground">{cwd ?? snapshot?.conversation.cwd}</dd></div>
        {snapshot?.capabilities?.protocol && <div><dt>{t('external.protocol')}</dt><dd>{[snapshot.capabilities.protocol.name, snapshot.capabilities.protocol.version, snapshot.capabilities.protocol.agentVersion].filter(Boolean).join(' · ')}</dd></div>}
        {snapshot?.conversation.sessionId && <div><dt>{t('external.nativeSession')}</dt><dd className="break-all text-muted-foreground">{snapshot.conversation.sessionId}</dd></div>}
      </dl>
      {errorText && <p role="alert" className="mt-2 whitespace-pre-wrap break-words typography-meta text-destructive">{errorText}</p>}
      {authentication && onAuthenticate && <ExternalAuthentication authentication={authentication} pending={Boolean(busy)} authenticate={onAuthenticate} />}
      {cannotResume && <p className="mt-2 typography-meta text-muted-foreground">{t('external.reconnectUnsupported')}</p>}
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy || reconnectDisabled || cannotResume} onClick={onReconnect}>{t('external.reconnect')}</Button>
        {busy && onCancel && <Button type="button" size="sm" variant="ghost" disabled={cancelling} onClick={onCancel}>{t('external.cancelConnection')}</Button>}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}
