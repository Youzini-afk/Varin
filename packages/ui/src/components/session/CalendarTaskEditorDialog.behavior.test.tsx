import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduledTask, ScheduledTasksAPI, ThreadResolvedSource, ThreadSourceTargets } from '@varin/application-client';
import type { CalendarSource, SourceResourceOwner } from '@varin/protocol';
import { CalendarTaskEditorDialog } from './CalendarTaskEditorDialog';
import { I18nProvider, useI18nStore } from '@/lib/i18n';

const api = vi.hoisted(() => ({
  schedules: { listSources: vi.fn<ScheduledTasksAPI['listSources']>(), resolveSource: vi.fn<ScheduledTasksAPI['resolveSource']>() },
  threads: { listModels: vi.fn() },
  readSettings: vi.fn(),
  hostGeneration: 1,
}));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createScheduledTasksHttpAPI: () => api.schedules, createModelConnectionsHttpAPI: () => ({ readSettings: api.readSettings }), getRuntimeEndpointGeneration: () => api.hostGeneration }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: api.threads }) }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children, onOpenChange }: React.PropsWithChildren<{ open: boolean; onOpenChange(value: boolean): void }>) => open ? <div role="dialog">{children}<button onClick={() => onOpenChange(false)}>Close editor</button></div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));

const local: SourceResourceOwner = { kind: 'local' };
const remote: SourceResourceOwner = { kind: 'managed_host', connectionId: 'saved-remote', hostId: 'host-remote', endpointIdentity: 'endpoint-remote' };
const remoteKey = JSON.stringify([remote.connectionId, remote.endpointIdentity, remote.hostId]);
const targets: ThreadSourceTargets = { targets: [
  { resourceOwner: local, label: 'This Host', capabilities: [] },
  { resourceOwner: remote, label: 'Research Host', capabilities: ['sources'] },
], unavailable: [] };
const existing = (source: CalendarSource = { kind: 'project' }): ScheduledTask => ({
  id: 'calendar', name: 'Review results', runtime: 'agent', enabled: false, missedPolicy: 'skip',
  schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Inspect the latest results' }, state: { createdAt: 1, updatedAt: 1 },
  target: { kind: 'new_work', source, sourceMode: 'materialized', model: { providerId: 'provider', modelId: 'model' }, goal: null },
});
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let root: Root;
let container: HTMLDivElement;
let props: React.ComponentProps<typeof CalendarTaskEditorDialog>;
const save = vi.fn<React.ComponentProps<typeof CalendarTaskEditorDialog>['onSave']>();
const close = vi.fn();
const render = async (changes: Partial<typeof props> = {}) => {
  props = { ...props, ...changes };
  await act(async () => root.render(<I18nProvider><CalendarTaskEditorDialog {...props} /></I18nProvider>));
};
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const control = (label: string) => container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
const edit = async (label: string, value: string, event = 'change') => {
  const element = control(label);
  await act(async () => {
    Object.defineProperty(element, 'value', { configurable: true, writable: true, value });
    element.dispatchEvent(new window.Event(event, { bubbles: true }));
  });
};
const editField = async (label: string, value: string) => {
  const element = [...container.querySelectorAll('label')].find(field => field.firstChild?.textContent === label)!.querySelector('input,textarea')! as HTMLInputElement;
  await act(async () => { element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
const selectRemote = async () => {
  await edit('Calendar source', 'workspace');
  await edit('Calendar source Host', remoteKey);
  await edit('Calendar workspace folder', '/remote/repo', 'input');
};
beforeEach(async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await useI18nStore.getState().setLocale('en');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks(); api.hostGeneration = 1;
  api.schedules.listSources.mockReset().mockResolvedValue(targets);
  api.schedules.resolveSource.mockReset().mockResolvedValue({ resourceOwner: remote, workspaceId: 'documents-workspace', path: '/canonical/remote/repo' });
  api.threads.listModels.mockReset().mockResolvedValue([{ providerId: 'provider', modelId: 'model', thinkingLevels: ['off', 'high', 'xhigh'] }, { providerId: 'other', modelId: 'registered-other', thinkingLevels: ['off', 'high'] }]);
  api.readSettings.mockReset().mockResolvedValue({ global: { defaultProvider: 'provider', defaultModel: 'model', defaultThinkingLevel: 'high' }, project: {}, projectTrusted: false });
  save.mockReset().mockResolvedValue(undefined);
  props = { open: true, projectId: 'project', task: existing(), onSave: save, onOpenChange: close };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('uses Chinese labels without resetting the draft or translating saved schedule values', async () => {
  await render({ task: null, initialTarget: { runtime: 'agent', threadId: 'thread:bot:session', branchId: 'branch:bot:session' } });
  await editField('Name', '晚间简报');
  await editField('Instruction', '总结今天的进展');
  await act(async () => { await useI18nStore.getState().setLocale('zh-CN'); });
  expect(container.querySelector('h2')?.textContent).toBe('新建 Agent 日程');
  expect(container.textContent).toContain('继续已有任务');
  expect(container.textContent).not.toContain('Create Agent calendar');
  expect(control('日程执行目标').value).toBe('existing_work');
  await edit('日程执行频率', 'weekly');
  expect(control('日程执行频率').querySelector('option[value="weekly"]')?.textContent).toBe('每周');
  await click('保存日程');
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    name: '晚间简报', execution: { prompt: '总结今天的进展' },
    schedule: expect.objectContaining({ kind: 'weekly', weekdays: [1] }),
    target: { kind: 'existing_work', threadId: 'thread:bot:session', branchId: 'branch:bot:session' },
  }));
  expect(api.schedules.listSources).toHaveBeenCalledOnce();
});

it('defaults new work to the project source and can save when source discovery fails', async () => {
  api.schedules.listSources.mockRejectedValueOnce(new Error('Directory unavailable'));
  await render({ task: null });
  expect(control('Calendar source').value).toBe('project');
  expect(container.textContent).toContain('Directory unavailable');
  await editField('Name', 'Daily results'); await editField('Instruction', 'Review the results');
  await edit('Calendar model', JSON.stringify(['provider', 'model']));
  await click('Save definition');
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]![0].target).toMatchObject({ kind: 'new_work', source: { kind: 'project' }, sourceMode: 'materialized' });
  expect(api.schedules.resolveSource).not.toHaveBeenCalled();
  expect(api.schedules.listSources.mock.calls[0]![0]).toBe('project');
});

