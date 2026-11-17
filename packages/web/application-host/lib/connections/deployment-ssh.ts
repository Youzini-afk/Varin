import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostSshManager, ParsedSshCommand, SshChildProcess, SshInstance } from './ssh-manager.js';

/** Host-internal transport. Never deserialize these objects from a request body. */
export interface DeploymentSshSession {
  readonly sessionId: string;
  readonly sshTargetId: string;
  readonly hostKeyFingerprint: string;
}

export interface DeploymentSshAction {
  readonly actionId: string;
}

export type DeploymentSshErrorCode = 'target_changed' | 'host_key_verification_required' | 'authentication_required'
  | 'unsupported_host' | 'session_closed' | 'invalid_session' | 'invalid_action' | 'busy'
  | 'timeout' | 'output_limit' | 'transport_failed' | 'remote_failed' | 'invalid_inspection';

/** Intentionally contains no subprocess output: SSH/remote diagnostics may contain credentials. */
export class DeploymentSshError extends Error {
  constructor(readonly code: DeploymentSshErrorCode, readonly outcomeUnknown = false) {
    super(`Deployment SSH: ${code}`);
    this.name = 'DeploymentSshError';
  }
}

export interface DeploymentSshInspectQuery {
  ports: number[];
  files: string[];
  services: string[];
  ownershipPath?: string;
}

export interface DeploymentSshInspection {
  target: { sshTargetId: string; hostKeyFingerprint: string };
  platform: { id: string; version: string; kernel: string; systemd: boolean; systemdVersion?: number };
  privileged: boolean;
  inventoryComplete: boolean;
  prerequisites: Record<string, boolean>;
  files: Array<{ path: string; kind: 'file' | 'symlink' | 'directory' | 'missing' | 'other'; sha256?: string; uid?: number; gid?: number; trustedParent?: boolean }>;
  listeners: Array<{ address: string; port: number; protocol: 'tcp' | 'udp' }>;
  services: Array<{ name: string; loadState: string; activeState: string; fragmentPath: string }>;
  ownership: { status: 'missing' | 'untrusted' | 'present'; manifest?: unknown };
}

interface SessionRecord {
  handle: DeploymentSshSession;
  parsed: ParsedSshCommand;
  routeDigest: string;
  directory: string;
  controlPath: string;
  master: SshChildProcess;
  masterDone: Promise<void>;
  state: 'ready' | 'paused' | 'closed';
  busy: boolean;
  active: Set<SshChildProcess>;
}

interface ActionRecord {
  session: SessionRecord;
  script: string;
  timeoutMs: number;
  used: boolean;
}

interface CommandResult { code: number; stdout: string; stderr: string }
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const fingerprintPattern = /^debug1: Server host key: \S+ (SHA256:[A-Za-z0-9+/]{43}=?)\s*$/gm;
const isHostKeyFailure = (value: string): boolean => /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key|REVOKED HOST KEY/i.test(value);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeDigest = (instance: SshInstance): string => digest({
  command: instance.sshCommand,
  // A credential/configuration change invalidates an existing review, without disclosing it.
  auth: instance.auth.sshPassword,
  timeout: instance.connectionTimeoutSec,
});

// OpenSSH uses the FIRST value. Place these ahead of saved options and ssh_config.
// Keep the usual OpenSSH config, identities, agents, ProxyJump and known_hosts owners.
const strictOptions = (master = false): string[] => [
  '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
  '-o', 'VerifyHostKeyDNS=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
  '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
  '-o', 'RequestTTY=no', '-o', 'RemoteCommand=none', '-o', `SessionType=${master ? 'none' : 'default'}`,
  '-o', 'ForkAfterAuthentication=no', '-o', 'LogLevel=DEBUG1',
];

/**
 * Deployment does not call HostSshManager.connect(): that would install/start Varin.
 * A private ControlMaster pins all commands to ONE authenticated connection. A
 * missing master must not cause ssh to silently open a second connection.
 * Windows OpenSSH lacks ControlMaster, so it is explicitly unsupported for now.
 */
