import { CalendarTaskStatus } from './CalendarTaskStatus';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { useUIStore } from '@/stores/useUIStore';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@varin/application-client';
import { createScheduledTasksHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ScheduledTask, type ScheduledTaskStatus, type ThreadIdentity } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { CalendarTaskEditorDialog } from './CalendarTaskEditorDialog';
const schedules = createScheduledTasksHttpAPI();
import { ScheduledTaskEditorDialog } from './ScheduledTaskEditorDialog';
import { ScheduledTaskLoopEditorDialog } from './ScheduledTaskLoopEditorDialog';
import { canonicalizeTimezone } from '@/lib/timezones';
import { FollowUpTasksPanel } from './FollowUpTasksPanel';
import { TaskListRow, TaskSearch } from './TaskListPrimitives';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  const valid = raw.filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

const formatSchedule = (task: ScheduledTask, t: ReturnType<typeof useI18n>['t']): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  const formatWeekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (task.schedule.kind === 'daily') {
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (task.schedule.kind === 'once') {
    const date = typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
      ? task.schedule.date
      : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
      ? task.schedule.time
      : '--:--';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (task.schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: task.schedule.cron || '',
      timezone: canonicalizeTimezone(task.schedule.timezone),
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron || '' });
};

const formatClockTime = (value: number | undefined, timeFormatPreference: TimeFormatPreference): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  return formatTimeForPreference(value, timeFormatPreference);
};

const formatRelativeTime = (value: number | undefined, t: ReturnType<typeof useI18n>['t']): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute') : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: m })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: m });
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
};

type StatusTone = 'success' | 'error' | 'warning' | 'muted';

const STATUS_META: Record<
  ScheduledTaskStatus,
  {
    tone: StatusTone;
    Icon: IconName;
    spin?: boolean;
  }
> = {
  success: { tone: 'success', Icon: 'checkbox-circle' },
  error: { tone: 'error', Icon: 'error-warning' },
  running: { tone: 'warning', Icon: 'loader-4', spin: true },
  idle: { tone: 'muted', Icon: 'pulse' },
};

