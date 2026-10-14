import { computerExecutionKey, sameComputerExecution, sameComputerWork } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { useComputerAutomation } from '@/stores/useComputerAutomation';

export function ComputerAutomationSection({ view, directory }: { view: ReturnType<typeof useComputerAutomation>; directory: string }) {
  const { t } = useI18n();
  const openTab = useUIStore(state => state.openContextPanelTab);
  const state = view.state;
  const desktops = new Set([
    ...state?.leases.map(lease => lease.desktopId) ?? [],
    ...view.activities.map(entry => entry.desktopId),
    ...state?.cleanups.flatMap(item => item.desktopId ? [item.desktopId] : []) ?? [],
  ]);
  const status = state?.status ?? 'enabled';
  const execution = state?.currentExecution;
  return <div className="space-y-3">
    {status !== 'enabled' ? <p role="status" className="typography-meta text-muted-foreground">{t(`computer.automation.${status}`)}</p> : null}
    {status === 'cancel-unconfirmed' || state?.cleanups.some(item => item.status === 'cancel-unconfirmed') ? <p className="typography-micro text-muted-foreground">{t('computer.automation.error.releaseUnconfirmed')}</p> : null}
    {[...desktops].map(desktopId => {
      const leases = state?.leases.filter(lease => lease.desktopId === desktopId) ?? [];
      const controller = leases.find(lease => lease.access === 'control');
      const activity = view.activities.find(entry => entry.desktopId === desktopId)?.activity;
      const desktopLabel = leases.find(lease => lease.desktopLabel)?.desktopLabel ?? desktopId;
      const operator = controller && state && sameComputerWork(controller.actor.execution.work, state.rootWork) ? t('computer.automation.main') : controller?.actor.label;
      const controllerExecution = controller?.actor.execution;
      const stopController = controllerExecution && state
        && (sameComputerWork(state.work, state.rootWork) || sameComputerWork(controllerExecution.work, state.work))
        && (!execution || !sameComputerExecution(controllerExecution, execution))
        && !state?.cleanups.some(cleanup => sameComputerExecution(cleanup.execution, controllerExecution) && (!cleanup.desktopId || cleanup.desktopId === desktopId));
      return <div key={desktopId}><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-interactive-hover"
        onClick={() => openTab(directory, { mode: 'computer', targetPath: desktopId, dedupeKey: `desktop:${desktopId}`, label: desktopLabel })}>
        <Icon name={activity?.status === 'running' ? 'loader-4' : 'computer'} className={`size-4 shrink-0 text-muted-foreground ${activity?.status === 'running' ? 'animate-spin' : ''}`} />
        <span className="min-w-0 flex-1"><span className="block truncate typography-meta">{desktopLabel}</span>
          <span className="block truncate typography-micro text-muted-foreground">{controller?.suspended ? t('settings.computers.view.control.you') : operator ?? t('computer.automation.observeOnly')}{activity?.status === 'running' ? ` · ${t(`computer.operation.${activity.operation}`)}` : ''}</span>
          {activity ? <span className="block truncate typography-micro text-muted-foreground/75">{activity.app}</span> : null}</span>
        <Icon name="arrow-right-s" className="size-3.5 text-muted-foreground" />
      </button>
        {stopController ? <Button size="sm" variant="outline" disabled={view.busy} className="mt-1"
          onClick={() => void view.stop(controllerExecution, desktopId)}>{t('computer.automation.stop')}</Button> : null}
      </div>;
    })}
    {state?.requests.map(item => <div key={item.id} className="rounded-lg bg-muted/25 px-2 py-2 typography-meta">
      <span className="block text-[var(--status-warning)]">{t('computer.automation.request', { name: item.actor.label })}</span>
      <span className="block truncate typography-micro text-muted-foreground">{item.desktopLabel ?? item.desktopId} · {t(item.access === 'control' ? 'computer.automation.control' : 'computer.automation.observeOnly')}</span>
      <p role="status" className="typography-micro text-muted-foreground">{t(`computer.automation.requestStatus.${item.status}`)}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{item.reason}</p>
      {item.detail ? <p className="mt-1 whitespace-pre-wrap break-words typography-micro text-muted-foreground">{item.detail}</p> : null}
      {view.decisionRequestId === item.id ? <p role="status" className="typography-micro text-muted-foreground">{t('computer.automation.deciding')}</p> : null}
      {item.status === 'indeterminate' || item.status === 'unavailable' ? <div className="mt-1">
        <p className="typography-micro text-muted-foreground">{t(`computer.automation.requestHelp.${item.status}`)}</p>
        <Button size="sm" variant="ghost" disabled={view.busy} onClick={() => void view.refresh()}>{t('settings.harness.retry')}</Button>
      </div> : null}
      {item.status === 'pending' && view.canDecideRequests ? <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={view.busy || Boolean(view.decisionRequestId)} onClick={() => void view.decide(item, 'grant')}>{t('computer.automation.grant')}</Button>
        <Button size="sm" variant="ghost" disabled={view.busy || Boolean(view.decisionRequestId)} onClick={() => void view.decide(item, 'deny')}>{t('computer.automation.deny')}</Button>
      </div> : null}
    </div>)}
    {state?.cleanups.map(cleanup => <div key={JSON.stringify([computerExecutionKey(cleanup.execution), cleanup.desktopId])} className="rounded-lg bg-muted/25 px-2 py-2 typography-meta">
      <p role="status">{t(`computer.automation.${cleanup.status}`)}</p>
      <p className="break-all typography-micro text-muted-foreground">{t('computer.automation.agentWork', { threadId: cleanup.execution.work.threadId, branchId: cleanup.execution.work.branchId })}</p>
      <p className="break-all typography-micro text-muted-foreground">{t('computer.automation.execution', { runId: cleanup.execution.runId })}{cleanup.desktopId ? ` · ${cleanup.desktopId}` : ''}</p>
      <Button size="sm" variant="outline" disabled={view.busy || cleanup.status === 'cancelling'} className="mt-2"
        onClick={() => void view.stop(cleanup.execution, cleanup.desktopId)}>{t('computer.automation.stop')}</Button>
    </div>)}
    {state?.active && execution ? <Button size="sm" variant="outline" disabled={view.busy || status === 'cancelling'} className="w-full" onClick={() => void view.stop(execution)}>
      <Icon name="stop" className="mr-1.5 size-3.5" />{t(status === 'cancelling' ? 'computer.automation.cancelling' : 'computer.automation.stop')}
    </Button> : null}
    {view.error ? <div><p role="alert" className="typography-micro text-destructive">{view.error}</p><Button size="sm" variant="ghost" onClick={() => void view.refresh()}>{t('settings.harness.retry')}</Button></div> : null}
  </div>;
}