export class DeploymentSshTransport {
  private readonly sessions = new WeakMap<DeploymentSshSession, SessionRecord>();
  private readonly actions = new WeakMap<DeploymentSshAction, ActionRecord>();
  private readonly openSessions = new Set<SessionRecord>();
  private readonly opening = new Set<Promise<DeploymentSshSession>>();
  private readonly openingMasters = new Set<SshChildProcess>();
  private disposed = false;

  constructor(private readonly manager: HostSshManager) {}

  private instance(id: string): SshInstance {
    const candidate = this.manager.readInstances().instances.find((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === id);
    if (!candidate) throw new DeploymentSshError('target_changed');
    // Parse the saved command again; never trust a persisted sshParsed object.
    return this.manager.sanitizeInstance(candidate);
  }

  private spawn(parsed: ParsedSshCommand, leadingArgs: string[], command?: string): SshChildProcess {
    // Use the original owner for process tracking/auth/OS behavior. Construct a
    // fresh argument array here so safety options precede the saved arguments.
    const mux = leadingArgs.includes('ProxyCommand=false');
    // A multiplex client needs only its private socket, never a mutable route,
    // ProxyJump or user-supplied forwarding flag. -A/-X/-Y can override -o.
    const savedArgs = mux ? [] : parsed.args.filter((arg) => !['-A', '-X', '-Y'].includes(arg));
    const effective: ParsedSshCommand = { destination: parsed.destination, args: [...leadingArgs, ...savedArgs] };
    const auth = this.manager.sshAuth.get(parsed);
    if (auth) this.manager.sshAuth.set(effective, auth);
    return this.manager.spawnSsh(effective, [], { stdio: ['pipe', 'pipe', 'pipe'] }, command ?? null);
  }

  async openSession(sshTargetId: string): Promise<DeploymentSshSession> {
    if (this.disposed) throw new DeploymentSshError('session_closed');
    const pending = this.openSessionPending(sshTargetId);
    this.opening.add(pending);
    try {
      const handle = await pending;
      if (this.disposed) throw new DeploymentSshError('session_closed');
      return handle;
    } finally { this.opening.delete(pending); }
  }

  private async openSessionPending(sshTargetId: string): Promise<DeploymentSshSession> {
    if (!this.manager.usesControlMaster()) throw new DeploymentSshError('unsupported_host');
    const instance = this.instance(sshTargetId);
    const parsed = instance.sshParsed;
    if (!parsed.destination || Array.from(parsed.destination).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || parsed.destination.startsWith('-')) {
      throw new DeploymentSshError('target_changed');
    }
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-deploy-'));
    const controlPath = path.join(directory, 'ssh.sock');
    let master: SshChildProcess | undefined;
    let masterDone: Promise<void> | undefined;
    try {
      if (this.disposed) throw new DeploymentSshError('session_closed');
      await fsp.chmod(directory, 0o700);
      if (this.disposed) throw new DeploymentSshError('session_closed');
      const { askpassPath } = await this.manager.writeAskpassFiles(directory);
      if (this.disposed) throw new DeploymentSshError('session_closed');
      this.manager.sshAuth.set(parsed, {
        askpassPath,
        sshPassword: instance.auth.sshPassword?.enabled ? instance.auth.sshPassword.value?.trim() ?? null : null,
        children: new Set(),
      });
      master = this.spawn(parsed, [
        ...strictOptions(true), '-o', 'ControlMaster=yes', '-o', `ControlPath=${controlPath}`,
        '-o', 'ControlPersist=no', '-o', `ConnectTimeout=${Math.ceil(instance.connectionTimeoutSec)}`,
        '-T',
      ]);
      this.openingMasters.add(master);
      let diagnostic = '';
      const observedFingerprints = new Set<string>();
      let exited = false;
      master.stderr?.on('data', (chunk) => {
        const received = diagnostic + chunk.toString();
        for (const match of received.matchAll(fingerprintPattern)) observedFingerprints.add(match[1]!);
        diagnostic = received.slice(-MAX_DIAGNOSTIC_BYTES);
      });
      masterDone = new Promise<void>((resolve) => {
        master!.on('close', () => { exited = true; resolve(); });
        master!.on('error', () => { exited = true; });
      });
      master.stdin?.end();
      const deadline = Date.now() + Math.min(instance.connectionTimeoutSec * 1000, 120_000);
      let verifiedFingerprint: string | undefined;
      while (Date.now() < deadline && !exited) {
        if (this.disposed) throw new DeploymentSshError('session_closed');
        const fingerprint = [...observedFingerprints][0];
        // Verbose ProxyJump processes or banners must not be confused with the
        // authenticated target key. Ambiguous diagnostics fail closed.
        if (observedFingerprints.size > 1) throw new DeploymentSshError('host_key_verification_required');
        if (isHostKeyFailure(diagnostic)) throw new DeploymentSshError('host_key_verification_required');
        if (fingerprint) {
          const check = await this.run(parsed, this.muxArgs(controlPath, true), undefined, undefined, 3_000);
          if (check.code === 0) {
            if (observedFingerprints.size !== 1) throw new DeploymentSshError('host_key_verification_required');
            verifiedFingerprint = fingerprint; break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.disposed) throw new DeploymentSshError('session_closed');
      if (!verifiedFingerprint || exited) {
        if (isHostKeyFailure(diagnostic)) throw new DeploymentSshError('host_key_verification_required');
        if (/Permission denied|Authentication failed/i.test(diagnostic)) throw new DeploymentSshError('authentication_required');
        throw new DeploymentSshError(exited ? 'transport_failed' : 'timeout');
      }
      if (routeDigest(this.instance(sshTargetId)) !== routeDigest(instance)) throw new DeploymentSshError('target_changed');
      const handle = Object.freeze({ sessionId: randomUUID(), sshTargetId, hostKeyFingerprint: verifiedFingerprint });
      const record: SessionRecord = { handle, parsed, directory, controlPath, master, masterDone, routeDigest: routeDigest(instance), state: 'ready', busy: false, active: new Set() };
      master.on('close', () => { record.state = 'closed'; });
      master.on('error', () => { record.state = 'closed'; });
      this.sessions.set(handle, record);
      this.openSessions.add(record);
      return handle;
    } catch (error) {
      if (master) {
        master.kill('SIGTERM');
        const kill = setTimeout(() => { master?.kill('SIGKILL'); }, 1_000);
        kill.unref();
        await masterDone;
        clearTimeout(kill);
      }
      this.manager.sshAuth.delete(parsed);
      await fsp.rm(directory, { recursive: true, force: true });
      if (error instanceof DeploymentSshError) throw error;
      throw new DeploymentSshError('transport_failed');
    } finally { if (master) this.openingMasters.delete(master); }
  }

  private muxArgs(controlPath: string, check = false): string[] {
    return [...strictOptions(), '-F', '/dev/null', '-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`,
      '-o', 'ProxyCommand=false', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-T',
      ...(check ? ['-O', 'check'] : [])];
  }

  private current(handle: DeploymentSshSession): SessionRecord {
    if (this.disposed) throw new DeploymentSshError('session_closed');
    const record = this.sessions.get(handle);
    if (!record) throw new DeploymentSshError('invalid_session');
    if (record.state !== 'ready') throw new DeploymentSshError('session_closed');
    try {
      if (routeDigest(this.instance(handle.sshTargetId)) !== record.routeDigest) throw new DeploymentSshError('target_changed');
    } catch {
      record.state = 'paused';
      throw new DeploymentSshError('target_changed');
    }
    return record;
  }

  /** Register only a script generated by a trusted provisioner AFTER plan review. */
  prepareAction(handle: DeploymentSshSession, input: { script: string; timeoutMs?: number }): DeploymentSshAction {
    const record = this.current(handle);
    if (!input.script || input.script.includes('\0')) throw new DeploymentSshError('invalid_action');
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new DeploymentSshError('invalid_action');
    const action = Object.freeze({ actionId: randomUUID() });
    this.actions.set(action, { session: record, script: input.script, timeoutMs, used: false });
    return action;
  }

  /** A capability is single-use. Unknown effects are not replayed by this layer. */
  async execute(handle: DeploymentSshSession, action: DeploymentSshAction): Promise<{ stdout: string }> {
    const record = this.current(handle);
    const registered = this.actions.get(action);
    if (!registered || registered.session !== record || registered.used) throw new DeploymentSshError('invalid_action');
    if (record.busy) throw new DeploymentSshError('busy');
    registered.used = true;
    return await this.executeScript(record, registered.script, registered.timeoutMs, true);
  }

  private async executeScript(record: SessionRecord, script: string, timeoutMs: number, mutating: boolean): Promise<{ stdout: string }> {
    if (record.busy) throw new DeploymentSshError('busy');
    record.busy = true;
    try {
      const result = await this.run(record.parsed, this.muxArgs(record.controlPath), 'sh -s', script, timeoutMs, record.active, mutating);
      if (result.code !== 0) {
        if (isHostKeyFailure(result.stderr)) {
          record.state = 'paused';
          throw new DeploymentSshError('host_key_verification_required', mutating);
        }
        if (result.code === 255) record.state = 'paused';
        throw new DeploymentSshError(result.code === 255 ? 'transport_failed' : 'remote_failed', mutating);
      }
      try { this.current(record.handle); }
      catch (error) {
        throw new DeploymentSshError(error instanceof DeploymentSshError ? error.code : 'target_changed', mutating);
      }
      return { stdout: result.stdout };
    } catch (error) {
      if (mutating && error instanceof DeploymentSshError && error.outcomeUnknown) record.state = 'paused';
      throw error;
    } finally { record.busy = false; }
  }

  private async run(parsed: ParsedSshCommand, args: string[], command: string | undefined, input: string | undefined, timeoutMs: number,
    active?: Set<SshChildProcess>, mutating = false): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      let child: SshChildProcess;
      try { child = this.spawn(parsed, args, command); }
      catch { reject(new DeploymentSshError('transport_failed')); return; }
      active?.add(child);
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let failure: DeploymentSshError | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: DeploymentSshErrorCode) => {
        if (failure) return;
        failure = new DeploymentSshError(code, mutating);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1_000);
        killTimer.unref();
      };
      const timeout = setTimeout(() => stop('timeout'), timeoutMs);
      timeout.unref();
      const finish = () => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); active?.delete(child); };
      child.stdout?.on('data', (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) { stop('output_limit'); return; }
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES); });
      child.on('error', () => { failure = new DeploymentSshError('transport_failed', mutating); });
      child.on('close', (code) => {
        finish();
        if (failure) reject(failure);
        else resolve({ code: code ?? -1, stdout, stderr });
      });
      try { child.stdin?.end(input); }
      catch { stop('transport_failed'); }
    });
  }

  async inspect(handle: DeploymentSshSession, query: DeploymentSshInspectQuery): Promise<DeploymentSshInspection> {
    const record = this.current(handle);
    const normalized = validateQuery(query);
    const { stdout } = await this.executeScript(record, inspectionScript(normalized), DEFAULT_COMMAND_TIMEOUT_MS, false);
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { throw new DeploymentSshError('invalid_inspection'); }
    if (!validInspection(value)
      || value.files.length !== normalized.files.length || new Set(value.files.map((file) => file.path)).size !== normalized.files.length
      || value.files.some((file) => !normalized.files.includes(file.path))
      || (value.inventoryComplete && value.services.length !== normalized.services.length) || new Set(value.services.map((service) => service.name)).size !== value.services.length
      || value.services.some((service) => !normalized.services.includes(service.name))
      || value.listeners.some((listener) => !normalized.ports.includes(listener.port))) throw new DeploymentSshError('invalid_inspection');
    return { ...value, target: { sshTargetId: handle.sshTargetId, hostKeyFingerprint: handle.hostKeyFingerprint } };
  }

  async closeSession(handle: DeploymentSshSession): Promise<void> {
    const record = this.sessions.get(handle);
    if (!record) throw new DeploymentSshError('invalid_session');
    record.state = 'closed';
    const children = [...record.active];
    const pending = children.map((child) => new Promise<void>((resolve) => { child.on('close', () => resolve()); }));
    for (const child of children) child.kill('SIGTERM');
    record.master.kill('SIGTERM');
    const kill = setTimeout(() => { for (const child of [...children, record.master]) child.kill('SIGKILL'); }, 1_000);
    kill.unref();
    await Promise.all([record.masterDone, ...pending]);
    clearTimeout(kill);
    this.manager.sshAuth.delete(record.parsed);
    await fsp.rm(record.directory, { recursive: true, force: true });
    this.openSessions.delete(record);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Open attempts own their temporary authentication files and partial master
    // until cleanup finishes. Fence registration and drain them during shutdown.
    for (const master of this.openingMasters) master.kill('SIGTERM');
    await Promise.all([
      Promise.allSettled([...this.opening]),
      ...[...this.openSessions].map((record) => this.closeSession(record.handle)),
    ]);
  }
}

