import React from 'react';
import { ThreadSidebar } from '@/components/thread/ThreadSidebar';
import { useThreadStore } from '@/stores/useThreadStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { MobileSurfaceShell } from './MobileSurfaceShell';
import { useI18n } from '@/lib/i18n';

export function MobileSessionsSheet({ open, onOpenChange, variant = 'sheet' }: {
  open: boolean; onOpenChange(open: boolean): void; variant?: 'sheet' | 'sidebar' | 'content';
}) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const directory = useDirectoryStore(state => state.currentDirectory);
  const previous = React.useRef(useThreadStore.getState().selectedIdentity);
  React.useEffect(() => useThreadStore.subscribe(state => {
    if (state.selectedIdentity !== previous.current) { previous.current = state.selectedIdentity; onOpenChange(false); }
  }), [onOpenChange]);
  if (!open) return null;
  const content = <div className="flex h-full min-h-0 flex-col">
    <label className="px-3 pt-3 text-xs text-muted-foreground">Workspace for new conversations
      <select aria-label="Workspace for new conversations" value={directory ?? ''} className="mt-1 w-full rounded border bg-background px-2 py-2" onChange={event => useDirectoryStore.getState().setDirectory(event.target.value)}>
        <option value="">Chat only</option>
        {directory && !projects.some(project => project.path === directory) && <option value={directory}>{directory}</option>}
        {projects.map(project => <option key={project.id} value={project.path}>{project.label || project.path}</option>)}
      </select>
    </label>
    <div className="min-h-0 flex-1"><ThreadSidebar mobileVariant /></div>
  </div>;
  return variant === 'sheet' ? <MobileSurfaceShell open title={t('mobile.sessions.sheet.title')} onClose={() => onOpenChange(false)}>{content}</MobileSurfaceShell> : content;
}
