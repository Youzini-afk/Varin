import fs from 'node:fs';
import path from 'node:path';
import { createTerminalShellResolver, normalizeTerminalShell, shellIdFromPath } from '../terminal/shells.js';
import type { ExecutionEnvironment } from '../kernel/protocol.generated.js';
import { createPlatformEnvironmentRuntime } from './environment-runtime.js';

/** Host-owned program discovery. Only program facts enter the model's instruction text. */
export function createExecutionEnvironmentRuntime(options: {
  platform: ReturnType<typeof createPlatformEnvironmentRuntime>;
  preference(): Promise<unknown>;
}) {
  const resolver = createTerminalShellResolver({ fs, path, ...options.platform, purpose: 'agent' });
  let inventory: ReturnType<typeof resolver.list> | undefined;
  const snapshot = async (refresh = false): Promise<ExecutionEnvironment> => {
    if (refresh) { options.platform.refresh(); inventory = undefined; }
    const pending = inventory ??= resolver.list();
    let discovered: Awaited<typeof pending>;
    try { discovered = await pending; }
    catch (error) { if (inventory === pending) inventory = undefined; throw error; }
    if (discovered.some(shell => shell.executable && !options.platform.isExecutable(shell.executable))) {
      inventory = resolver.list();
      discovered = await inventory;
    }
    const configured = await options.preference();
    const preference = normalizeTerminalShell(configured) ?? (configured === 'git-bash' ? 'bash' : null);
    // Keep an unavailable explicit selection explicit; never substitute a different language.
    const automatic = discovered.find(shell => shell.id === 'auto')?.executable;
    const defaultShell = preference === 'auto' || configured === undefined
      ? shellIdFromPath(automatic) : preference ?? String(configured);
    const shells = discovered.flatMap(shell => shell.id === 'auto' || !shell.executable ? [] : [{
      id: shell.id, name: shell.name,
      executable: shell.executable,
      ...(process.platform === 'win32' && shell.name === 'Git Bash' ? {
        path: [path.join(shell.executable.replace(/[\\/]((usr[\\/])?bin)[\\/]bash\.exe$/i, ''), 'usr', 'bin'), path.dirname(shell.executable)],
      } : {}),
    }]);
    return { platform: process.platform, defaultShell: defaultShell ?? null, shells, searchPath: options.platform.buildAugmentedPath() };
  };
  return { snapshot };
}

export const defaultExecutionEnvironment = createExecutionEnvironmentRuntime({
  platform: createPlatformEnvironmentRuntime(), preference: async () => 'auto',
});
