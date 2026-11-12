import React from 'react';
import type { SourceResourceOwner } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type ThreadSourceTargets } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Button } from '@/components/ui/button';
const key = (owner: SourceResourceOwner) => JSON.stringify(owner);
/** Listing is passive; only the explicit folder registration contacts the target Documents owner. */
export function ProjectSourceEditor({ value, onChange, disabled }: { value: SourceResourceOwner; onChange(value: SourceResourceOwner): void; disabled?: boolean }) {
  const { threads } = useRuntimeAPIs();
  const [targets, setTargets] = React.useState<ThreadSourceTargets>({ targets: [], unavailable: [] });
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current += 1; }, [threads]);
  const refresh = async () => {
    const host = getRuntimeEndpointGeneration();
    const request = ++generation.current; setLoading(true); setError(null);
    try { if (!threads) throw new Error('Source Hosts are unavailable'); const result = await threads.sources.list(null); if (request === generation.current && host === getRuntimeEndpointGeneration()) setTargets(result); }
    catch (failure) { if (request === generation.current && host === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (request === generation.current && host === getRuntimeEndpointGeneration()) setLoading(false); }
  };
  const available = targets.targets.some(target => key(target.resourceOwner) === key(value));
  return <div className="space-y-2">
    <label className="block space-y-2 typography-ui-label"><span>Source Host</span>
      <select className="w-full rounded-md border border-input bg-background px-3 py-2" aria-label="Project source Host" value={key(value)} disabled={disabled} onChange={event => onChange(JSON.parse(event.target.value) as SourceResourceOwner)}>
        <option value={key({ kind: 'local' })}>This Host</option>
        {value.kind === 'managed_host' && !available && <option value={key(value)}>{value.hostId} (saved source)</option>}
        {targets.targets.filter(target => target.resourceOwner.kind !== 'local').map(target => <option key={key(target.resourceOwner)} value={key(target.resourceOwner)}>{target.label}</option>)}
      </select>
    </label>
    <Button type="button" variant="ghost" size="sm" disabled={disabled || loading} onClick={() => void refresh()}>Refresh configured Hosts</Button>
    {targets.unavailable.map((entry, index) => <p key={index} className="typography-meta text-muted-foreground">{entry.label}: {entry.message}</p>)}
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
  </div>;
}
