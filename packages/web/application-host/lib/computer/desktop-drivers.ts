import type { ComputerDesktop } from '@varin/protocol';
import { createDriverSession, type ComputerDriverSession, type DriverSpawnSpec } from './driver-host.js';

/** Input and live capture have separate native processes. Long input cannot
 * block the viewer, and capturing never replaces the Agent's element indices. */
export function createDesktopDriverPool(options: {
  resolve(desktopId: string): Promise<{ desktop: ComputerDesktop; spec: DriverSpawnSpec }>;
  createDriver?: (spec: DriverSpawnSpec) => ComputerDriverSession;
  onInputReset(desktopId: string): void;
}) {
  const inputs = new Map<string, ComputerDriverSession>();
  const captures = new Map<string, ComputerDriverSession>();
  const loading = new Map<string, Promise<{ driver: ComputerDriverSession; desktop: ComputerDesktop }>>();
  const resetting = new Map<string, Promise<void>>();
  let closed = false;
  const acquire = (desktopId: string, purpose: 'input' | 'capture' = 'input'): Promise<{ driver: ComputerDriverSession; desktop: ComputerDesktop }> => {
    if (closed) return Promise.reject(new Error('Desktop driver owner has stopped'));
    const reset = resetting.get(desktopId);
    if (reset) return reset.then(() => acquire(desktopId, purpose));
    const key = `${purpose}:${desktopId}`;
    const pending = loading.get(key);
    if (pending) return pending;
    const task = (async () => {
      const { desktop, spec } = await options.resolve(desktopId);
      const drivers = purpose === 'input' ? inputs : captures;
      const existing = drivers.get(desktopId);
      if (existing?.alive()) return { driver: existing, desktop };
      await existing?.dispose();
      if (closed) throw new Error('Desktop driver owner has stopped');
      if (purpose === 'input') options.onInputReset(desktopId);
      const driver = (options.createDriver ?? createDriverSession)({ ...spec,
        env: { ...process.env, ...spec.env, VARIN_DRIVER_ROLE: purpose } });
      drivers.set(desktopId, driver);
      // A new helper only releases keys it owns; it cannot safely reset the
      // physical keyboard after a previous process crashed.
      try {
        const ready = await driver.request({ tool: purpose === 'input' ? 'release_input' : 'ping' });
        if (!ready.ok) throw new Error(ready.error ?? 'Desktop helper initialization failed');
        if (closed) throw new Error('Desktop driver owner has stopped');
        return { driver, desktop };
      } catch (error) {
        if (drivers.get(desktopId) === driver) drivers.delete(desktopId);
        await driver.dispose();
        throw error;
      }
    })();
    loading.set(key, task);
    void task.finally(() => { if (loading.get(key) === task) loading.delete(key); }).catch(() => {});
    return task;
  };
  const reset = (desktopId: string): Promise<void> => {
    const existing = resetting.get(desktopId);
    if (existing) return existing;
    const pending = (async () => {
      await Promise.allSettled([loading.get(`input:${desktopId}`), loading.get(`capture:${desktopId}`)]);
      const drivers = [inputs.get(desktopId), captures.get(desktopId)];
      inputs.delete(desktopId); captures.delete(desktopId); options.onInputReset(desktopId);
      await Promise.allSettled(drivers.map((driver) => driver?.dispose()));
    })();
    resetting.set(desktopId, pending);
    void pending.finally(() => { if (resetting.get(desktopId) === pending) resetting.delete(desktopId); }).catch(() => {});
    return pending;
  };
  return {
    inputs, acquire,
    reset,
    async dispose() {
      closed = true;
      await Promise.allSettled([...loading.values(), ...resetting.values()]);
      await Promise.allSettled([...inputs.values()].map(async (driver) => {
        try {
          if (driver.interrupt) await driver.interrupt();
          else if (driver.alive()) await driver.request({ tool: 'release_input' });
        }
        finally { await driver.dispose(); }
      }));
      await Promise.allSettled([...captures.values()].map((driver) => driver.dispose()));
      inputs.clear(); captures.clear();
    },
  };
}
