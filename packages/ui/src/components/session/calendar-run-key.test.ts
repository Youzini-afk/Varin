import { expect, it, vi } from 'vitest';
import { retainCalendarRunKey } from './calendar-run-key';

it('freezes the admission generation only when creating a new manual request', () => {
  const keys = new Map<string, string>();
  const allocate = vi.fn(() => 'new-id');
  expect(retainCalendarRunKey(keys, 'task', 'generation:', allocate)).toBe('generation:new-id');
  expect(retainCalendarRunKey(keys, 'task', 'refreshed:', allocate)).toBe('generation:new-id');
  expect(allocate).toHaveBeenCalledTimes(1);
  // Only a settled request or an explicit user decision discards the retained key.
  keys.delete('task');
  expect(retainCalendarRunKey(keys, 'task', 'refreshed:', allocate)).toBe('refreshed:new-id');
});
it('never adds a migration prefix to an uncertain pre-upgrade request', () => {
  const keys = new Map([['task', 'original-key']]);
  const allocate = vi.fn(() => 'should-not-allocate');
  expect(retainCalendarRunKey(keys, 'task', 'upgraded:', allocate)).toBe('original-key');
  expect(allocate).not.toHaveBeenCalled();
});
