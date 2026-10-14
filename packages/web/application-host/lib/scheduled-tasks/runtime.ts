import type { CalendarOwner } from './calendar-owner.js';
import { watch } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
import { discoverLoops, loopDirectoriesFor } from './loops.js';
import type { ScheduledTask, createProjectConfigRuntime } from '../projects/project-config.js';

interface ScheduledProject { id: string; path: string }
interface ScheduledTasksRuntimeDependencies {
  listProjects(): Promise<ScheduledProject[]>;
  logger?: Pick<Console, 'warn'>;
  projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime>;
}

/** GUI and Markdown asset discovery. CalendarOwner is the sole execution owner. */
export const createScheduledTasksRuntime = ({ projectConfigRuntime, listProjects, logger = console }: ScheduledTasksRuntimeDependencies) => {
  let owner: CalendarOwner | undefined;
  let started = false;
  const projectSyncs = new Map<string, Promise<ScheduledTask[]>>();
  const projectPathByID = new Map<string, string>();
  const calendarOwner = (): CalendarOwner => {
    if (!owner) throw new Error('Calendar owner is unavailable');
    return owner;
  };
  const synchronizeProject = async (projectID: string): Promise<ScheduledTask[]> => {
    // A failed or partial read cannot publish an empty scan or use a stale project path.
    const projects = await listProjects();
    const project = projects.find(value => value.id === projectID);
    if (!project?.path) throw new Error('Calendar project is unavailable');
    projectPathByID.set(projectID, project.path);
    const tasks = await projectConfigRuntime.reconcileLoopTasks(projectID, await discoverLoops(project.path, { logger }));
    const projected = await calendarOwner().sync(projectID, tasks);
    const activeTasks = projected.filter(task => !task.loopShadowed);
    await refreshLoopWatchers();
    return activeTasks;
  };

  const syncProject = (projectID: string): Promise<ScheduledTask[]> => {
    const previous = projectSyncs.get(projectID) ?? Promise.resolve([]);
    const work = previous.catch(() => []).then(() => synchronizeProject(projectID));
    projectSyncs.set(projectID, work);
    void work.finally(() => { if (projectSyncs.get(projectID) === work) projectSyncs.delete(projectID); }).catch(() => undefined);
    return work;
  };

  const syncAllProjects = async (): Promise<void> => {
    const projects = await listProjects();
    const activeProjectIDs = new Set<string>();
    projectPathByID.clear();
    for (const project of projects) {
      if (!project?.id || !project?.path) {
        continue;
      }
      activeProjectIDs.add(project.id);
      projectPathByID.set(project.id, project.path);
    }

    const errors: unknown[] = [];
    try { await calendarOwner().removeMissingProjects(activeProjectIDs); } catch (error) { errors.push(error); }
    for (const projectID of activeProjectIDs) {
      try { await syncProject(projectID); } catch (error) { errors.push(error); }
    }
    await refreshLoopWatchers();
    if (errors.length) throw new AggregateError(errors, 'Some calendar project assets require attention');
  };

  // Markdown loop files are an authority surface: edits must reach the
  // scheduler without someone opening the task list. Watch each discovered
  // loops directory (project ancestors + user scope) and resync debounced.
  const loopWatchers = new Map<string, ReturnType<typeof watch>>();
  let loopResyncTimer: ReturnType<typeof setTimeout> | undefined;

  const onLoopDirectoryEvent = (): void => {
    if (!started) return;
    if (loopResyncTimer) clearTimeout(loopResyncTimer);
    loopResyncTimer = setTimeout(() => {
      loopResyncTimer = undefined;
      void syncAllProjects().catch((error) => {
        logger.warn?.('[ScheduledTasks] Markdown loop resync failed:', error);
      });
    }, 250);
  };

  const refreshLoopWatchers = async (): Promise<void> => {
    if (!started) return;
    const wanted = new Set<string>();
    for (const projectPath of projectPathByID.values()) {
      for (const entry of await loopDirectoriesFor(projectPath)) {
        wanted.add(entry.directory);
        // Watching the .agents parent also catches the loops directory being
        // created for the first time. Watching its parent catches the first
        // creation of .agents itself; both missing directories cannot otherwise
        // produce an fs.watch event.
        const agentsDirectory = pathDirname(entry.directory);
        wanted.add(agentsDirectory);
        wanted.add(pathDirname(agentsDirectory));
      }
    }
    for (const [directory, watcher] of loopWatchers) {
      if (!wanted.has(directory)) {
        watcher.close();
        loopWatchers.delete(directory);
      }
    }
    for (const directory of wanted) {
      if (loopWatchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, onLoopDirectoryEvent);
        watcher.on('error', () => {
          watcher.close();
          loopWatchers.delete(directory);
        });
        loopWatchers.set(directory, watcher);
      } catch {
        // Directory does not exist yet; a later sync retries.
      }
    }
  };

  const start = async (): Promise<void> => {
    if (started) return;
    const current = calendarOwner();
    started = true;
    try { await current.start(syncAllProjects); }
    catch (error) { stop(); throw error; }
  };

  const stop = (): void => {
    started = false;
    owner?.stop();
    for (const watcher of loopWatchers.values()) watcher.close();
    loopWatchers.clear();
    if (loopResyncTimer) clearTimeout(loopResyncTimer);
    loopResyncTimer = undefined;
  };

  const status = async (projectID?: string) => {
    const current = await calendarOwner().status(projectID);
    return {
      hasEnabledScheduledTasks: current.enabled > 0,
      hasRunningScheduledTasks: current.running > 0,
      enabledScheduledTasksCount: current.enabled,
      runningScheduledTasksCount: current.running,
    };
  };

  return {
    start, stop, syncAllProjects, syncProject, calendarOwner,
    setCalendarOwner(next: CalendarOwner) {
      if (owner) throw new Error('Calendar owner already installed');
      owner = next;
    },
    getStatus: () => status(),
    getProjectStatus: (projectID: string) => status(projectID),
  };
};
