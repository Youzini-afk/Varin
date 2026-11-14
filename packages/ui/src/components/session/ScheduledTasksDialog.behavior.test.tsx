import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScheduleRequestError, type ScheduledTask } from '@varin/application-client';
import { ScheduledTasksDialog } from './ScheduledTasksDialog';

const state = vi.hoisted(() => {
  const project = { id: 'project', path: '/project', label: 'Project' };
  return { projects: [project], project, uiOpen: true, generation: 1, conversation: undefined as React.ComponentProps<typeof import('./CalendarTaskEditorDialog').CalendarTaskEditorDialog>['conversation'], editor: vi.fn(), list: vi.fn(), run: vi.fn(), setOpen: vi.fn(), t: (key: string) => key,
    selectProject: null as null | ((id: string) => void), endpointChanged: null as null | (() => void), events: null as null | ((event: { type: string }) => void), toast: { error: vi.fn(), success: vi.fn() } };
});
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  createScheduledTasksHttpAPI: () => ({ list: state.list, run: state.run }), getRuntimeKey: () => "runtime", getRuntimeEndpointGeneration: () => state.generation,
  subscribeRuntimeEndpointWillChange: (callback: () => void) => { state.endpointChanged = callback; return () => {}; } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign((selector: (v: unknown) => unknown) => selector({ isScheduledTasksDialogOpen: state.uiOpen, scheduledTasksConversation: state.conversation, setScheduledTasksDialogOpen: state.setOpen, isMobile: false }), { setState: () => { state.conversation = undefined; } }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (selector: (v: unknown) => unknown) => selector({ projects: state.projects, getActiveProject: () => state.project }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (selector: (v: unknown) => unknown) => selector({ homeDirectory: '/home' }) }));
