import React from 'react';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { WorkOverviewControl, type OverviewPeekSection } from './WorkOverviewControl';
import { WorkOverviewSection } from './WorkOverviewSection';

/** Disclosure belongs to the inspector, so opening it does not redraw a streaming conversation. */
export function ThreadWorkOverview({ sessionKey, onViewChange, ...props }: Omit<React.ComponentProps<typeof WorkOverviewControl>,
  'open' | 'compactOpen' | 'onOpenChange' | 'onCompactChange'> & { sessionKey: string; onViewChange(): void }) {
  const open = useWorkOverviewStore(state => state.bySession[sessionKey]?.overview ?? false);
  const compactOpen = useWorkOverviewStore(state => state.bySession[sessionKey]?.compact ?? false);
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  return <WorkOverviewControl {...props} open={open} compactOpen={compactOpen}
    onOpenChange={value => { onViewChange(); disclosure(sessionKey, 'overview', value); }}
    onCompactChange={value => { onViewChange(); disclosure(sessionKey, 'compact', value); }} />;
}

export function ThreadWorkOverviewSection({ sessionKey, section, ...props }: Omit<React.ComponentProps<typeof WorkOverviewSection>,
  'open' | 'onOpenChange'> & { sessionKey: string; section: OverviewPeekSection }) {
  const open = useWorkOverviewStore(state => state.bySession[sessionKey]?.[section] ?? false);
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  return <WorkOverviewSection {...props} open={open} onOpenChange={value => disclosure(sessionKey, section, value)} />;
}