const toneStyle = (tone: StatusTone): React.CSSProperties => {
  if (tone === 'muted') {
    return {};
  }
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-background)`,
    borderColor: `var(--status-${tone}-border)`,
  };
};

export function ScheduledTasksDialog() {
  const { t } = useI18n();
  const { threads } = useRuntimeAPIs();
  const [calendarEditorOpen, setCalendarEditorOpen] = React.useState(false);
  const [calendarEditorTask, setCalendarEditorTask] = React.useState<ScheduledTask | null>(null);
  const [calendarWork, setCalendarWork] = React.useState<ThreadIdentity | null>(null);
  const runKeys = React.useRef(new Map<string, string>());
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => { runKeys.current.clear(); setCalendarWork(null); setCalendarEditorOpen(false); }), []);
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { currentTheme } = useThemeSystem();

  const [selectedProjectID, setSelectedProjectID] = React.useState<string>('');
  const [view, setView] = React.useState<'scheduled' | 'followups'>('scheduled');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'enabled' | 'paused' | 'completed'>('all');
  const [createFollowUp, setCreateFollowUp] = React.useState(false);
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  // Start in loading state so the first frame after open shows the spinner,
  // not an empty/select-project flash before the fetch effect runs.
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const reloadGeneration = React.useRef(0);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorTask, setEditorTask] = React.useState<ScheduledTask | null>(null);
  const [loopEditorTask, setLoopEditorTask] = React.useState<ScheduledTask | null>(null);
  const [mutatingTaskID, setMutatingTaskID] = React.useState<string | null>(null);

  const selectedProject = React.useMemo(
    () => projects.find((project) => project.id === selectedProjectID) || null,
    [projects, selectedProjectID],
  );

  const renderProjectLabel = React.useCallback((project: ProjectEntry) => {
    const displayLabel = project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined);
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
    const fallbackIcon = projectIconName ? (
      <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
    ) : (
      <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"  style={iconColor ? { color: iconColor } : undefined}/>
    );

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {project.iconImage ? (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
            style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
          >
            <ProjectIconImage
              project={{ id: project.id, iconImage: project.iconImage ?? null }}
              options={{
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
              }}
              className="h-full w-full object-contain"
              fallback={fallbackIcon}
            />
          </span>
        ) : fallbackIcon}
        <span className="truncate">{displayLabel}</span>
      </span>
    );
  }, [homeDirectory, currentTheme.metadata.variant, currentTheme.colors.surface.foreground]);

  const reloadTasks = React.useCallback(async (projectID: string, options?: { silent?: boolean }) => {
    const generation = ++reloadGeneration.current;
    if (!projectID) {
      setTasks([]);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const nextTasks = await schedules.list(projectID);
      if (generation !== reloadGeneration.current) return;
      nextTasks.sort((a, b) => {
        if (a.enabled !== b.enabled) {
          return a.enabled ? -1 : 1;
        }
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) {
          return byName;
        }
        return (a.state?.nextRunAt || Number.MAX_SAFE_INTEGER) - (b.state?.nextRunAt || Number.MAX_SAFE_INTEGER);
      });
      setTasks(nextTasks);
      setLoadError(null);
    } catch (error) {
      if (generation !== reloadGeneration.current) return;
      setLoadError(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      if (!options?.silent) {
        setTasks([]);
      }
    } finally {
      if (generation === reloadGeneration.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [t]);

  React.useEffect(() => {
    if (!open || view !== 'scheduled') {
      return;
    }
    const preferredProjectID = activeProject?.id || projects[0]?.id || '';
    setSelectedProjectID(preferredProjectID);
    if (preferredProjectID) {
      void reloadTasks(preferredProjectID);
    } else {
      setTasks([]);
      setLoading(false);
      setLoadError(null);
    }
    return () => { reloadGeneration.current += 1; };
  }, [open, view, activeProject, projects, reloadTasks]);

  React.useEffect(() => {
    if (!open || view !== 'scheduled') {
      return;
    }
    let timeoutID: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type !== 'scheduled-task-ran' && event.type !== 'scheduled-task-changed' && event.type !== 'stream-ready') {
        return;
      }
      if (event.type === 'scheduled-task-ran' && event.projectId !== selectedProjectID) {
        return;
      }
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      timeoutID = setTimeout(() => {
        void reloadTasks(selectedProjectID, { silent: true });
      }, 400);
    });
    return () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      unsubscribe();
    };
  }, [open, view, selectedProjectID, reloadTasks]);

  const handleSaveTask = React.useCallback(async (taskDraft: Partial<ScheduledTask>) => {
    if (!selectedProjectID) {
      throw new Error(t('sessions.scheduledTasks.dialog.error.chooseProjectFirst'));
    }
    await schedules.upsert(selectedProjectID, taskDraft);
    await reloadTasks(selectedProjectID);
    toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
  }, [selectedProjectID, reloadTasks, t]);

  const handleToggleEnabled = React.useCallback(async (task: ScheduledTask, enabled: boolean) => {
    if (!selectedProjectID) {
      return;
    }
    setMutatingTaskID(task.id);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, enabled } : item)));
    try {
      if (task.loopFile) {
        if (!task.loopRevision) throw new Error('Loop revision is unavailable');
        await schedules.setLoopEnabled(selectedProjectID, task.id, enabled, task.loopRevision);
      } else {
        await schedules.upsert(selectedProjectID, { id: task.id, enabled });
      }
      await reloadTasks(selectedProjectID, { silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      await reloadTasks(selectedProjectID, { silent: true });
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks, t]);

  const handleDeleteTask = React.useCallback(async (task: ScheduledTask) => {
    if (!selectedProjectID) {
      return;
    }
    const confirmed = window.confirm(task.loopFile
      ? t('sessions.scheduledTasks.dialog.confirm.deleteLoopFile', { taskName: task.name })
      : t('sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: task.name }));
    if (!confirmed) {
      return;
    }

    setMutatingTaskID(task.id);
    try {
      if (task.loopFile) {
        if (!task.loopRevision) throw new Error('Loop revision is unavailable');
        await schedules.removeLoop(selectedProjectID, task.id, task.loopRevision);
      } else {
        await schedules.remove(selectedProjectID, task.id);
      }
      await reloadTasks(selectedProjectID, { silent: true });
      toast.success(t('sessions.scheduledTasks.dialog.toast.deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.deleteFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks, t]);

  const handleEditTask = React.useCallback((task: ScheduledTask) => {
    if (task.loopFile) {
      setLoopEditorTask(task);
      return;
    }
    if (task.runtime === 'agent') { setCalendarEditorTask(task); setCalendarEditorOpen(true); return; }
    setEditorTask(task);
    setEditorOpen(true);
  }, []);

  const handleRunNow = React.useCallback(async (task: ScheduledTask) => {
    if (!selectedProjectID) {
      return;
    }
    setMutatingTaskID(task.id);
    try {
      const identity = `${selectedProjectID}:${task.id}`;
      const key = runKeys.current.get(identity) ?? crypto.randomUUID(); runKeys.current.set(identity, key);
      const host = getRuntimeEndpointGeneration();
      const receipt = await schedules.run(selectedProjectID, task.id, key);
      if (host !== getRuntimeEndpointGeneration()) return;
      runKeys.current.delete(identity);
      const sessionId = receipt.runtime === 'pi' ? receipt.sessionId : undefined;
      if (receipt.runtime === 'agent') setCalendarWork({ runtime: 'agent', threadId: receipt.occurrence.thread_id, branchId: receipt.occurrence.branch_id });
      await reloadTasks(selectedProjectID, { silent: true });
      toast.success(t('sessions.scheduledTasks.dialog.toast.started'));
      if (sessionId) {
        const project = projects.find((entry) => entry.id === selectedProjectID);
        await openPiSessionFromNavigation({
          directory: project?.path,
          sessionId,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.runFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, projects, reloadTasks, t]);

  const projectSelector = (
    <div className="ml-auto min-w-0">
      <Select
        value={selectedProjectID || '__none'}
        onValueChange={(value) => {
          const nextProjectID = value === '__none' ? '' : value;
          setSelectedProjectID(nextProjectID);
          if (nextProjectID) {
            void reloadTasks(nextProjectID);
          } else {
            setTasks([]);
          }
        }}
      >
        <SelectTrigger className="h-8 w-auto max-w-48 border-0 bg-transparent shadow-none" aria-label={t('sessions.scheduledTasks.dialog.project.label')}>
          {selectedProject ? (
            <SelectValue>{renderProjectLabel(selectedProject)}</SelectValue>
          ) : (
            <SelectValue placeholder={t('sessions.scheduledTasks.dialog.project.placeholder')} />
          )}
        </SelectTrigger>
        <SelectContent>
          {projects.length === 0 ? <SelectItem value="__none">{t('sessions.scheduledTasks.dialog.project.empty')}</SelectItem> : null}
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {renderProjectLabel(project)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const openNewTaskEditor = () => {
    setView('scheduled');
    setEditorTask(null);
    setEditorOpen(true);
  };

  const completed = (task: ScheduledTask) => task.runtime === 'agent'
    ? task.schedule.kind === 'once' && Boolean(task.calendar && !task.calendar.definition.calculation_pending && task.calendar.definition.next_at_ms === null && task.calendar.occurrences.some(value => value.reason.kind === 'scheduled') && task.calendar.occurrences.every(value => ['completed', 'failed', 'cancelled'].includes(value.state)))
    : task.schedule.kind === 'once' && task.state.lastStatus === 'success' && !task.state.nextRunAt;
  const visibleTasks = tasks.filter((task) => {
    const state = completed(task) ? 'completed' : task.enabled ? 'enabled' : 'paused';
    return (filter === 'all' || filter === state)
      && (!query.trim() || `${task.name} ${task.execution.prompt} ${formatSchedule(task, t)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  });

  const tasksList = (
      <div className="min-h-[280px]">
      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-border p-3 typography-meta text-[var(--status-error)]"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void reloadTasks(selectedProjectID)}>{t('tasksHub.refresh')}</Button></div>
      ) : loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('sessions.scheduledTasks.dialog.loading')}
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="py-12 text-center typography-meta text-muted-foreground">
          {tasks.length > 0 ? t('tasksHub.noMatches') : selectedProjectID ? t('sessions.scheduledTasks.dialog.empty.noTasks') : t('sessions.scheduledTasks.dialog.empty.selectProject')}
        </div>
      ) : (
        <div className="space-y-1">
          {visibleTasks.map((task) => {
            const isBusy = mutatingTaskID === task.id;
            const status = (task.state?.lastStatus || 'idle') as ScheduledTaskStatus;
            const meta = STATUS_META[status];
            const statusLabel = status === 'success'
              ? t('sessions.scheduledTasks.dialog.status.success')
              : status === 'error'
                ? t('sessions.scheduledTasks.dialog.status.error')
                : status === 'running'
                  ? t('sessions.scheduledTasks.dialog.status.running')
                  : t('sessions.scheduledTasks.dialog.status.idle');
            const nextAt = task.state?.nextRunAt;
            const lastAt = task.state?.lastRunAt;

            return (
              <TaskListRow
                key={task.id}
                title={task.name}
                subtitle={formatSchedule(task, t)}
                muted={!task.enabled}
                icon={status === 'running' ? 'loader-4' : 'time'}
                status={t(completed(task) ? 'tasksHub.completed' : task.enabled ? 'tasksHub.enabled' : 'tasksHub.paused')}
              >
                <p className="whitespace-pre-wrap break-words text-foreground">{task.execution.prompt}</p>
                  {task.loopFile ? (
                    <div className="typography-micro truncate text-muted-foreground/70" title={task.loopFile}>
                      {task.loopScope === 'user'
                        ? t('sessions.scheduledTasks.dialog.loopFile.user')
                        : t('sessions.scheduledTasks.dialog.loopFile.project')}
                      {' · '}{task.loopFile}
                    </div>
                  ) : null}

                {task.runtime !== 'agent' && task.onceAcceptance && <p className="text-sm">Once slot already accepted by {task.onceAcceptance.owner}. Automatic execution will not be repeated. Receipt: {task.onceAcceptance.acceptanceId}</p>}
                {task.runtime === 'agent' ? <CalendarTaskStatus projectId={selectedProjectID} task={task} onChanged={() => reloadTasks(selectedProjectID, { silent: true })} onOpenWork={setCalendarWork} /> : <>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 typography-micro text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="timer" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.nextRun.label')}</span>
                    {nextAt ? (
                      <>
                        <span className="text-foreground">{formatRelativeTime(nextAt, t)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatClockTime(nextAt, timeFormatPreference)}</span>
                      </>
                    ) : (
                      <span>—</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="history" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.lastRun.label')}</span>
                    {status === 'running' ? (
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: 'var(--status-warning)' }}
                      >
                        <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
                        {t('sessions.scheduledTasks.dialog.lastRun.runningNow')}
                      </span>
                    ) : lastAt ? (
                      <>
                        {meta.tone !== 'muted' ? (
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: `var(--status-${meta.tone})` }}
                          >
                            <Icon name={meta.Icon} className="h-3.5 w-3.5" />
                            {statusLabel}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelativeTime(lastAt, t)}</span>
                      </>
                    ) : (
                      <span>{t('sessions.scheduledTasks.dialog.lastRun.never')}</span>
                    )}
                  </span>
                </div>

                {task.state?.lastError ? (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro"
                    style={toneStyle('error')}
                  >
                    <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{task.state.lastError}</span>
                  </div>
                ) : null}
                </>}
                {task.loopError ? (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro"
                    style={toneStyle('error')}
                  >
                    <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{task.loopError}</span>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <label
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-2 typography-micro font-medium',
                      task.enabled ? 'text-foreground' : 'text-muted-foreground',
                      isBusy && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Checkbox
                      checked={task.enabled}
                      onChange={(enabled) => void handleToggleEnabled(task, enabled)}
                      ariaLabel={task.enabled
                        ? t('sessions.scheduledTasks.dialog.taskToggle.pauseAria', { taskName: task.name })
                        : t('sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: task.name })}
                      disabled={isBusy}
                    />
                    {task.enabled ? t('sessions.scheduledTasks.dialog.taskToggle.enabled') : t('sessions.scheduledTasks.dialog.taskToggle.paused')}
                  </label>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRunNow(task)}
                      disabled={isBusy}
                    >
                      <Icon name="play" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.runNow')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEditTask(task)}
                      disabled={isBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.editAria', { taskName: task.name })}
                    >
                      <Icon name="edit-2" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.edit')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDeleteTask(task)}
                      disabled={isBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.deleteAria', { taskName: task.name })}
                    >
                      <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </TaskListRow>
            );
          })}
        </div>
      )}
      </div>
  );

  const sectionTabs = (
    <div className="flex items-center gap-1" role="group" aria-label={t('tasksHub.title')}>
      <Button size="sm" variant={view === 'scheduled' ? 'secondary' : 'ghost'} aria-pressed={view === 'scheduled'} onClick={() => setView('scheduled')}><Icon name="calendar-schedule" className="mr-1.5 size-4" />{t('tasksHub.scheduled')}</Button>
      <Button size="sm" variant={view === 'followups' ? 'secondary' : 'ghost'} aria-pressed={view === 'followups'} onClick={() => setView('followups')}><Icon name="timer" className="mr-1.5 size-4" />{t('tasksHub.followUps')}</Button>
    </div>
  );

  const createButton = <DropdownMenu>
    <DropdownMenuTrigger asChild><Button size="sm" className="shrink-0 gap-1 rounded-full px-3">{t('tasksHub.create')}<Icon name="arrow-down-s" className="size-3.5" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem disabled={projects.length === 0 || !threads} onSelect={() => { setCalendarEditorTask(null); setCalendarEditorOpen(true); }}>Agent calendar</DropdownMenuItem>
      <DropdownMenuItem disabled={projects.length === 0} onSelect={openNewTaskEditor}><Icon name="calendar-schedule" className="mr-2 size-4" />{t('tasksHub.scheduled')}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { setView('followups'); setCreateFollowUp(true); }}><Icon name="timer" className="mr-2 size-4" />{t('tasksHub.followUps')}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;

  const tasksContent = <div className="space-y-6">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-2"><h1 className="text-2xl font-semibold tracking-tight text-foreground">{t(view === 'scheduled' ? 'tasksHub.scheduled' : 'tasksHub.followUps')}</h1><p className="typography-meta text-muted-foreground">{t(view === 'scheduled' ? 'tasksHub.scheduledDescription' : 'tasksHub.followUpsDescription')}</p></div>
      {createButton}
    </div>
    {sectionTabs}
    {view === 'scheduled' ? <div className="space-y-5">
      <TaskSearch value={query} onChange={setQuery} label={t('tasksHub.search')} />
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('tasksHub.scheduled')}>
        {(['all', 'enabled', 'paused', 'completed'] as const).map((value) => <Button key={value} size="sm" variant={filter === value ? 'secondary' : 'ghost'} className="h-7 rounded-full px-2.5 typography-meta" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`tasksHub.${value}`)}</Button>)}
        {projectSelector}
      </div>
      {tasksList}
    </div> : open ? <FollowUpTasksPanel createOpen={createFollowUp} onCreateOpenChange={setCreateFollowUp} /> : null}
  </div>;

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('tasksHub.title')}
          onClose={() => setOpen(false)}
          contentMaxHeightClassName="max-h-[min(80vh,640px)]"
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('tasksHub.title')}</h2>
                {closeButton}
              </div>
            </div>
          )}
        >
          {tasksContent}
        </MobileOverlayPanel>
      ) : open ? (
        // The shared surface stays inside the existing chat-area page slot.
        <div className="absolute inset-0 z-10 overflow-y-auto bg-background">
          <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">{tasksContent}</div>
        </div>
      ) : null}

      <CalendarTaskEditorDialog open={calendarEditorOpen} task={calendarEditorTask} onOpenChange={setCalendarEditorOpen} onSave={handleSaveTask} />
      <Dialog open={calendarWork !== null} onOpenChange={value => { if (!value) setCalendarWork(null); }}><DialogContent className="h-[85vh] max-w-5xl overflow-hidden"><DialogTitle>Calendar work</DialogTitle>
        {calendarWork && threads && <ThreadConversation api={threads} identity={calendarWork} onBranchCreated={setCalendarWork} />}
      </DialogContent></Dialog>
      <ScheduledTaskEditorDialog
        open={editorOpen}
        projectDirectory={projects.find((project) => project.id === selectedProjectID)?.path ?? null}
        task={editorTask}
        onOpenChange={setEditorOpen}
        onSave={handleSaveTask}
      />
      <ScheduledTaskLoopEditorDialog
        open={Boolean(loopEditorTask)}
        projectID={selectedProjectID}
        task={loopEditorTask}
        onOpenChange={(next) => {
          if (!next) setLoopEditorTask(null);
        }}
        onSaved={() => reloadTasks(selectedProjectID, { silent: true })}
      />
    </>
  );
}
