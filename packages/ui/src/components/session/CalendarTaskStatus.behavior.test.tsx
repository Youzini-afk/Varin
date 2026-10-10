import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@varin/application-client';
import { CalendarTaskStatus } from './CalendarTaskStatus';
const api = vi.hoisted(() => ({ controlOccurrence: vi.fn(async () => ({})), retryCalculation: vi.fn(async () => ({})) }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createScheduledTasksHttpAPI: () => api }));
it('controls only live original occurrences and opens their actual Thread without inventing a Pi session', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const refresh = vi.fn(async () => {}), open = vi.fn();
  const task = { id: 'task', runtime: 'agent', calendar: { definition: { id: 'definition', synchronized: true, revision: 6, calculation_pending: false, next_at_ms: null, calculation_failure: 'calculation_unavailable' },
    occurrences: [{ id: 'pending', state: 'held', reason: { kind: 'manual', key: 'key' }, revision: 3, thread_id: 'thread', branch_id: 'branch', hold_reason: 'user_paused', failure_code: null },
      { id: 'ended', state: 'cancelled', reason: { kind: 'manual', key: 'old' }, revision: 9, thread_id: 'old-thread', branch_id: 'old-branch', hold_reason: null, failure_code: null }] } } as ScheduledTask;
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
  try {
    await act(async () => root.render(<CalendarTaskStatus projectId="project" task={task} onChanged={refresh} onOpenWork={open} />));
    expect(container.textContent).toContain('user_paused');
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
