import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ExternalAgentConfiguration } from '@varin/application-client';

/** The desktop app extracts its CLI into a different directory on upgrade. */
export async function findDesktopCodexExecutable(localAppData: string | undefined): Promise<string | undefined> {
  if (!localAppData || !path.isAbsolute(localAppData)) return;
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const executable = path.join(root, entry.name, 'codex.exe');
    const metadata = await stat(executable).catch(() => null);
    return metadata?.isFile() ? { executable, modifiedAt: metadata.mtimeMs } : null;
  }));
  return candidates.filter(candidate => candidate !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.executable.localeCompare(b.executable))[0]?.executable;
}

/** Used only after the configured command cannot be found on the Host's PATH. */
export async function findInstalledExternalExecutable(config: Pick<ExternalAgentConfiguration, 'harness' | 'command'>): Promise<string | undefined> {
  if (process.platform !== 'win32') return;
  const command = config.command.trim().toLowerCase();
  if (config.harness === 'codex' && (command === 'codex' || command === 'codex.exe')) {
    return findDesktopCodexExecutable(process.env.LOCALAPPDATA);
  }
  if (config.harness === 'claude' && (command === 'claude' || command === 'claude.exe')) {
    return path.join(homedir(), '.local', 'bin', 'claude.exe');
  }
}
