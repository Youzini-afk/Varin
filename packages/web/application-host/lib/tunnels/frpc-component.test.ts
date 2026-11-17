import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrpcComponentService } from './frpc-component.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execute }));

type Entry = { path: string; type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link'; body?: Buffer; linkpath?: string };
const releaseName = 'frp_0.65.0_linux_amd64';
const binary = Buffer.from('synthetic non-executable FRP component fixture');
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function archiveOf(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = new Header({ path: entry.path, type: entry.type ?? 'File',
      mode: 0o755, size: body.length, ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }), uid: 0, gid: 0 });
    const block = Buffer.alloc(512);
    header.encode(block);
    blocks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1_024)]));
}
const normalArchive = () => archiveOf([
  { path: `${releaseName}/`, type: 'Directory' },
  { path: `${releaseName}/LICENSE`, body: Buffer.from('test license') },
  { path: `${releaseName}/frpc`, body: binary },
  { path: `${releaseName}/frps`, body: Buffer.from('not installed') },
]);
const response = (body: Buffer) => new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { force: true, recursive: true }))); });
async function setup(archive = normalArchive()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-frpc-component-test-'));
  directories.push(root);
  const dataDirectory = path.join(root, 'host-data');
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(archive));
  const probe = vi.fn(async () => '0.65.0\n');
  const dependencies = { platform: 'linux' as const, arch: 'x64', fetch: fetcher, probeVersion: probe,
    artifact: { name: releaseName, sha256: sha256(archive), size: archive.length } };
  const options = { dataDirectory, env: {} as NodeJS.ProcessEnv };
  const service = createFrpcComponentService(options, dependencies);
  return { root, dataDirectory, options, dependencies, service, fetcher, probe, archive,
    installDirectory: path.join(dataDirectory, 'components', 'frpc', releaseName) };
}
async function executable(file: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, binary, { mode: 0o700 }); }

describe('frpc component selection', () => {
  it('never creates files or downloads during missing discovery and resolution', async () => {
    const { service, dataDirectory, fetcher, probe } = await setup();
    expect(await service.getStatus()).toEqual({ state: 'missing', source: null, version: null, managedVersion: '0.65.0', installSupported: true });
    await expect(service.resolveExecutable()).rejects.toMatchObject({ code: 'missing_dependency' });
    await expect(fs.stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetcher).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it('prefers configured over PATH and managed; redacts paths from remote views', async () => {
    const c = await setup(); await c.service.install();
    const configured = path.join(c.root, 'private-location', 'frpc');
    const pathBinary = path.join(c.root, 'bin', 'frpc');
    await executable(configured); await executable(pathBinary);
    c.options.env.VARIN_FRPC_PATH = configured; c.options.env.PATH = path.dirname(pathBinary);
    c.probe.mockResolvedValue('v0.66.0\n');
    expect(await c.service.getStatus()).toEqual({ state: 'available', source: 'configured', version: '0.66.0', managedVersion: '0.65.0', installSupported: true });
    expect(await c.service.resolveExecutable()).toBe(configured);
    expect((await c.service.getStatus({ includeOperatorDetails: true })).executablePath).toBe(configured);
    c.fetcher.mockClear(); await c.service.install(); expect(c.fetcher).not.toHaveBeenCalled();
    delete c.options.env.VARIN_FRPC_PATH;
    expect(await c.service.getStatus()).toMatchObject({ source: 'path', state: 'available' });
    expect(await c.service.resolveExecutable()).toBe(pathBinary);
  });
  it.each(['relative/frpc', '/missing/operator/private/frpc', '  ', '/tmp/frpc\0bad'])(
    'never falls back or downloads for invalid configured selection %s', async configured => {
      const c = await setup(); await c.service.install(); c.fetcher.mockClear();
      c.options.env.VARIN_FRPC_PATH = configured;
      expect(await c.service.getStatus()).toMatchObject({ state: 'invalid', source: 'configured' });
      expect(JSON.stringify(await c.service.getStatus())).not.toContain('operator/private');
      await expect(c.service.install()).rejects.toMatchObject({ code: 'invalid_configuration' });
      expect(c.fetcher).not.toHaveBeenCalled();
    },
  );
  it('ignores empty and relative PATH entries, never executing a project-local binary', async () => {
    const c = await setup(); c.options.env.PATH = ':.:relative/bin::';
    expect(await c.service.getStatus()).toMatchObject({ state: 'missing' }); expect(c.probe).not.toHaveBeenCalled();
  });
  it('does not disclose probe output or process errors', async () => {
    const c = await setup(); const installed = path.join(c.root, 'bin', 'frpc'); await executable(installed);
    c.options.env.PATH = path.dirname(installed);
    c.probe.mockResolvedValue('private token=top-secret at /user/private/path');
    expect(await c.service.getStatus()).toMatchObject({ state: 'invalid', source: 'path', version: null });
    expect(JSON.stringify(await c.service.getStatus())).not.toMatch(/top-secret|user\/private/);
    c.probe.mockRejectedValue(new Error('private token=top-secret'));
    await expect(c.service.resolveExecutable()).rejects.toMatchObject({ code: 'invalid_configuration' });
  });
  it('bounds the version-probe invocation and strips Host credentials', async () => {
    const c = await setup(); const installed = path.join(c.root, 'bin', 'frpc'); await executable(installed);
    c.options.env = { VARIN_FRPC_PATH: installed, HOST_SECRET: 'never-forward', VARIN_FRP_TOKEN: 'never-forward' };
    execute.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, '0.65.0\n'));
    const service = createFrpcComponentService(c.options, { platform: 'linux', arch: 'x64', fetch: c.fetcher });
    expect(await service.getStatus()).toMatchObject({ state: 'available', version: '0.65.0' });
    expect(execute).toHaveBeenCalledWith(installed, ['--version'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 4_096,
      shell: false, windowsHide: true, env: { LANG: 'C', LC_ALL: 'C' }, cwd: path.dirname(installed),
    }, expect.any(Function));
    execute.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error, stdout: string) => void) => callback(new Error('secret probe failure'), 'secret output'));
    expect(await service.getStatus()).toMatchObject({ state: 'invalid', version: null });
    expect(JSON.stringify(await service.getStatus())).not.toContain('secret');
    expect(c.fetcher).not.toHaveBeenCalled();
  });
  it.each([['win32', 'x64'], ['linux', 'ia32'], ['darwin', 'riscv64'], ['freebsd', 'x64']] as const)(
    'fails closed for unsupported %s/%s', async (platform, arch) => {
      const c = await setup(); const service = createFrpcComponentService(c.options, { ...c.dependencies, platform, arch });
      expect(await service.getStatus()).toMatchObject({ state: 'unsupported', installSupported: false });
      await expect(service.install()).rejects.toMatchObject({ code: 'unsupported_platform' });
      expect(c.fetcher).not.toHaveBeenCalled();
    },
  );
});