function validateQuery(query: DeploymentSshInspectQuery): DeploymentSshInspectQuery {
  const paths = [...query.files, ...(query.ownershipPath ? [query.ownershipPath] : [])];
  if (query.ports.length > 256 || query.files.length > 256 || query.services.length > 128
    || query.ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)
    || paths.some((file) => !file.startsWith('/') || Array.from(file).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || file.split('/').includes('..'))
    || query.services.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(name))) throw new DeploymentSshError('invalid_inspection');
  return { ports: [...new Set(query.ports)], files: [...new Set(query.files)], services: [...new Set(query.services)], ...(query.ownershipPath ? { ownershipPath: query.ownershipPath } : {}) };
}

function validInspection(value: unknown): value is Omit<DeploymentSshInspection, 'target'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const platform = data.platform as Record<string, unknown> | null;
  const ownership = data.ownership as Record<string, unknown> | null;
  return Boolean(platform && typeof platform.id === 'string' && typeof platform.version === 'string' && typeof platform.kernel === 'string'
    && typeof platform.systemd === 'boolean' && (platform.systemdVersion === undefined || (Number.isSafeInteger(platform.systemdVersion) && Number(platform.systemdVersion) > 0)) && typeof data.privileged === 'boolean' && typeof data.inventoryComplete === 'boolean'
    && data.prerequisites && typeof data.prerequisites === 'object' && !Array.isArray(data.prerequisites)
    && Object.values(data.prerequisites).every((item) => typeof item === 'boolean')
    && Array.isArray(data.files) && data.files.every((file) => file && typeof file.path === 'string' && ['file', 'symlink', 'directory', 'missing', 'other'].includes(file.kind)
      && (file.sha256 === undefined || /^[a-f0-9]{64}$/.test(file.sha256)) && (file.trustedParent === undefined || typeof file.trustedParent === 'boolean'))
    && Array.isArray(data.listeners) && data.listeners.every((item) => item && typeof item.address === 'string' && Number.isSafeInteger(item.port) && item.port > 0 && item.port <= 65535 && ['tcp', 'udp'].includes(item.protocol))
    && Array.isArray(data.services) && data.services.every((item) => item && typeof item.name === 'string' && typeof item.loadState === 'string' && typeof item.activeState === 'string' && typeof item.fragmentPath === 'string')
    && ownership && ['missing', 'untrusted', 'present'].includes(String(ownership.status)));
}

