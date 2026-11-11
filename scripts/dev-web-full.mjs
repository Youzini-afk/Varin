#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stopChildTree, waitForSuccessfulExit, waitForFirstBuildSuccess } from './dev-startup.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform !== 'win32';

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: useDetachedChildren,
    ...options,
  });

  child.on('error', (error) => {
    console.error(`[dev:web:full] Failed to start ${label}:`, error);
    shutdown(1).catch(() => process.exit(1));
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  return child;
}

let shuttingDown = false;
let api = null;
let build = null;
let preparation = null;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(preparation), stopChildTree(api), stopChildTree(build)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (code !== 0 || signal) {
      console.error(`[dev:web:full] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});

process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});

async function start() {
  preparation = run('runtime dependencies', process.execPath, [path.join(repoRoot, 'scripts/build-products.mjs'), 'runtime']);
  await waitForSuccessfulExit(preparation, 'Runtime dependency preparation');
  preparation = null;
  if (shuttingDown) return;
  build = run('build', 'bun', ['run', '--cwd', 'packages/web', 'build:watch']);
  await waitForFirstBuildSuccess(build);
  if (shuttingDown) return;
  build.on('exit', onChildExit('build'));
  console.log('[dev:web:full] Initial frontend build ready, starting API watcher...');
  api = run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch']);
  api.on('exit', onChildExit('api'));
}

start().catch((error) => {
  if (shuttingDown) return;
  console.error('[dev:web:full] Startup failed:', error.message || error);
  shutdown(1).catch(() => process.exit(1));
});
