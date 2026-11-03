/** Node-only process entry contract. Never export through the browser-safe root. */
import path from 'node:path';

export interface NodeRuntimeContext {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  versions?: { node?: string; electron?: string; bun?: string };
  platform?: NodeJS.Platform;
}

/** Packaged desktops set VARIN_NODE_PATH from their verified release manifest.
 * An invalid explicit selection is an error, never permission to search PATH or
 * start another desktop executable. Electron's transitional mode is isolated here.
 * File integrity/version checks belong to the release launcher, not every worker. */
export function resolveNodeRuntime(context: NodeRuntimeContext = {}): { executable: string; env: NodeJS.ProcessEnv } {
  const env = context.env ?? process.env;
  const executable = env.VARIN_NODE_PATH?.trim() || context.execPath || process.execPath;
  const platform = context.platform ?? process.platform;
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(executable) || executable.includes('\0')) {
    throw new Error('VARIN_NODE_PATH must identify an absolute Node executable');
  }
  const versions = context.versions ?? process.versions;
  const childEnv = { ...env };
  delete childEnv.NODE_CHANNEL_FD;
  delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Keep the old shell operable until it is retired. A separately supplied Node
  // never receives Electron flags, even when the parent happens to be Electron.
  if (!env.VARIN_NODE_PATH?.trim() && versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
  return { executable, env: childEnv };
}

/** Headless providers can explicitly name the transitional Electron executable.
 * Ordinary binaries must not inherit its mode or the parent's private IPC fd. */
export function nodeProcessEnvironment(executable: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.NODE_CHANNEL_FD;
  delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (process.versions.electron && executable === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = '1';
  return childEnv;
}
