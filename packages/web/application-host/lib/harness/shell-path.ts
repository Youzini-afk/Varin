import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessActorContext } from '@varin/protocol';
import type { ManagedSpawn } from '../process/types.js';
import { waitForManagedExit } from '../process/types.js';
import type { ShellInterpreter } from './shell-supervisor.js';

/** Interpret POSIX absolute paths only in a session whose selected local shell is Git Bash. */
export function createShellPathResolver(options: {
  interpreter(sessionId: string): ShellInterpreter | { unavailable: unknown } | null;
  spawn: ManagedSpawn;
}) {
  return async (actor: HarnessActorContext, input: string): Promise<string> => {
    if (process.platform !== 'win32' || !/^\/(?!\/)/.test(input)) return input;
    const interpreter = options.interpreter(actor.sessionId);
    if (!interpreter || !('kind' in interpreter) || interpreter.kind !== 'git-bash') return input;
    const directory = path.dirname(interpreter.command);
    const candidates = [path.join(directory, 'cygpath.exe'), path.resolve(directory, '../usr/bin/cygpath.exe')];
    let command: string | undefined;
    for (const candidate of candidates) {
      try { await fs.access(candidate); command = candidate; break; } catch { /* try the same Git installation's other layout */ }
    }
    if (!command) throw new Error(`Git Bash path conversion is unavailable for ${input}; use a Windows drive path.`);
    const child = await options.spawn(command, ['-aw', '--', input], {
      cwd: actor.cwd ?? directory, env: { ...process.env, ...interpreter.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const read = async (stream: typeof child.stdout): Promise<string> => {
      const chunks: Buffer[] = [];
      if (stream) for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    };
    const [output, error] = await Promise.all([read(child.stdout), read(child.stderr), waitForManagedExit(child)]);
    const resolved = output.replace(/\r?\n$/, '');
    if (child.exitCode !== 0 || !/^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(resolved)) {
      throw new Error(`Cannot resolve Git Bash path ${input}${error.trim() ? `: ${error.trim()}` : ''}`);
    }
    return resolved;
  };
}
