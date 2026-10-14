/** A clean-process relay. The replacement cannot start before the original Host drains. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// The relay loads no application code. Keeping it alive while the Host stops avoids
// depending on a closing extension, HTTP socket, worker or event loop for relaunch.
const relaySource = `
const { spawn } = require('node:child_process');
let launched = false;
process.on('disconnect', () => { if (!launched) process.exit(0); });
process.once('message', message => {
  if (message?.kind !== 'launch') return process.exit(0);
  const child = spawn(message.executable, message.args, { cwd: message.cwd, env: process.env, stdio: 'inherit', detached: true });
  child.once('error', () => { process.send?.({ kind: 'failed' }, () => process.exit(1)); });
  child.once('spawn', () => { launched = true; child.unref(); process.send?.({ kind: 'launched' }, () => process.disconnect()); });
});
process.send({ kind: 'ready' });
`;
function message(child: ChildProcess, expected: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', receive); child.off('error', failed); child.off('exit', exited); child.off('disconnect', failed); signal.removeEventListener('abort', failed); };
    const failed = () => { cleanup(); reject(new Error('Application Host relaunch failed')); };
    const exited = () => failed();
    const receive = (value: unknown) => {
      const kind = value && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
      if (kind === 'failed') failed();
      else if (kind === expected) { cleanup(); resolve(); }
    };
    child.on('message', receive); child.once('error', failed); child.once('exit', exited); child.once('disconnect', failed); signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) failed();
  });
}
export function createProcessRestart(options: {
  stop(): Promise<void>;
  executable?: string;
  args?: readonly string[];
  cwd?: string;
  exit?: (code: number) => void;
  spawn?: typeof spawn;
}) {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    const child = (options.spawn ?? spawn)(process.execPath, ['-e', relaySource], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env });
    const observation = new AbortController();
    const ready = message(child, 'ready', observation.signal);
    const launched = message(child, 'launched', observation.signal);
    // A relay may fail while the Host drains; retain that outcome without interrupting
    // physical stop or leaving an unhandled child-process error.
    void launched.catch(() => {});
    try {
      await ready;
      await options.stop();
      if (!child.connected) throw new Error('Application Host relaunch failed');
      child.send({ kind: 'launch', executable: options.executable ?? process.execPath,
        args: options.args ?? [...process.execArgv, ...process.argv.slice(1)], cwd: options.cwd ?? process.cwd() }, error => { if (error) observation.abort(error); });
      await launched;
      child.unref();
      (options.exit ?? (code => process.exit(code)))(0);
    } catch (error) {
      observation.abort(error);
      if (child.connected) child.disconnect();
      throw error;
    }
  })().finally(() => { pending = undefined; });
}
