import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@varin/application-client';
import { CalendarTaskStatus } from './CalendarTaskStatus';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
const api = vi.hoisted(() => ({ controlOccurrence: vi.fn(async () => ({})), retryCalculation: vi.fn(async () => ({})) }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createScheduledTasksHttpAPI: () => api }));
it('controls only live original occurrences and opens their actual Thread without inventing a Pi session', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await useI18nStore.getState().setLocale('en');
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const refresh = vi.fn(async () => {}), open = vi.fn();
  const task = { id: 'task', runtime: 'agent', calendar: { definition: { id: 'definition', synchronized: true, revision: 6, calculation_pending: false, next_at_ms: null, calculation_failure: 'calculation_unavailable' },
    occurrences: [{ id: 'pending', state: 'held', reason: { kind: 'manual', key: 'key' }, revision: 3, thread_id: 'thread', branch_id: 'branch', hold_reason: 'user_paused', failure_code: null },
      { id: 'ended', state: 'cancelled', reason: { kind: 'manual', key: 'old' }, revision: 9, thread_id: 'old-thread', branch_id: 'old-branch', hold_reason: null, failure_code: null }] } } as ScheduledTask;
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
  try {
    await act(async () => root.render(<I18nProvider><CalendarTaskStatus projectId="project" task={task} onChanged={refresh} onOpenWork={open} /></I18nProvider>));
    expect(container.textContent).toContain('Paused');
    expect([...container.querySelectorAll('button')].filter(value => value.textContent === 'Cancel occurrence')).toHaveLength(1);
    await act(async () => button('Cancel occurrence').click());
    expect(api.controlOccurrence).toHaveBeenCalledWith('project', 'task', 'pending', 3, 'cancel');
    await act(async () => button('Retry calculation').click());
    expect(api.retryCalculation).toHaveBeenCalledWith('project', 'task', 6);
    await act(async () => button('View work').click());
    expect(open).toHaveBeenCalledWith({ runtime: 'agent', threadId: 'thread', branchId: 'branch' });
    api.controlOccurrence.mockRejectedValueOnce(new Error('Revision changed'));
    await act(async () => button('Cancel occurrence').click());
    expect(container.querySelector('[role=alert]')?.textContent).toBe('Revision changed');
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});


it.each(['en', 'zh-CN'] as const)('explains the failed preparation stage in %s and retries only its original occurrence', async locale => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await useI18nStore.getState().setLocale(locale);
  vi.clearAllMocks();
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const refresh = vi.fn(async () => {});
  const failure = 'calendar_preparation:source_preparation:workspace_backend_unavailable';
  const task = { id: 'task', runtime: 'agent', calendar: { definition: { synchronized: true, calculation_pending: false, next_at_ms: null },
    occurrences: [{ id: 'original', state: 'held', reason: { kind: 'manual', key: 'key' }, revision: 7, thread_id: 'thread', branch_id: 'branch', hold_reason: 'preparation_failed', failure_code: failure },
      { id: 'finished', state: 'failed', reason: { kind: 'manual', key: 'old' }, revision: 4, thread_id: 'old-thread', branch_id: 'old-branch', hold_reason: null, failure_code: failure }] } } as ScheduledTask;
  try {
    await act(async () => root.render(<I18nProvider><CalendarTaskStatus projectId="project" task={task} onChanged={refresh} onOpenWork={() => {}} /></I18nProvider>));
    const status = container.querySelector('[role=status]')!;
    expect(status.textContent).toContain(locale === 'en' ? 'preparing the selected workspace' : '准备所选工作区');
    expect(status.textContent).toContain(locale === 'en' ? 'Restore that backend' : '恢复该后端');
    expect(status.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(status.querySelector('code')?.textContent).toBe(failure);
    expect(container.textContent).not.toContain('Held: preparation_failed');
    const retries = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === 'Retry preparation');
    expect(retries).toHaveLength(1);
    await act(async () => retries[0]!.click());
    expect(api.controlOccurrence).toHaveBeenCalledExactlyOnceWith('project', 'task', 'original', 7, 'retry');
    expect(refresh).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll('summary')].some(summary => summary.textContent === 'Finished occurrences')).toBe(true);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it('explains legacy records without guessing their cause and retains unknown technical codes', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await useI18nStore.getState().setLocale('en');
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const task = { id: 'task', runtime: 'agent', calendar: { definition: { synchronized: true, calculation_pending: false, next_at_ms: null },
    occurrences: ['calendar_preparation_unavailable', 'future_failure_code', 'calendar_preparation:admission:invalid-params', 'calendar_preparation:model:model-disabled'].map((failure_code, index) => ({ id: `occurrence-${index}`, state: 'held', reason: { kind: 'manual', key: `${index}` }, revision: 2, thread_id: 'thread', branch_id: 'branch', hold_reason: 'preparation_failed', failure_code })) } } as ScheduledTask;
  try {
    await act(async () => root.render(<I18nProvider><CalendarTaskStatus projectId="project" task={task} onChanged={async () => {}} onOpenWork={() => {}} /></I18nProvider>));
    expect(container.textContent).toContain('older failure record has no preparation details');
    expect(container.textContent).toContain('future_failure_code');
    expect(container.textContent).toContain('admitting the prepared work');
    expect(container.textContent).toContain('Admission of the prepared work could not be confirmed');
    expect(container.textContent).toContain('selected model or provider is disabled');
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
