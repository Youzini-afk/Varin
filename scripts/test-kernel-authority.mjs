import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--build' && !arg.startsWith('--vitest-file='))) {
  throw new Error('Usage: node scripts/test-kernel-authority.mjs [--build] [--vitest-file=<path>]');
}
const vitestFiles = args.filter((arg) => arg.startsWith('--vitest-file=')).map((arg) => arg.slice('--vitest-file='.length));
const env = { ...process.env, VARIN_REQUIRE_RELEASE_KERNEL: '1' };

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`${command} failed (${result.signal ?? result.status ?? 'unknown exit'})`);
  }
}

if (args.includes('--build')) {
  const toolchain = fs.readFileSync(path.join(root, 'kernel/rust-toolchain.toml'), 'utf8');
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  if (!channel) throw new Error('kernel/rust-toolchain.toml has no pinned channel');
  env.RUSTUP_TOOLCHAIN = channel;
  run('rustup', ['toolchain', 'install', channel, '--profile', 'minimal', '--component', 'rustfmt']);
  run(process.execPath, ['scripts/build-kernel.mjs']);
}

const defaultBinary = path.join(root, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const binary = env.VARIN_TEST_KERNEL_PATH?.trim() || env.VARIN_KERNEL_PATH?.trim() || defaultBinary;
if (!fs.existsSync(binary)) {
  throw new Error('Native kernel acceptance cannot skip a missing binary. Run bun run kernel:build or pass --build.');
}
// Every native acceptance fixture must use the binary that this invocation
// verified.  Some fixtures run through a shared process/PTY helper while
// others construct KernelClient directly; keep both explicit so a stale
// developer binary (or a target-triple build) cannot be selected implicitly.
env.VARIN_TEST_KERNEL_PATH = binary;
env.VARIN_KERNEL_PATH = binary;
run(process.execPath, ['scripts/generate-kernel-protocol.mjs', '--check']);
// A default invocation covers both runners. A targeted Vitest invocation must
// not silently run the unrelated full node:test transport suite first.
if (vitestFiles.length === 0) {
  run(process.execPath, ['--import', 'tsx', '--test',
    'packages/web/application-host/lib/kernel/kernel-client.test.ts',
  ]);
}
// The kernel Vitest config collects *.native.test.ts: every file that starts real kernels, durable
// stores or OS process trees runs here and nowhere else. These tests start real
// native resources, so serialize files on every runner; concurrency within
// each test remains exercised without coupling teardown to another fixture.
run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/web/vitest.kernel.config.ts',
  ...vitestFiles,
  '--no-file-parallelism',
]);