it('resolves an explicitly selected Host and saves only its real workspace identity with the chosen access mode', async () => {
  await render(); await selectRemote();
  expect(button('Save definition').disabled).toBe(true);
  await click('Resolve workspace');
  expect(api.schedules.resolveSource).toHaveBeenCalledExactlyOnceWith('project', { resourceOwner: remote, path: '/remote/repo' }, expect.any(AbortSignal));
  expect(control('Calendar workspace folder').value).toBe('/canonical/remote/repo');
  expect(container.querySelector('[aria-label="Calendar workspace identity"]')?.textContent).toContain('documents-workspace');
  await edit('Calendar source mode', 'fixed_branch'); await click('Save definition');
  expect(save.mock.calls[0]![0].target).toEqual({ kind: 'new_work', source: { kind: 'workspace', resourceOwner: remote, workspaceId: 'documents-workspace' },
    sourceMode: 'fixed_branch', model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'off' }, goal: null });
  expect(close).toHaveBeenCalledWith(false);
});

it('retains an unavailable saved owner exactly even when its connection now identifies another endpoint', async () => {
  const stored: CalendarSource = { kind: 'workspace', resourceOwner: remote, workspaceId: 'saved-workspace' };
  api.schedules.listSources.mockResolvedValueOnce({ targets: [{ ...targets.targets[1]!, resourceOwner: { ...remote, endpointIdentity: 'replacement-endpoint' } }],
    unavailable: [{ connectionId: remote.connectionId, label: 'Old Research Host', message: 'Host identity changed' }] });
  await render({ task: existing(stored) });
  expect(control('Calendar source Host').value).toBe(remoteKey);
  expect(container.textContent).toContain('The selected Host is unavailable');
  expect(container.textContent).toContain('saved-workspace');
  expect(container.textContent).toContain('endpoint-remote');
  await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ source: stored });
  expect(api.schedules.resolveSource).not.toHaveBeenCalled();
});