describe('explicit managed installation', () => {
  it('verifies, extracts only frpc, atomically publishes, and reopens without executing the fixture', async () => {
    const c = await setup();
    expect(await c.service.install()).toMatchObject({ state: 'available', source: 'managed', version: '0.65.0' });
    expect(c.fetcher).toHaveBeenCalledExactlyOnceWith(`https://github.com/fatedier/frp/releases/download/v0.65.0/${releaseName}.tar.gz`,
      expect.objectContaining({ redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal) }));
    expect(await fs.readdir(c.installDirectory)).toEqual(['component.json', 'frpc']);
    const installedPath = path.join(c.installDirectory, 'frpc');
    expect(await fs.readFile(installedPath)).toEqual(binary);
    expect((await fs.stat(installedPath)).mode & 0o777).toBe(0o500);
    expect((await fs.stat(c.installDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(c.installDirectory, 'component.json'))).mode & 0o777).toBe(0o400);
    const reopened = createFrpcComponentService(c.options, c.dependencies);
    expect(await reopened.resolveExecutable()).toBe(installedPath);
    expect((await reopened.getStatus()).executablePath).toBeUndefined();
    expect((await reopened.getStatus({ includeOperatorDetails: true })).executablePath).toBe(installedPath);
    await reopened.install(); expect(c.fetcher).toHaveBeenCalledTimes(1); expect(c.probe).not.toHaveBeenCalled();
  });
  it('coalesces repeated clicks and accepts a concurrent valid committed generation', async () => {
    const c = await setup(); const first = c.service.install(); expect(c.service.install()).toBe(first);
    const other = createFrpcComponentService(c.options, c.dependencies);
    const statuses = await Promise.all([first, other.install()]);
    expect(statuses.every(status => status.state === 'available')).toBe(true);
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([releaseName]);
  });
  it('detects binary and metadata corruption and refuses silent replacement', async () => {
    const c = await setup(); await c.service.install(); const binaryPath = path.join(c.installDirectory, 'frpc');
    await fs.chmod(binaryPath, 0o700); await fs.writeFile(binaryPath, 'tampered');
    expect(await c.service.getStatus()).toMatchObject({ state: 'invalid', source: 'managed' });
    await expect(c.service.resolveExecutable()).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(c.service.install()).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(c.fetcher).toHaveBeenCalledTimes(1); await fs.writeFile(binaryPath, binary);
    const metadataPath = path.join(c.installDirectory, 'component.json'); await fs.chmod(metadataPath, 0o600);
    await fs.writeFile(metadataPath, JSON.stringify({ schema: 99, version: 'future' }));
    expect(await c.service.getStatus()).toMatchObject({ state: 'invalid', source: 'managed' });
  });
  it('rejects checksum mismatch and cleans staging', async () => {
    const c = await setup(); const service = createFrpcComponentService(c.options, { ...c.dependencies,
      artifact: { ...c.dependencies.artifact, sha256: '0'.repeat(64) } });
    await expect(service.install()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]);
    expect(await service.getStatus()).toMatchObject({ state: 'missing' });
  });
  const unsafe: Entry[][] = [
    [{ path: `${releaseName}/../escape`, body: binary }, { path: `${releaseName}/frpc`, body: binary }],
    [{ path: '/tmp/escape', body: binary }, { path: `${releaseName}/frpc`, body: binary }],
    [{ path: `${releaseName}/frpc`, type: 'SymbolicLink', linkpath: '/bin/sh' }],
    [{ path: `${releaseName}/frpc`, type: 'Link', linkpath: '/bin/sh' }],
    [{ path: `${releaseName}/frpc`, body: binary }, { path: `${releaseName}/frpc`, body: binary }],
    [{ path: `${releaseName}/frps`, body: binary }],
  ];
  it.each(unsafe.map(entries => ({ entries })))('rejects unsafe or incomplete archive %#', async ({ entries }) => {
    const c = await setup(archiveOf(entries));
    await expect(c.service.install()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]); expect(c.probe).not.toHaveBeenCalled();
  });
  it.each([Buffer.from('not gzip'), gzipSync(Buffer.from('not tar'))])('rejects malformed archive structure %#', async archive => {
    const c = await setup(archive);
    await expect(c.service.install()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]);
  });
  it('refuses symlinked managed storage before downloading', async () => {
    const c = await setup(); const outside = path.join(c.root, 'outside');
    await fs.mkdir(outside); await fs.mkdir(c.dataDirectory); await fs.symlink(outside, path.join(c.dataDirectory, 'components'));
    await expect(c.service.install()).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(c.fetcher).not.toHaveBeenCalled(); expect(await fs.readdir(outside)).toEqual([]);
  });
  it('refuses symlinks in a published generation', async () => {
    const c = await setup(); await c.service.install(); const binaryPath = path.join(c.installDirectory, 'frpc');
    const outside = path.join(c.root, 'outside-frpc'); await executable(outside);
    await fs.unlink(binaryPath); await fs.symlink(outside, binaryPath);
    expect(await c.service.getStatus()).toMatchObject({ state: 'invalid', source: 'managed' }); expect(c.probe).not.toHaveBeenCalled();
  });
});

