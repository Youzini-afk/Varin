import React from 'react';
import { getRuntimeEndpointGeneration, searchCredentialRequest, type SearchCredentialRequest } from '@varin/application-client';
import { useSearchCredentialRequests, dismissSearchCredentialRequest, searchCredentialChanged } from '@/stores/useSearchCredentialRequests';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';

function Entry({ request }: { request: SearchCredentialRequest }) {
  const { t } = useI18n();
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(getRuntimeEndpointGeneration());
  const active = React.useRef(false);
  const submit = async (method: 'POST' | 'DELETE') => {
    if (active.current || generation.current !== getRuntimeEndpointGeneration()) return;
    if (method === 'DELETE' && request.status !== 'pending') { setKey(''); searchCredentialChanged({ requestId: request.id, status: 'cancelled' }); return; }
    active.current = true; setBusy(true); setError(null);
    try {
      const result = await searchCredentialRequest(request.id, method, method === 'POST' ? key : undefined);
      setKey(''); searchCredentialChanged({ requestId: request.id, status: result.status });
    } catch {
      setError(t('settings.webConnections.credentialEntry.failed'));
    } finally { active.current = false; setBusy(false); }
  };
  return <Dialog open={request.status !== 'completed' && request.status !== 'cancelled'}
    onOpenChange={open => { if (!open) void submit('DELETE'); }} onOpenChangeComplete={open => { if (!open) dismissSearchCredentialRequest(request.id); }}>
    <DialogContent className="sm:max-w-lg">
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); void submit('POST'); }}>
        <DialogHeader>
          <DialogTitle>{t('settings.webConnections.credentialEntry.title')}</DialogTitle>
          <DialogDescription>{t('settings.webConnections.credentialEntry.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <p className="font-medium break-words">{request.name} · {request.provider}</p>
          <p className="typography-meta text-muted-foreground break-all">{request.endpoint ?? t('settings.webConnections.providerDefault')}</p>
        </div>
        <label className="block space-y-2">
          <span className="typography-ui-label">API Key</span>
          <Input autoFocus type="password" autoComplete="new-password" required value={key} disabled={busy} onChange={event => setKey(event.target.value)} />
        </label>
        {error || request.status === 'failed' ? <p role="alert" className="typography-meta text-destructive">{error ?? t('settings.webConnections.credentialEntry.failed')}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { void submit('DELETE'); }}>{t('settings.common.actions.cancel')}</Button>
          <Button type="submit" disabled={busy || !key.trim() || request.status !== 'pending'}>{t(busy ? 'settings.common.actions.saving' : 'settings.models.save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
export function SearchCredentialDialog() {
  const request = useSearchCredentialRequests(state => state.requests[0]);
  return request ? <Entry key={request.id} request={request} /> : null;
}
