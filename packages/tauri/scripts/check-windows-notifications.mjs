// Compile the real Windows COM/WinRT owner without downloading or building CEF.
// This is a cross-platform typecheck, not a replacement for installed OS smoke.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { target: 'x86_64-pc-windows-msvc', offline: false, targetDir: null };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--offline') options.offline = true;
  else if (arg === '--target' || arg === '--target-dir') {
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${arg} value`);
    if (arg === '--target') options.target = value;
    else options.targetDir = path.resolve(value);
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (!['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(options.target)) {
  throw new Error('Choose a supported Windows MSVC target');
}
const temporary = await mkdtemp(path.join(tmpdir(), 'varin-notification-check-'));
const sourceRoot = path.join(packageRoot, 'src-tauri', 'src');
const run = (program, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { stdio: 'inherit', env, shell: false });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} failed (${code ?? signal})`)));
});
try {
  const cargo = await readFile(path.join(packageRoot, 'src-tauri', 'Cargo.toml'), 'utf8');
  const dependencies = ['windows', 'windows-core'].map(name => {
    const line = cargo.split('\n').find(line => line.startsWith(`${name} = `));
    if (!line) throw new Error(`Missing native ${name} dependency`);
    return line.replace(/,\s*optional\s*=\s*true/, '');
  }).join('\n');
  await writeFile(path.join(temporary, 'Cargo.toml'), `[package]\nname = "varin-notification-typecheck"\nversion = "0.0.0"\nedition = "2024"\n[lib]\npath = "check.rs"\n[dependencies]\n${dependencies}\n`);
  const rustPath = name => JSON.stringify(path.join(sourceRoot, name).replaceAll('\\', '/'));
  await writeFile(path.join(temporary, 'check.rs'), `#![allow(dead_code)]\n#[path = ${rustPath('native_notifications_windows_policy.rs')}]\nmod windows_policy;\n#[path = ${rustPath('native_notifications_windows.rs')}]\nmod windows;\npub use windows::Owner;\n`);
  const binary = path.join(temporary, process.platform === 'win32' ? 'policy-tests.exe' : 'policy-tests');
  await run('rustc', ['--edition', '2024', '--test', path.join(sourceRoot, 'native_notifications_windows_policy.rs'), '-o', binary]);
  await run(binary, []);
  await run('cargo', ['check', '--manifest-path', path.join(temporary, 'Cargo.toml'), '--target', options.target, ...(options.offline ? ['--offline'] : [])], {
    ...process.env, CARGO_TARGET_DIR: options.targetDir ?? path.join(temporary, 'target'),
  });
  console.log(`Windows notification policy and native API typecheck passed (${options.target}); installed Windows behavior still requires OS smoke.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
