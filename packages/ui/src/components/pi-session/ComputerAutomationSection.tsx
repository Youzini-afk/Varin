import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { useComputerAutomation } from '@/stores/useComputerAutomation';

export function ComputerAutomationSection({ view, directory }: { view: ReturnType<typeof useComputerAutomation>; directory: string }) {
  const { t } = useI18n();
  const openTab = useUIStore(state => state.openContextPanelTab);
  const state = view.state;
  const desktops = new Set([...state?.leases.map(lease => lease.desktopId) ?? [], ...view.activities.map(entry => entry.desktopId)]);
  const pending = state?.requests.filter(item => item.status === 'pending') ?? [];
  const status = state?.status ?? 'enabled';
  return <div className="space-y-3">
    {status !== 'enabled' ? <p role="status" className="typography-meta text-muted-foreground">{t(`computer.automation.${status}`)}</p> : null}
    {[...desktops].map(desktopId => {
      const leases = state?.leases.filter(lease => lease.desktopId === desktopId) ?? [];
      const controller = leases.find(lease => lease.access === 'control');
      const activity = view.activities.find(entry => entry.desktopId === desktopId)?.activity;
      const desktopLabel = leases.find(lease => lease.desktopLabel)?.desktopLabel ?? desktopId;
      const operator = controller?.actor.sessionId === state?.rootSessionId ? t('computer.automation.main') : controller?.actor.label;
      return <button key={desktopId} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-interactive-hover"
        onClick={() => openTab(directory, { mode: 'computer', targetPath: desktopId, dedupeKey: `desktop:${desktopId}`, label: desktopLabel })}>
        <Icon name={activity?.status === 'running' ? 'loader-4' : 'computer'} className={`size-4 shrink-0 text-muted-foreground ${activity?.status === 'running' ? 'animate-spin' : ''}`} />
        <span className="min-w-0 flex-1"><span className="block truncate typography-meta">{desktopLabel}</span>
          <span className="block truncate typography-micro text-muted-foreground">{controller?.suspended ? t('settings.computers.view.control.you') : operator ?? t('computer.automation.observeOnly')}{activity?.status === 'running' ? ` · ${t(`computer.operation.${activity.operation}`)}` : ''}</span>
          {activity ? <span className="block truncate typography-micro text-muted-foreground/75">{activity.app}</span> : null}</span>
        <Icon name="arrow-right-s" className="size-3.5 text-muted-foreground" />
      </button>;
    })}
    {pending.map(item => <div key={item.id} className="rounded-lg bg-muted/25 px-2 py-2 typography-meta">
      <span className="block text-[var(--status-warning)]">{t('computer.automation.request', { name: item.actor.label })}</span>
      <span className="block truncate typography-micro text-muted-foreground">{item.desktopLabel ?? item.desktopId} · {t(item.access === 'control' ? 'computer.automation.control' : 'computer.automation.observeOnly')}</span>
      <p className="mt-1 line-clamp-2 text-muted-foreground">{item.reason}</p>
    </div>)}
    {state?.active ? <Button size="sm" variant="outline" disabled={view.busy || status === 'cancelling'} className="w-full" onClick={() => void view.stop()}>
      <Icon name="stop" className="mr-1.5 size-3.5" />{t(status === 'cancelling' ? 'computer.automation.cancelling' : 'computer.automation.stop')}
    </Button> : null}
    {view.error ? <p role="alert" className="typography-micro text-destructive">{view.error}</p> : null}
  </div>;
}
