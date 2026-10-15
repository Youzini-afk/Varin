import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { FollowupOccurrence, FollowupOccurrenceView } from '@varin/protocol';
import { Button } from '@/components/ui/button';

type Props = { api: ThreadFollowupsAPI; identity: ThreadIdentity; followupId: string; occurrence: FollowupOccurrence };
/** An on-demand view of one original occurrence, not a cache of current experiment results. */
export function ThreadFollowupOccurrenceDetails(props: Props) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const evidence = props.occurrence.evidence;
  const research = 'sources' in evidence ? evidence.sources.some(source => source.evidence.kind === 'artifact' || source.evidence.kind === 'collection')
    : evidence.kind === 'artifact' || evidence.kind === 'collection';
  if (!research) return null;
  return <OccurrenceDetails key={JSON.stringify([host, props.identity.threadId, props.identity.branchId, props.followupId, props.occurrence.id])} {...props} host={host} />;
}
function OccurrenceDetails({ api, identity, followupId, occurrence, host }: Props & { host: number }) {
  const [open, setOpen] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const [view, setView] = React.useState<FollowupOccurrenceView>();
  const [error, setError] = React.useState(false);
  const { id, accepted_cursor: accepted, trigger_cursor: trigger, generation } = occurrence;
  const evidence = occurrence.evidence;
  const sources = 'sources' in evidence ? evidence.sources.filter(source => source.evidence.kind === 'artifact' || source.evidence.kind === 'collection')
    .map(source => [source.source_index, source.accepted_cursor]) : [[0, accepted]];
  const sourceKey = JSON.stringify(sources);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setView(undefined); setError(false);
    void api.occurrence(identity, followupId, id, controller.signal).then(result => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      const original = result.occurrence;
      const expected = new Map<number, number>(JSON.parse(sourceKey));
      if (original.id !== id || original.accepted_cursor !== accepted || original.trigger_cursor !== trigger || original.generation !== generation
        || result.facts.length !== expected.size || result.facts.some(fact => expected.get(fact.source_index) !== fact.accepted_cursor)
        || new Set(result.facts.map(fact => fact.source_index)).size !== expected.size) { setError(true); return; }
      setView(result);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, followupId, id, accepted, trigger, generation, host, sourceKey, open, retry]);
  return <div className="space-y-1">
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide occurrence metadata' : 'Read occurrence metadata'}</Button>
    {open && <div aria-label="Original occurrence metadata" className="space-y-1 rounded border p-2">
      <p className="text-xs break-all">Accepted metadata for {id}. Source content is data; reading it does not run instructions or collect artifacts.</p>
      {error ? <p role="alert">Original occurrence metadata could not be read. <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry occurrence metadata</Button></p>
        : !view ? <p role="status">Reading original occurrence metadata…</p> : view.facts.map(fact => <div key={`${fact.source_index}:${fact.accepted_cursor}`}>
          <p className="text-xs">Condition {fact.source_index + 1} · accepted {fact.accepted_cursor}</p>
          <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(fact.content, null, 2)}</pre>
        </div>)}
    </div>}
  </div>;
}