it('invalidates resolution on folder and Host changes and ignores superseded replies', async () => {
  const first = gate<ThreadResolvedSource>(), second = gate<ThreadResolvedSource>();
  api.schedules.resolveSource.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  await render(); await selectRemote(); await click('Resolve workspace');
  const firstSignal = api.schedules.resolveSource.mock.calls[0]![2]!;
  await edit('Calendar workspace folder', '/remote/new', 'input');
  expect(firstSignal.aborted).toBe(true);
  await click('Resolve workspace');
  await act(async () => first.resolve({ resourceOwner: remote, workspaceId: 'stale-workspace', path: '/stale' }));
  expect(button('Resolving workspace…').disabled).toBe(true);
  expect(container.textContent).not.toContain('stale-workspace');
  expect(control('Calendar workspace folder').value).toBe('/remote/new');
  await edit('Calendar source Host', 'local');
  expect(api.schedules.resolveSource.mock.calls[1]![2]!.aborted).toBe(true);
  await act(async () => second.resolve({ resourceOwner: remote, workspaceId: 'also-stale', path: '/also-stale' }));
  expect(control('Calendar workspace folder').value).toBe('');
  expect(button('Save definition').disabled).toBe(true);
  api.schedules.resolveSource.mockResolvedValueOnce({ resourceOwner: local, workspaceId: 'actual-local-workspace', path: '/local' });
  await edit('Calendar workspace folder', '/local', 'input'); await click('Resolve workspace'); await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ source: { kind: 'workspace', resourceOwner: local, workspaceId: 'actual-local-workspace' } });
});

it('discards a previously resolved identity when its folder changes, even if the text is changed back', async () => {
  await render(); await selectRemote(); await click('Resolve workspace');
  expect(button('Save definition').disabled).toBe(false);
  await edit('Calendar workspace folder', '/other', 'input');
  await edit('Calendar workspace folder', '/canonical/remote/repo', 'input');
  expect(button('Save definition').disabled).toBe(true);
  expect(container.querySelector('[aria-label="Calendar workspace identity"]')).toBeNull();
  api.schedules.resolveSource.mockResolvedValueOnce({ resourceOwner: remote, workspaceId: 'replacement-workspace', path: '/canonical/remote/repo' });
  await click('Resolve workspace'); await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ source: { workspaceId: 'replacement-workspace' } });
});

it('aborts close/reopen work and rejects old discovery and resolution after project changes', async () => {
  const resolution = gate<ThreadResolvedSource>();
  api.schedules.resolveSource.mockImplementationOnce(() => resolution.promise);
  await render(); await selectRemote(); await click('Resolve workspace'); await click('Close editor');
  expect(api.schedules.resolveSource.mock.calls[0]![2]!.aborted).toBe(true);
  await render({ open: false });
  const oldDirectory = gate<ThreadSourceTargets>();
  api.schedules.listSources.mockImplementationOnce(() => oldDirectory.promise);
  await render({ open: true });
  const oldSignal = api.schedules.listSources.mock.calls[1]![1]!;
  await render({ projectId: 'next-project', task: null });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    oldDirectory.resolve({ targets: [{ resourceOwner: local, label: 'Old project Host', capabilities: [] }], unavailable: [] });
    resolution.resolve({ resourceOwner: remote, workspaceId: 'closed-workspace', path: '/closed' });
  });
  expect(control('Calendar source').value).toBe('project');
  expect(container.textContent).not.toContain('closed-workspace');
  await edit('Calendar source', 'workspace');
  expect(container.textContent).not.toContain('Old project Host');
  expect(container.textContent).toContain('Research Host');
  expect(api.schedules.listSources.mock.calls.at(-1)![0]).toBe('next-project');
});

it('does not close a reopened editor when a previous save finishes', async () => {
  const pending = gate<void>(); save.mockImplementationOnce(() => pending.promise);
  await render(); await click('Save definition');
  await render({ open: false }); await render({ open: true, task: null });
  await act(async () => pending.resolve());
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Create Agent calendar');
  expect(control('Calendar source').value).toBe('project');
});

it('refuses to save an old local workspace after a Host switch without a props change', async () => {
  await render({ task: existing({ kind: 'workspace', resourceOwner: local, workspaceId: 'original-host-workspace' }) });
  api.hostGeneration += 1;
  await click('Save definition');
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Application Host changed');
  expect(container.querySelector('[aria-label="Calendar workspace identity"]')).toBeNull();
  await render({ open: false }); await render({ open: true, task: existing() });
  await click('Save definition');
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]![0].target).toMatchObject({ source: { kind: 'project' } });
});

it('refuses to resolve a previously selected Host after the Application Host changes', async () => {
  await render(); await selectRemote();
  api.hostGeneration += 1;
  await click('Resolve workspace');
  expect(api.schedules.resolveSource).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Application Host changed');
  expect(button('Save definition').disabled).toBe(true);
});

it('does not rebind an old editing session when RuntimeAPIs changes on another Host', async () => {
  await render({ task: existing({ kind: 'workspace', resourceOwner: local, workspaceId: 'original-host-workspace' }) });
  api.hostGeneration += 1;
  api.threads = { listModels: vi.fn(async () => [{ providerId: 'provider', modelId: 'model' }]) };
  await render();
  expect(api.schedules.listSources).toHaveBeenCalledOnce();
  expect(api.threads.listModels).not.toHaveBeenCalled();
  expect(button('Save definition').disabled).toBe(true);
  expect(container.textContent).toContain('Application Host changed');
  expect(save).not.toHaveBeenCalled();
});

