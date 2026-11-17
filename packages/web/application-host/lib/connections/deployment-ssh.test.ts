import { afterEach, describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DeploymentSshError, DeploymentSshTransport, type DeploymentSshInspection } from './deployment-ssh.js';
import { HostSshManager, type SshChildProcess } from './ssh-manager.js';

const fingerprint = `SHA256:${'a'.repeat(43)}`;
interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean }
interface Call { command: string; args: string[]; options: SpawnOptions; child: FakeChild; input: string }
const transports: DeploymentSshTransport[] = [];
const directories: string[] = [];
function child(): FakeChild {
  const value = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill(_signal?: NodeJS.Signals) { if (value.exitCode !== null) return true; finish(value, 255); return true; } });
  return value;
}
function finish(value: FakeChild, code: number, stdout = '', stderr = '') {
  queueMicrotask(() => { if (value.exitCode !== null) return; value.stdout.end(stdout); value.stderr.end(stderr); value.exitCode = code; value.emit('close', code); });
}
async function fixture(options: { masterError?: string; masterFingerprint?: string; sshCommand?: string; platform?: NodeJS.Platform; master?: (call: Call) => void; command?: (call: Call) => void } = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-deployment-test-'));
  directories.push(directory);
  const calls: Call[] = [];
  const manager = new HostSshManager({ settingsFilePath: path.join(directory, 'settings.json'), appVersion: 'test', emit: () => {}, platform: options.platform ?? 'linux',
    spawn(command, args, spawnOptions) {
      const process = child();
      const call = { command, args, options: spawnOptions, child: process, input: '' };
      calls.push(call);
      process.stdin.on('data', (data) => { call.input += data.toString(); });
      if (args.includes('ControlMaster=yes')) {
        if (options.master) options.master(call);
        else if (options.masterError) finish(process, 255, '', options.masterError);
        else queueMicrotask(() => { process.stderr.write(`debug1: Server host key: ssh-ed25519 ${options.masterFingerprint ?? fingerprint}\ndebug1: Entering interactive session.\n`); });
      } else if (args.includes('-O')) finish(process, 0);
      else process.stdin.on('finish', () => { if (options.command) options.command(call); else finish(process, 0, '{}'); });
      return process as unknown as SshChildProcess;
    } });
  await manager.setInstances({ instances: [{ id: 'vps', sshCommand: options.sshCommand ?? 'ssh -p 2222 -J jump.example -A -X -o StrictHostKeyChecking=no user@example.test', auth: { sshPassword: { enabled: true, store: 'settings', value: 'ssh-secret' } } }] });
  const transport = new DeploymentSshTransport(manager);
  transports.push(transport);
  return { transport, manager, calls, directory };
}
afterEach(async () => {
  while (transports.length) await transports.pop()!.dispose();
  while (directories.length) await fsp.rm(directories.pop()!, { recursive: true, force: true });
});

const inspection: Omit<DeploymentSshInspection, 'target'> = {
  platform: { id: 'debian', version: '12', kernel: 'Linux', systemd: true }, privileged: true, inventoryComplete: true,
  prerequisites: { systemctl: true, python3: true }, files: [{ path: '/etc/varin/config', kind: 'missing' }],
  listeners: [{ address: '127.0.0.1', port: 7000, protocol: 'tcp' }],
  services: [{ name: 'varin-frps.service', loadState: 'not-found', activeState: 'inactive', fragmentPath: '' }], ownership: { status: 'missing' },
};
const query = { files: ['/etc/varin/config'], ports: [7000], services: ['varin-frps.service'] };

