import { expect, it, vi } from 'vitest';
import { invokeDesktopHostCommand, type DesktopHostConnections } from './desktop-host-invoke.js';

it('passes SSH configuration and lifecycle to the existing connection owner', async () => {
  const owner = { connect: vi.fn(async () => {}), statusesWithDefaults: vi.fn(async () => ({ instance: { phase: 'connected' } })) } as unknown as DesktopHostConnections;
  expect(await invokeDesktopHostCommand(owner, { command: 'desktop_ssh_connect', args: { id: ' original-host ' } })).toBeNull();
  expect(owner.connect).toHaveBeenCalledWith('original-host');
  expect(await invokeDesktopHostCommand(owner, { command: 'desktop_ssh_status', args: {} })).toEqual({ instance: { phase: 'connected' } });
  expect(owner.statusesWithDefaults).toHaveBeenCalledWith(undefined);
});
it('never dispatches arbitrary owner method names or malformed arguments', async () => {
  const owner = { shutdownAll: vi.fn() } as unknown as DesktopHostConnections;
  await expect(invokeDesktopHostCommand(owner, { command: 'shutdownAll' })).rejects.toThrow('Unknown');
  await expect(invokeDesktopHostCommand(owner, { command: 'desktop_ssh_connect', args: [] })).rejects.toThrow('arguments');
});