it('inherits existing work without carrying a new source or waiting for its interrupted resolution', async () => {
  const pending = gate<ThreadResolvedSource>();
  api.schedules.resolveSource.mockImplementationOnce(() => pending.promise);
  await render(); await selectRemote(); await click('Resolve workspace');
  await edit('Calendar target', 'existing_work');
  expect(api.schedules.resolveSource.mock.calls[0]![2]!.aborted).toBe(true);
  await editField('Thread ID', 'original-thread'); await editField('Branch ID', 'original-branch');
  await click('Save definition');
  expect(save.mock.calls[0]![0].target).toEqual({ kind: 'existing_work', threadId: 'original-thread', branchId: 'original-branch' });
  expect(container.querySelector('[aria-label="Calendar source"]')).toBeNull();
  await act(async () => pending.resolve({ resourceOwner: remote, workspaceId: 'late-workspace', path: '/late' }));
  expect(save).toHaveBeenCalledOnce();
});

it('shows resolve failures without using the folder as an ID and allows an explicit return to project source', async () => {
  api.schedules.resolveSource.mockRejectedValueOnce(new Error('Remote folder does not exist'));
  await render(); await selectRemote(); await click('Resolve workspace');
  expect(container.textContent).toContain('Remote folder does not exist');
  expect(button('Save definition').disabled).toBe(true);
  expect(container.querySelector('[aria-label="Calendar workspace identity"]')).toBeNull();
  expect(control('Calendar workspace folder').value).toBe('/remote/repo');
  await edit('Calendar source', 'project'); await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ source: { kind: 'project' } });
});