vi.mock('@/lib/bots', () => ({ listBots: async () => [], useBotNavigation: (selector: (v: unknown) => unknown) => selector({ botId: null }) }));
vi.mock('@/lib/workbench/profile-context', () => ({ useWorkbenchProfileId: () => 'workspace' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (callback: typeof state.events) => { state.events = callback; return () => {}; } }));
vi.mock('@/lib/projectMeta', () => ({ PROJECT_COLOR_MAP: {}, PROJECT_ICON_MAP: {}, ProjectIconImage: () => null }));
vi.mock('@/lib/utils', () => ({ cn: (...v: unknown[]) => v.filter(x => typeof x === 'string').join(' '), formatDirectoryName: (v: string) => v }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { foreground: '#fff' } } } }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: {} }) }));
vi.mock('@/components/ui', () => ({ toast: state.toast }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _v, size: _s, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...p} /> }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2> }));
vi.mock('@/components/ui/select', () => { const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>; return { Select: ({ onValueChange, children }: React.PropsWithChildren<{ onValueChange: (id: string) => void }>) => { state.selectProject = onValueChange; return <div>{children}</div>; }, SelectContent: Part, SelectItem: Part, SelectTrigger: Part, SelectValue: Part }; });
vi.mock('@/components/ui/dropdown-menu', () => { const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>; return { DropdownMenu: Part, DropdownMenuContent: Part, DropdownMenuItem: ({ onSelect, children, disabled }: React.PropsWithChildren<{ onSelect(): void; disabled?: boolean }>) => <button disabled={disabled} onClick={onSelect}>{children}</button>, DropdownMenuTrigger: Part }; });
vi.mock('./TaskListPrimitives', () => ({ TaskListRow: ({ children }: React.PropsWithChildren) => <div>{children}</div>, TaskSearch: () => null }));
vi.mock('./CalendarTaskStatus', () => ({ CalendarTaskStatus: () => null }));
vi.mock('./CalendarTaskEditorDialog', () => ({ CalendarTaskEditorDialog: (props: React.ComponentProps<typeof import('./CalendarTaskEditorDialog').CalendarTaskEditorDialog>) => { state.editor(props); return null; } }));
vi.mock('./ScheduledTaskLoopEditorDialog', () => ({ ScheduledTaskLoopEditorDialog: () => null }));
vi.mock('./FollowUpTasksPanel', () => ({ FollowUpTasksPanel: () => null }));
vi.mock('@/components/thread/ThreadConversation', () => ({ ThreadConversation: () => null }));
vi.mock('./scheduleFormat', () => ({ formatSchedule: () => 'Daily' }));
let root: Root, container: HTMLDivElement;
let task: ScheduledTask;
const click = async (key: string) => { await act(async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === key);
  expect(button, key).toBeDefined(); expect(button!.disabled).toBe(false); button!.click();
}); };
const runNow = 'sessions.scheduledTasks.dialog.actions.runNow';
const keep = 'sessions.scheduledTasks.dialog.runReplacement.cancel';
const confirm = 'sessions.scheduledTasks.dialog.runReplacement.confirm';
beforeEach(() => {
  vi.clearAllMocks(); state.generation = 1; state.uiOpen = true; state.conversation = undefined; state.projects = [state.project];
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  task = { id: 'task', name: 'Task', runtime: 'agent', enabled: true, target: { kind: 'existing_work', threadId: 'thread', branchId: 'main' }, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Work' },
    state: { createdAt: 1, updatedAt: 1 }, calendar: { definition: {
      id: 'definition', project_id: 'project', task_id: 'task', asset_revision: 'asset', asset_kind: 'gui', revision: 1, generation: 1,
      manual_key_prefix: 'before:', name: 'Task', enabled: true, deleted: false, timezone: 'UTC',
      rule: { kind: 'daily', times: ['09:00'] }, missed_policy: 'skip', target: { kind: 'existing_work', threadId: 'thread', branchId: 'main' },
      synchronized: true, once_acceptance: null, activation_hold: null, next_at_ms: null, calculation_pending: false, calculation_failure: null,
    }, occurrences: [] } };
  state.list.mockImplementation(async () => [structuredClone(task)]);
  state.run.mockRejectedValue(new ScheduleRequestError(409, 'Earlier result unavailable', 'identity-unavailable'));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('provides a desktop close action without navigating or starting work', async () => {
  await act(async () => root.render(<ScheduledTasksDialog />));
  const close = container.querySelector<HTMLButtonElement>('[aria-label="dialog.common.actions.close"]');
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(state.setOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(state.run).not.toHaveBeenCalled();
});
it('keeps the rejected key through refresh/cancel and replaces it only after explicit confirmation using the latest definition', async () => {
  await act(async () => root.render(<ScheduledTasksDialog />));
  await click(runNow);
  const original = state.run.mock.calls[0]![2] as string;
  expect(original.startsWith('before:')).toBe(true);
  expect(container.textContent).toContain('sessions.scheduledTasks.dialog.runReplacement.warning');
  await click(keep);
  task.calendar!.definition.manual_key_prefix = 'after:';
  await act(async () => { state.events!({ type: 'stream-ready' }); await new Promise(resolve => setTimeout(resolve, 450)); });
  await click(runNow);
  expect(state.run.mock.calls[1]![2]).toBe(original);
  await click(keep);
  await click(runNow);
  expect(state.run.mock.calls[2]![2]).toBe(original);
  state.run.mockResolvedValueOnce({ occurrence: { thread_id: 'new', branch_id: 'main' } });
  await click(confirm);
  const replacement = state.run.mock.calls[3]![2] as string;
  expect(replacement).not.toBe(original); expect(replacement.startsWith('after:')).toBe(true);
  expect(state.run).toHaveBeenCalledTimes(4);
});
it('cancel during replacement refresh leaves the original uncertain key untouched', async () => {
  await act(async () => root.render(<ScheduledTasksDialog />)); await click(runNow);
  const original = state.run.mock.calls[0]![2];
  let release!: (tasks: ScheduledTask[]) => void;
  state.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await click(confirm); await click(keep);
  await act(async () => release([task]));
  expect(state.run).toHaveBeenCalledTimes(1);
  await click(runNow); expect(state.run.mock.calls[1]![2]).toBe(original);
});

it('closing the task view during replacement refresh dismisses confirmation without forgetting the original key', async () => {
  await act(async () => root.render(<ScheduledTasksDialog />)); await click(runNow);
  const original = state.run.mock.calls[0]![2];
  let release!: (tasks: ScheduledTask[]) => void;
  state.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await click(confirm);
  state.uiOpen = false;
  await act(async () => root.render(<ScheduledTasksDialog />));
  await act(async () => release([task]));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(state.run).toHaveBeenCalledTimes(1);
  state.uiOpen = true;
  await act(async () => root.render(<ScheduledTasksDialog />));
  await click(runNow); expect(state.run.mock.calls[1]![2]).toBe(original);
});

it('reconnecting the same runtime dismisses confirmation but never changes an uncertain request key', async () => {
  await act(async () => root.render(<ScheduledTasksDialog />)); await click(runNow);
  const original = state.run.mock.calls[0]![2];
  task.calendar!.definition.manual_key_prefix = 'after:';
  await act(async () => {
    state.endpointChanged!(); state.generation += 1;
    state.events!({ type: 'stream-ready' });
    await new Promise(resolve => setTimeout(resolve, 450));
  });
  expect(container.textContent).not.toContain('sessions.scheduledTasks.dialog.runReplacement.warning');
  await click(runNow); expect(state.run.mock.calls[1]![2]).toBe(original);
});

it('switching project while the replacement definition is loading cannot run the old task', async () => {
  state.projects = [state.project, { id: 'second', path: '/second', label: 'Second' }];
  await act(async () => root.render(<ScheduledTasksDialog />)); await click(runNow);
  const original = state.run.mock.calls[0]![2];
  let release!: (tasks: ScheduledTask[]) => void;
  state.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await click(confirm);
  await act(async () => state.selectProject!('second'));
  await act(async () => release([task]));
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain('sessions.scheduledTasks.dialog.runReplacement.warning');
  await act(async () => state.selectProject!('project'));
  await click(runNow); expect(state.run.mock.calls[1]![2]).toBe(original);
});

it('passes the opening conversation model and branch into a new calendar editor', async () => {
  state.conversation = { identity: { runtime: 'agent', threadId: 'conversation', branchId: 'selected-branch' }, model: { providerId: 'channel', modelId: 'registered-model', thinkingLevel: 'xhigh' } };
  await act(async () => root.render(<ScheduledTasksDialog />));
  await click('tasksHub.scheduled');
  expect(state.editor.mock.lastCall?.[0]).toMatchObject({ open: true, task: null, conversation: state.conversation, project: state.project });
});

it('discards the opening conversation when the Application Host changes', async () => {
  state.conversation = { model: { providerId: 'original-host-channel', modelId: 'model', thinkingLevel: 'xhigh' } };
  await act(async () => root.render(<ScheduledTasksDialog />)); await click('tasksHub.scheduled');
  await act(async () => { state.endpointChanged!(); state.generation += 1; });
  await click('tasksHub.scheduled');
  expect(state.editor.mock.lastCall?.[0]).toMatchObject({ open: true, conversation: undefined });
});