/** Fixed, read-only probe; /etc/os-release is parsed as data, never sourced. */
function inspectionScript(query: DeploymentSshInspectQuery): string {
  const encoded = Buffer.from(JSON.stringify(query)).toString('base64');
  return `set -eu
command -v python3 >/dev/null 2>&1 || exit 127
exec python3 - <<'VARIN_DEPLOYMENT_INSPECTION'
import base64, hashlib, json, os, platform, re, shutil, stat, subprocess
q = json.loads(base64.b64decode('${encoded}'))
out = {'platform': {'id': '', 'version': '', 'kernel': platform.system(), 'systemd': os.path.isdir('/run/systemd/system')}, 'privileged': os.geteuid() == 0, 'inventoryComplete': True, 'prerequisites': {}, 'files': [], 'listeners': [], 'services': [], 'ownership': {'status': 'missing'}}
try:
    with open('/etc/os-release', encoding='utf8') as f:
        for line in f:
            key, sep, value = line.strip().partition('=')
            if sep and key in ('ID', 'VERSION_ID'):
                out['platform']['id' if key == 'ID' else 'version'] = value.strip('"').strip("'")
except OSError:
    out['inventoryComplete'] = False
for command in ('python3', 'systemctl', 'ss', 'sha256sum', 'curl', 'tar', 'install', 'flock', 'caddy', 'nginx', 'frps'):
    out['prerequisites'][command] = shutil.which(command) is not None
def trusted_path(name):
    current = name
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: return False
        if current == '/': return True
        current = os.path.dirname(current)
try:
    result = subprocess.run(['systemctl', '--version'], capture_output=True, text=True, timeout=10, check=True)
    match = re.match(r'systemd ([0-9]+)', result.stdout)
    if match: out['platform']['systemdVersion'] = int(match.group(1))
    else: out['inventoryComplete'] = False
except (OSError, subprocess.SubprocessError): out['inventoryComplete'] = False
for name in q['files']:
    entry = {'path': name, 'kind': 'missing', 'trustedParent': False}
    try: entry['trustedParent'] = trusted_path(os.path.dirname(name))
    except OSError: pass
    try:
        info = os.lstat(name)
        entry.update(uid=info.st_uid, gid=info.st_gid)
        entry['kind'] = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
        if entry['kind'] == 'file':
            with open(name, 'rb') as f:
                h = hashlib.sha256()
                for block in iter(lambda: f.read(65536), b''): h.update(block)
                entry['sha256'] = h.hexdigest()
    except FileNotFoundError: pass
    except OSError: out['inventoryComplete'] = False
    out['files'].append(entry)
try:
    result = subprocess.run(['ss', '-H', '-lntu'], capture_output=True, text=True, timeout=10, check=True)
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] not in ('tcp', 'udp'): raise ValueError('unrecognized socket inventory')
        address, _, port = parts[4].rpartition(':')
        if not port.isdigit(): raise ValueError('unrecognized listener port')
        if int(port) in q['ports']:
            out['listeners'].append({'address': address.strip('[]'), 'port': int(port), 'protocol': parts[0]})
except (OSError, ValueError, subprocess.SubprocessError): out['inventoryComplete'] = False
for name in q['services']:
    try:
        result = subprocess.run(['systemctl', 'show', '--no-pager', '--property=LoadState,ActiveState,FragmentPath', '--', name], capture_output=True, text=True, timeout=10, check=True)
        props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if not all(key in props for key in ('LoadState', 'ActiveState', 'FragmentPath')): raise ValueError('incomplete unit inventory')
        out['services'].append({'name': name, 'loadState': props['LoadState'], 'activeState': props['ActiveState'], 'fragmentPath': props['FragmentPath']})
    except (OSError, ValueError, subprocess.SubprocessError): out['inventoryComplete'] = False
marker = q.get('ownershipPath')
if marker:
    try:
        # Each parent and the manifest itself must be root-owned, non-symlink,
        # non-group/world-writable. A matching filename alone is never ownership.
        if not trusted_path(marker): raise ValueError('untrusted ownership path')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(marker, flags)
        with os.fdopen(fd, 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 262144: raise ValueError('untrusted ownership record')
            manifest = json.load(f)
        out['ownership'] = {'status': 'present', 'manifest': manifest}
    except FileNotFoundError: pass
    except (OSError, ValueError): out['ownership'] = {'status': 'untrusted'}
print(json.dumps(out, separators=(',', ':')))
VARIN_DEPLOYMENT_INSPECTION
`;
}