describe('download boundaries', () => {
  it('follows only official HTTPS release-asset redirects without credentials', async () => {
    const c = await setup(); c.fetcher.mockResolvedValueOnce(new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/signed-asset' } }));
    await c.service.install();
    expect(c.fetcher).toHaveBeenNthCalledWith(2, 'https://release-assets.githubusercontent.com/signed-asset', expect.objectContaining({ credentials: 'omit' }));
  });
  it.each(['http://release-assets.githubusercontent.com/asset', 'https://attacker.test/asset', 'https://github.com:444/asset', 'https://user:secret@github.com/asset'])(
    'rejects unsafe redirect %s', async location => {
      const c = await setup(); c.fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      await expect(c.service.install()).rejects.toMatchObject({ code: 'download_failed' });
      expect(c.fetcher).toHaveBeenCalledTimes(1); expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]);
    },
  );
  it('bounds redirect count and rejects truncated and oversized responses', async () => {
    const c = await setup();
    c.fetcher.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/again' } }));
    await expect(c.service.install()).rejects.toMatchObject({ code: 'download_failed' }); expect(c.fetcher).toHaveBeenCalledTimes(4);
    c.fetcher.mockImplementation(async () => new Response(new Uint8Array(c.archive.subarray(0, -1))));
    await expect(c.service.install()).rejects.toMatchObject({ code: 'integrity_failed' });
    c.fetcher.mockImplementation(async () => new Response(new Uint8Array(Buffer.concat([c.archive, Buffer.from('extra')]))));
    await expect(c.service.install()).rejects.toMatchObject({ code: 'download_failed' });
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]);
  });
  it('aborts a stalled download at the explicit operation deadline', async () => {
    const c = await setup(); let signal: AbortSignal | undefined;
    c.fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new Error('timed out with private URL')), { once: true });
    }));
    const service = createFrpcComponentService(c.options, { ...c.dependencies, downloadTimeoutMs: 10 });
    await expect(service.install()).rejects.toMatchObject({ code: 'download_failed' }); expect(signal?.aborted).toBe(true);
    expect(await fs.readdir(path.dirname(c.installDirectory))).toEqual([]);
  });
  it.each([
    ['linux', 'x64', 'linux_amd64'], ['linux', 'arm64', 'linux_arm64'],
    ['darwin', 'x64', 'darwin_amd64'], ['darwin', 'arm64', 'darwin_arm64'],
  ] as const)('uses a fixed official %s/%s asset', async (platform, arch, releasePlatform) => {
    const c = await setup(); const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('test never downloads real executables'));
    const service = createFrpcComponentService(c.options, { platform, arch, fetch: fetcher });
    expect(await service.getStatus()).toMatchObject({ installSupported: true });
    await expect(service.install()).rejects.toMatchObject({ code: 'download_failed' });
    expect(fetcher).toHaveBeenCalledWith(`https://github.com/fatedier/frp/releases/download/v0.65.0/frp_0.65.0_${releasePlatform}.tar.gz`, expect.anything());
  });
});
