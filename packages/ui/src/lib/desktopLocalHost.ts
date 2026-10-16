import type { DesktopLocalHostMode, DesktopLocalHostModeInput } from '@varin/application-client';
import { invokeDesktop, hasDesktopInvoke } from './desktop';

// These commands always address the native client, even when its selected Agent is remote.
export async function getDesktopLocalHostMode(): Promise<DesktopLocalHostMode> {
  const result = await invokeDesktop('desktop_get_local_host_mode');
  if (!result) throw new Error('Local Host startup controls require the trusted desktop UI');
  return result;
}
export async function setDesktopLocalHostMode(input: DesktopLocalHostModeInput): Promise<DesktopLocalHostMode> {
  const result = await invokeDesktop('desktop_set_local_host_mode', input);
  if (!result) throw new Error('Local Host startup controls require the trusted desktop UI');
  return result;
}
export async function restartDesktopWithoutUpdate(): Promise<void> {
  if (!hasDesktopInvoke()) throw new Error('Desktop restart requires the trusted desktop UI');
  await invokeDesktop('desktop_restart_without_update');
}
