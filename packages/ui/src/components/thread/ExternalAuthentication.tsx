import React from 'react';
import type { ExternalAuthentication as Authentication } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

/** Terminal methods are instructions, never a renderer-owned login or shell invocation. */
export function ExternalAuthentication({ authentication, pending, authenticate }: {
  authentication: Authentication;
  pending: boolean;
  authenticate(methodId: string): void;
}) {
  const { t } = useI18n();
  return <section aria-label={t('external.authentication')} className="my-3 space-y-3 rounded-lg border border-border p-3 typography-meta">
    <p className="font-medium">{t('external.authentication')}</p>
    {authentication.guidance && <p className="whitespace-pre-wrap">{authentication.guidance}</p>}
    {authentication.methods.map(method => <div key={method.id} className="space-y-1">
      {method.type === 'agent' ? <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => authenticate(method.id)}>{method.name}</Button>
        : <><p>{method.name}</p><p className="text-muted-foreground">{t('external.terminalAuthentication')}</p>
          {method.command && <><p className="text-muted-foreground">{t('external.authenticationArgv')}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify([method.command, ...(method.args ?? [])], null, 2)}</pre></>}</>}
      {method.description && <p className="whitespace-pre-wrap text-muted-foreground">{method.description}</p>}
    </div>)}
  </section>;
}