it.each([
  { resourceOwner: remote, workspaceId: '', path: '/remote/repo' },
  { resourceOwner: { ...remote, endpointIdentity: 'unexpected-endpoint' }, workspaceId: 'wrong-host-workspace', path: '/remote/repo' },
])('does not accept an unresolved or replaced Host identity: %j', async result => {
  api.schedules.resolveSource.mockResolvedValueOnce(result);
  await render(); await selectRemote(); await click('Resolve workspace');
  expect(container.textContent).toContain('did not return the requested workspace identity');
  expect(button('Save definition').disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

const fillNewTask = async () => {
  await editField('Name', 'Daily results'); await editField('Instruction', 'Review the results');
};
const thinkingValue = () => [...container.querySelectorAll('label')].find(field => field.firstChild?.textContent === 'Thinking level')!.querySelector('input')!.value;

it('inherits the conversation registered model and xhigh effort without requiring a new model choice', async () => {
  await render({ task: null, conversation: { identity: { runtime: 'agent', threadId: 'source', branchId: 'branch-selected' }, model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' } } });
  expect(control('Calendar model').value).toBe(JSON.stringify(['provider', 'model']));
  expect(thinkingValue()).toBe('xhigh');
  await fillNewTask(); await click('Save definition');
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: expect.objectContaining({ kind: 'new_work', model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' } }) }));
  expect(api.readSettings).not.toHaveBeenCalled();
});

it('lets a new schedule override inherited model and effort without changing the conversation selection', async () => {
  const conversation = { model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' as const } };
  await render({ task: null, conversation }); await fillNewTask();
  await edit('Calendar model', JSON.stringify(['other', 'registered-other'])); await editField('Thinking level', 'high');
  await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ model: { providerId: 'other', modelId: 'registered-other', thinkingLevel: 'high' } });
  expect(conversation.model).toEqual({ providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' });
});

it('uses the opening conversation branch for existing work without requiring or saving a model', async () => {
  await render({ task: null, conversation: { identity: { runtime: 'agent', threadId: 'source', branchId: 'branch-selected' }, model: { providerId: 'removed', modelId: 'unavailable', thinkingLevel: 'xhigh' } } });
  await fillNewTask(); await edit('Calendar target', 'existing_work'); await click('Save definition');
  expect(control('Calendar model')).toBeNull();
  expect(save.mock.calls[0]![0].target).toEqual({ kind: 'existing_work', threadId: 'source', branchId: 'branch-selected' });
});

it('does not replace a saved model or effort with the current conversation selection', async () => {
  const task = existing();
  if (task.target?.kind === 'new_work') task.target.model = { providerId: 'other', modelId: 'registered-other', thinkingLevel: 'high', temperature: 0.25 };
  await render({ task, conversation: { model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' } } });
  expect(control('Calendar model').value).toBe(JSON.stringify(['other', 'registered-other']));
  expect(thinkingValue()).toBe('high'); await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ model: { providerId: 'other', modelId: 'registered-other', thinkingLevel: 'high', temperature: 0.25 } });
  expect(api.readSettings).not.toHaveBeenCalled();
});

it.each(['conversation', 'saved'] as const)('keeps an unavailable %s model visible and rejects save rather than silently falling back', async source => {
  const unavailable = { providerId: 'removed', modelId: 'registered-missing', thinkingLevel: 'xhigh' as const };
  const task = source === 'saved' ? existing() : null;
  if (task?.target?.kind === 'new_work') task.target.model = unavailable;
  await render({ task, conversation: { model: unavailable } }); await fillNewTask();
  expect(control('Calendar model').value).toBe(JSON.stringify(['removed', 'registered-missing']));
  expect(control('Calendar model').textContent).toContain('removed / registered-missing (unavailable)');
  await click('Save definition'); expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Select an available registered model');
  expect(api.readSettings).not.toHaveBeenCalled();
});

it('reuses trusted project conversation defaults when opened without a conversation', async () => {
  api.readSettings.mockResolvedValueOnce({ global: { defaultProvider: 'other', defaultModel: 'registered-other' }, projectTrusted: true,
    project: { defaultProvider: 'provider', defaultModel: 'model', defaultThinkingLevel: 'xhigh' } });
  await render({ task: null, project: { id: 'project', path: '/project' } }); await fillNewTask(); await click('Save definition');
  expect(api.readSettings).toHaveBeenCalledWith('/project', expect.any(AbortSignal), undefined);
  expect(save.mock.calls[0]![0].target).toMatchObject({ model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' } });
});

it('does not replace an explicit selection when delayed defaults arrive', async () => {
  const pending = gate<Awaited<ReturnType<typeof api.readSettings>>>(); api.readSettings.mockReturnValueOnce(pending.promise);
  await render({ task: null }); await fillNewTask();
  await edit('Calendar model', JSON.stringify(['other', 'registered-other'])); await editField('Thinking level', 'high');
  await act(async () => pending.resolve({ global: { defaultProvider: 'provider', defaultModel: 'model', defaultThinkingLevel: 'xhigh' }, projectTrusted: false }));
  await click('Save definition');
  expect(save.mock.calls[0]![0].target).toMatchObject({ model: { providerId: 'other', modelId: 'registered-other', thinkingLevel: 'high' } });
});

it('starts a fresh inherited selection after closing an unsaved editor', async () => {
  await render({ task: null, conversation: { model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'xhigh' } } });
  await edit('Calendar model', JSON.stringify(['other', 'registered-other']));
  await render({ open: false });
  await render({ open: true, conversation: { model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'high' } } });
  expect(control('Calendar model').value).toBe(JSON.stringify(['provider', 'model'])); expect(thinkingValue()).toBe('high');
});

it('reads a managed project default by registration ID without treating its remote path as a local directory', async () => {
  await render({ task: null, project: { id: 'project', path: '/remote/project', source: { resourceOwner: remote, workspaceId: 'remote-workspace' } } });
  expect(api.readSettings).toHaveBeenCalledWith(undefined, expect.any(AbortSignal), 'project');
  expect(control('Calendar model').value).toBe(JSON.stringify(['provider', 'model']));
});

it('does not use untrusted project defaults when no conversation selection is available', async () => {
  api.readSettings.mockResolvedValueOnce({ global: { defaultProvider: 'provider', defaultModel: 'model', defaultThinkingLevel: 'high' }, projectTrusted: false,
    project: { defaultProvider: 'other', defaultModel: 'registered-other', defaultThinkingLevel: 'xhigh' } });
  await render({ task: null });
  expect(control('Calendar model').value).toBe(JSON.stringify(['provider', 'model'])); expect(thinkingValue()).toBe('high');
});

it('preserves a manually entered effort while delayed defaults fill only the unselected model', async () => {
  const pending = gate<Awaited<ReturnType<typeof api.readSettings>>>(); api.readSettings.mockReturnValueOnce(pending.promise);
  await render({ task: null }); await editField('Thinking level', 'xhigh');
  await act(async () => pending.resolve({ global: { defaultProvider: 'provider', defaultModel: 'model', defaultThinkingLevel: 'high' }, projectTrusted: false }));
  expect(control('Calendar model').value).toBe(JSON.stringify(['provider', 'model'])); expect(thinkingValue()).toBe('xhigh');
});
