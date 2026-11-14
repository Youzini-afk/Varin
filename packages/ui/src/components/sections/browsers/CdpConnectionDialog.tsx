import React from 'react';
import type { BrowserConnection } from '@varin/protocol';
import { browserResources } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { registerSettingsDraft, requestSettingsNavigation } from '@/lib/settings/drafts';

export function CdpConnectionDialog({ connection, device, onSave, onClose }: { connection: BrowserConnection; device: string; onSave(value: BrowserConnection): Promise<void>; onClose(): void }) {
  const { t } = useI18n();
  const [label, setLabel] = React.useState(connection.label), [endpoint, setEndpoint] = React.useState(connection.endpoint);
  const [directory, setDirectory] = React.useState(connection.scratchDirectory ?? '');
  const [headers, setHeaders] = React.useState(connection.headers ? JSON.stringify(connection.headers, null, 2) : '');
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [result, setResult] = React.useState('');
  const busyRef = React.useRef(false);
  const value = (): BrowserConnection => ({ id: connection.id, label: label.trim(), endpoint: endpoint.trim(),
    ...(directory.trim() ? { scratchDirectory: directory.trim() } : {}), ...(headers.trim() ? { headers: JSON.parse(headers) as Record<string, string> } : {}) });
  const valid = !!label.trim() && !!endpoint.trim();
  const dirty = label !== connection.label || endpoint !== connection.endpoint || directory !== (connection.scratchDirectory ?? '') || headers !== (connection.headers ? JSON.stringify(connection.headers, null, 2) : '');
  const perform = async (probe: boolean) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(''); setResult('');
    try {
      const next = value();
      if (probe) { const response = await browserResources.probe(next, device); setResult(t('settings.browser.probed', { count: response.pages })); }
      else await onSave(next);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const draft = React.useRef({ dirty, saving: busy, saveDisabled: !valid, onSave: () => perform(false), onCancel: onClose });
  draft.current = { dirty, saving: busy, saveDisabled: !valid, onSave: () => perform(false), onCancel: onClose };
  React.useEffect(() => registerSettingsDraft(`browser:${connection.id}`, () => draft.current), [connection.id]);
  return <Dialog open onOpenChange={open => { if (!open) requestSettingsNavigation(onClose); }}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle>{t('settings.browser.cdpTitle')}</DialogTitle><DialogDescription>{t('settings.browser.cdpHint')}</DialogDescription></DialogHeader>
    <form id="browser-cdp" className="grid gap-4" onSubmit={event => { event.preventDefault(); void perform(false); }}>
      <label className="grid gap-2 typography-meta">{t('settings.browser.name')}<Input autoFocus value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label className="grid gap-2 typography-meta">{t('settings.browser.endpoint')}<Input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:9222" autoComplete="off" spellCheck={false} /></label>
      <details className="typography-meta"><summary className="cursor-pointer text-muted-foreground">{t('settings.browser.advanced')}</summary><div className="mt-4 grid gap-4">
        <label className="grid gap-2">{t('settings.browser.fileDirectory')}<Input value={directory} onChange={event => setDirectory(event.target.value)} autoComplete="off" /><span className="text-muted-foreground">{t('settings.browser.fileDirectoryHint')}</span></label>
        <label className="grid gap-2">{t('settings.browser.headers')}<textarea value={headers} onChange={event => setHeaders(event.target.value)} className="min-h-20 rounded-lg border border-input bg-transparent p-3 font-mono" autoComplete="off" spellCheck={false} placeholder={'{"Authorization":"Bearer …"}'} /></label>
      </div></details>
      {error && <p role="alert" className="break-words typography-meta text-destructive">{error}</p>}{result && <p role="status" className="typography-meta text-muted-foreground">{result}</p>}
    </form>
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button><Button variant="outline" disabled={busy || !valid} onClick={() => void perform(true)}>{t('settings.browser.probe')}</Button><Button type="submit" form="browser-cdp" disabled={busy || !valid}>{t('settings.common.actions.saveChanges')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
