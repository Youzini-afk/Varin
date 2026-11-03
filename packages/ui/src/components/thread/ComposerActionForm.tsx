import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';

export function ComposerActionForm({ initial, label, description, confirm, onDone, danger = false }: {
  initial?: string; label?: string; description?: string; confirm(value: string): Promise<void>; onDone(): void; danger?: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initial ?? '');
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState<string>();
  const host = React.useRef(getRuntimeEndpointGeneration());
  return <div className="space-y-3 typography-ui-label">
    {description && <p className="whitespace-pre-wrap text-muted-foreground">{description}</p>}
    {label && <label className="block space-y-1"><span>{label}</span><input autoFocus aria-label={label} value={value} disabled={busy} onChange={event => setValue(event.target.value)} className="w-full rounded-md border bg-background px-2 py-2" /></label>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <button type="button" disabled={busy || Boolean(label && !value.trim())} className={`rounded-md border px-3 py-1.5 ${danger ? 'text-destructive' : ''}`} onClick={() => {
      if (pending.current || host.current !== getRuntimeEndpointGeneration()) return;
      pending.current = true; setBusy(true); setError(undefined);
      void confirm(value.trim()).then(onDone, cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => { pending.current = false; setBusy(false); });
    }}>{t('composer.confirm')}</button>
  </div>;
}