describe('deployment SSH transport', () => {
  test('uses saved SSH config/auth but strict known-host verification and a pinned no-fallback session', async () => {
    const { transport, calls, manager } = await fixture({ command: (call) => finish(call.child, 0, JSON.stringify(inspection)) });
    // This path must not activate a work connection, remote Varin, or persisted reconnect intent.
    manager.connect = async () => { throw new Error('must not start remote Varin'); };
    const session = await transport.openSession('vps');
    expect(session.hostKeyFingerprint).toBe(fingerprint);
    expect(await transport.inspect(session, query)).toEqual({ ...inspection, target: { sshTargetId: 'vps', hostKeyFingerprint: fingerprint } });
    const master = calls[0]!;
    expect(master.args.indexOf('StrictHostKeyChecking=yes')).toBeLessThan(master.args.indexOf('StrictHostKeyChecking=no'));
    expect(master.args).toContain('UpdateHostKeys=no');
    expect(master.args).toContain('-J');
    expect(master.args).toContain('jump.example');
    expect(master.args).not.toContain('-A');
    expect(master.args).not.toContain('-X');
    expect(master.args).toContain('-T');
    expect(master.args).not.toContain('accept-new');
    expect(master.options.env?.VARIN_SSH_ASKPASS_VALUE).toBe('ssh-secret');
    expect(master.args.join(' ')).not.toContain('ssh-secret');
    const remote = calls.find((call) => call.args.at(-1) === 'sh -s')!;
    expect(remote.args).toContain('ProxyCommand=false');
    expect(remote.args).toContain('/dev/null');
    expect(remote.args).not.toContain('-J');
    expect(remote.args).not.toContain('jump.example');
    expect(remote.input).toContain('python3');
    expect(remote.args.join(' ')).not.toContain('python3');
    expect(manager.settingsStore.readSync().hostSshConnections).toBeUndefined();
  });

  test.each(['Host key verification failed.', 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'])('pauses unknown/changed host keys without commands: %s', async (masterError) => {
    const { transport, calls } = await fixture({ masterError });
    await expect(transport.openSession('vps')).rejects.toMatchObject({ code: 'host_key_verification_required', outcomeUnknown: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain('StrictHostKeyChecking=accept-new');
  });

  test('does not attribute an ambiguous ProxyJump/banner fingerprint to the target', async () => {
    const { transport, calls } = await fixture({ masterFingerprint: `${fingerprint}\ndebug1: Server host key: ssh-ed25519 SHA256:${'b'.repeat(43)}` });
    await expect(transport.openSession('vps')).rejects.toMatchObject({ code: 'host_key_verification_required' });
    expect(calls).toHaveLength(1);
  });

  test('OpenSSH resolves strict options before saved flags without making a network connection', async () => {
    const { transport, calls } = await fixture({ sshCommand: 'ssh -F /dev/null -A -X -D 9876 -R 8765:localhost:1234 -o StrictHostKeyChecking=no example.test' });
    await transport.openSession('vps');
    const resolved = spawnSync('ssh', ['-G', ...calls[0]!.args], { encoding: 'utf8', timeout: 3000 });
    expect(resolved.status).toBe(0);
    expect(resolved.stdout).toContain('stricthostkeychecking true');
    expect(resolved.stdout).toContain('forwardagent no');
    expect(resolved.stdout).toContain('forwardx11 no');
    expect(resolved.stdout).not.toContain('dynamicforward');
    expect(resolved.stdout).not.toContain('remoteforward');
  });

  test('fails closed on unsupported Windows transport rather than pretend the connection is pinned', async () => {
    const { transport, calls } = await fixture({ platform: 'win32' });
    await expect(transport.openSession('vps')).rejects.toMatchObject({ code: 'unsupported_host' });
    expect(calls).toHaveLength(0);
  });

  test('rejects copied sessions, forged actions, cross-session execution, replay, and route changes', async () => {
    const { transport, calls, manager } = await fixture({ command: (call) => finish(call.child, 0, 'receipt') });
    const session = await transport.openSession('vps');
    const other = await transport.openSession('vps');
    await expect(transport.inspect({ ...session }, query)).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(transport.execute(session, { actionId: 'arbitrary' })).rejects.toMatchObject({ code: 'invalid_action' });
    const action = transport.prepareAction(session, { script: 'printf receipt' });
    await expect(transport.execute(other, action)).rejects.toMatchObject({ code: 'invalid_action' });
    expect(await transport.execute(session, action)).toEqual({ stdout: 'receipt' });
    await expect(transport.execute(session, action)).rejects.toMatchObject({ code: 'invalid_action' });
    const before = calls.length;
    await manager.setInstances({ instances: [{ id: 'vps', sshCommand: 'ssh other.example.test' }] });
    await expect(transport.inspect(session, query)).rejects.toMatchObject({ code: 'target_changed' });
    expect(calls).toHaveLength(before);
  });

  test('sends generated scripts/secrets only on stdin and never returns raw failure diagnostics', async () => {
    const { transport, calls } = await fixture({ command: (call) => finish(call.child, 1, 'frp-secret', 'ssh-secret frp-secret private-key-content') });
    const session = await transport.openSession('vps');
    const action = transport.prepareAction(session, { script: 'TOKEN=frp-secret\nprintf receipt\n' });
    await expect(transport.execute(session, action)).rejects.toEqual(new DeploymentSshError('remote_failed', true));
    const remote = calls.at(-1)!;
    expect(remote.input).toContain('frp-secret');
    expect(remote.args.join(' ')).not.toContain('frp-secret');
    expect(JSON.stringify(transport)).not.toContain('frp-secret');
  });

  test('does not replay after connection loss and rejects concurrent commands', async () => {
    let pending: Call | undefined;
    const { transport, calls } = await fixture({ command: (call) => { pending = call; } });
    const session = await transport.openSession('vps');
    const action = transport.prepareAction(session, { script: 'change' });
    const started = transport.execute(session, action);
    const rejection = expect(started).rejects.toMatchObject({ code: 'transport_failed', outcomeUnknown: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(transport.inspect(session, query)).rejects.toMatchObject({ code: 'busy' });
    finish(pending!.child, 255, '', 'Connection closed');
    await rejection;
    const before = calls.length;
    await expect(transport.execute(session, action)).rejects.toMatchObject({ code: 'session_closed' });
    expect(calls).toHaveLength(before);
  });

  test('drains timeout processes before releasing the session', async () => {
    const { transport } = await fixture({ command: () => {} });
    const session = await transport.openSession('vps');
    const action = transport.prepareAction(session, { script: 'wait', timeoutMs: 5 });
    await expect(transport.execute(session, action)).rejects.toMatchObject({ code: 'timeout', outcomeUnknown: true });
    expect(() => transport.prepareAction(session, { script: 'retry' })).toThrow('session_closed');
  });

  test('bounds remote stdout and treats a terminated action as an unknown outcome', async () => {
    const { transport } = await fixture({ command: (call) => { call.child.stdout.write('x'.repeat(1024 * 1024 + 1)); } });
    const session = await transport.openSession('vps');
    const action = transport.prepareAction(session, { script: 'output' });
    await expect(transport.execute(session, action)).rejects.toMatchObject({ code: 'output_limit', outcomeUnknown: true });
  });

  test('rejects malformed inspection and shell-sensitive query input before spawning', async () => {
    const { transport, calls } = await fixture({ command: (call) => finish(call.child, 0, '{"inventoryComplete":true}') });
    const session = await transport.openSession('vps');
    const before = calls.length;
    await expect(transport.inspect(session, { ...query, services: ['x;touch /tmp/evil'] })).rejects.toMatchObject({ code: 'invalid_inspection' });
    await expect(transport.inspect(session, { ...query, files: ['/etc/../secret'] })).rejects.toMatchObject({ code: 'invalid_inspection' });
    expect(calls).toHaveLength(before);
    await expect(transport.inspect(session, query)).rejects.toMatchObject({ code: 'invalid_inspection' });
  });

  test('dispose fences an open waiting for authentication setup and drains its files', async () => {
    const { transport, calls, manager } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    let temporaryDirectory = '';
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = manager.writeAskpassFiles.bind(manager);
    manager.writeAskpassFiles = async (directory) => {
      temporaryDirectory = directory;
      entered();
      await gate;
      return await write(directory);
    };
    const opening = transport.openSession('vps');
    const rejected = expect(opening).rejects.toMatchObject({ code: 'session_closed' });
    await started;
    let drained = false;
    const disposing = transport.dispose().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([rejected, disposing]);
    expect(calls).toHaveLength(0);
    await expect(fsp.stat(temporaryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(transport.openSession('vps')).rejects.toMatchObject({ code: 'session_closed' });
  });

  test('dispose stops and drains an unregistered master instead of publishing a late session', async () => {
    let entered!: () => void;
    let partial!: Call;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { transport } = await fixture({ master: (call) => { partial = call; entered(); } });
    const opening = transport.openSession('vps');
    const rejected = expect(opening).rejects.toMatchObject({ code: 'session_closed' });
    await started;
    const controlPath = partial.args.find((arg) => arg.startsWith('ControlPath='))!.slice('ControlPath='.length);
    await Promise.all([transport.dispose(), rejected]);
    expect(partial.child.exitCode).toBe(255);
    await expect(fsp.stat(path.dirname(controlPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(transport.openSession('vps')).rejects.toMatchObject({ code: 'session_closed' });
  });

  test('fixed inspector executes locally read-only and observes files/unsafe ownership without trusting names', async () => {
    const { transport, directory } = await fixture({ command(call) {
      const result = spawnSync('sh', ['-s'], { input: call.input, encoding: 'utf8', timeout: 10_000 });
      finish(call.child, result.status ?? 1, result.stdout, result.stderr);
    } });
    const file = path.join(directory, 'config');
    const symlink = path.join(directory, 'link');
    const missing = path.join(directory, 'missing');
    const marker = path.join(directory, 'ownership.json');
    await fsp.writeFile(file, 'existing-content');
    await fsp.symlink(file, symlink);
    await fsp.writeFile(marker, JSON.stringify({ deploymentId: 'must-not-be-trusted' }));
    const session = await transport.openSession('vps');
    const result = await transport.inspect(session, { files: [file, symlink, missing], ports: [], services: [], ownershipPath: marker });
    expect(result.files.map((entry) => entry.kind)).toEqual(['file', 'symlink', 'missing']);
    expect(result.files[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files[1]!.sha256).toBeUndefined();
    expect(result.files.every((entry) => entry.trustedParent === false)).toBe(true);
    expect(result.ownership).toEqual({ status: 'untrusted' });
    expect(await fsp.readFile(file, 'utf8')).toBe('existing-content');
  });
});
