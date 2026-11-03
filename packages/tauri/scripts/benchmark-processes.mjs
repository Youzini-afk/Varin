/** Read-only OS counters for the observed desktop tree. This does not certify
 * product A/B results or attribute external services by guessing process names.
 * No command lines, environments, credentials, sockets or elevated APIs are read.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, readlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const validPid = value => natural(value) && value > 0;
const issue = (scope, code, fields = {}) => ({ scope, code, ...fields });
const errorCode = error => /^[A-Z_0-9]+$/u.test(String(error?.code)) ? String(error.code) : 'READ_FAILED';
const gone = error => ['ENOENT', 'ESRCH'].includes(error?.code);
const limits = [
  'Polling can miss processes that start and exit, or detach, between observations.',
  'External services launched by another OS owner require independent ownership evidence.',
  'OS process visibility restrictions can hide processes entirely; ancestry alone cannot establish their absence.',
  'Counters are read over a measured interval, not an atomic system-wide snapshot.',
  'CPU after the last observation of an exited process is not recoverable from these counters.',
];

async function mapBounded(values, fn) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index]); }
  }));
  return results;
}

/** /proc/PID/stat fields 14+15 are self CPU; child CPU must not be counted twice. */
export function parseLinuxStat(text, ticksPerSecond) {
  if (!natural(ticksPerSecond) || ticksPerSecond === 0) throw new Error('Invalid CLK_TCK');
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  const pid = Number(text.slice(0, left).trim());
  const fields = text.slice(right + 1).trim().split(/\s+/u);
  if (left < 1 || right < left || fields.length < 20 || !validPid(pid)
    || !/^\d+$/u.test(fields[19]) || !natural(Number(fields[1]))
    || !/^\d+$/u.test(fields[11]) || !/^\d+$/u.test(fields[12])) throw new Error('Malformed process stat');
  const cpuTicks = BigInt(fields[11]) + BigInt(fields[12]);
  const cpuTimeMs = Number(cpuTicks) * 1000 / ticksPerSecond;
  if (!Number.isFinite(cpuTimeMs) || cpuTimeMs < 0) throw new Error('Invalid CPU counter');
  return { pid, parentPid: Number(fields[1]), startIdentity: `linux:${fields[19]}`,
    startOrder: fields[19], state: fields[0] === 'Z' ? 'zombie' : 'running', cpuTimeMs };
}

export function parseLinuxPss(text) {
  const values = [...text.matchAll(/^Pss:\s+(\d+)\s+kB\s*$/gmu)];
  if (!values.length) throw new Error('PSS is unavailable');
  const bytes = Number(values.reduce((sum, match) => sum + BigInt(match[1]) * 1024n, 0n));
  if (!natural(bytes)) throw new Error('Invalid PSS counter');
  return bytes;
}

const drmBytes = value => {
  const match = /^(\d+)(?:\s+(KiB|MiB))?$/u.exec(value);
  if (!match) return null;
  const bytes = Number(BigInt(match[1]) * ({ KiB: 1024n, MiB: 1048576n }[match[2]] ?? 1n));
  return natural(bytes) ? bytes : null;
};

/** Kernel DRM fdinfo spec: device + client-id identifies duplicated/shared FDs.
 * No pdev means the driver's client IDs must be globally unique. Memory regions
 * are disjoint, but buffers shared between clients cannot be deduplicated here.
 * https://www.kernel.org/doc/html/latest/gpu/drm-usage-stats.html
 */
export function parseDrmFdinfo(text) {
  const fields = new Map(text.split('\n').flatMap(line => {
    const index = line.indexOf(':');
    return index < 0 ? [] : [[line.slice(0, index).trim(), line.slice(index + 1).trim()]];
  }));
  if (![...fields.keys()].some(key => key.startsWith('drm-'))) return null;
  const driver = fields.get('drm-driver') ?? null;
  const clientId = /^\d+$/u.test(fields.get('drm-client-id') ?? '') ? fields.get('drm-client-id') : null;
  const device = fields.get('drm-pdev') ?? 'global-client-id';
  const regions = Object.create(null);
  let invalid = !driver || !clientId;
  for (const [key, value] of fields) {
    const match = /^drm-(total|shared|resident|memory)-(.+)$/u.exec(key);
    if (!match) continue;
    const kind = match[1] === 'memory' ? 'resident' : match[1];
    // amdgpu's deprecated drm-memory is an alias, not another allocation.
    if (match[1] === 'memory' && fields.has(`drm-resident-${match[2]}`)) continue;
    const bytes = drmBytes(value);
    if (bytes === null) invalid = true;
    (regions[match[2]] ??= {})[`${kind}Bytes`] = bytes;
  }
  return { driver, device, clientId, key: driver && clientId ? `${driver}:${device}:${clientId}` : null, regions, invalid };
}

export function summarizeDrmClients(observations, { complete = true } = {}) {
  const clients = new Map(), issues = [];
  let exact = complete;
  for (const observation of observations) {
    if (!observation.key || observation.invalid) { exact = false; issues.push(issue('gpu', 'invalid-drm-client-counters')); }
    const key = observation.key ?? `unidentified:${clients.size}`;
    const existing = clients.get(key);
    if (existing) {
      if (!existing.pids.includes(observation.pid)) existing.pids.push(observation.pid);
      existing.observedDescriptors++;
      continue;
    }
    clients.set(key, { driver: observation.driver, device: observation.device, clientId: observation.clientId,
      regions: observation.regions, pids: observation.pid ? [observation.pid] : [], observedDescriptors: 1 });
  }
  if (!clients.size) { exact = false; issues.push(issue('gpu', 'gpu-memory-unavailable')); }
  let residentBytes = 0;
  for (const client of clients.values()) {
    const regions = Object.values(client.regions);
    if (!regions.length || regions.some(region => !natural(region.residentBytes))) {
      exact = false; issues.push(issue('gpu', 'resident-memory-unavailable'));
    }
    if (regions.some(region => !natural(region.sharedBytes))) {
      exact = false; issues.push(issue('gpu', 'cross-client-sharing-unknown'));
    } else if (regions.some(region => region.sharedBytes > 0)) {
      exact = false; issues.push(issue('gpu', 'shared-buffers-cannot-be-deduplicated'));
    }
    for (const region of regions) if (natural(region.residentBytes)) residentBytes += region.residentBytes;
  }
  if (!natural(residentBytes)) { exact = false; issues.push(issue('gpu', 'gpu-counter-overflow')); }
  return { gpuBytes: exact ? residentBytes : null,
    gpu: { source: 'linux-drm-fdinfo', metric: 'resident-buffer-bytes', complete: exact,
      accounting: 'Deduplicate device/client IDs. Sum resident regions only when all observed shared counters are zero. Shared or absent counters leave the total unknown.',
      clients: [...clients.values()] }, issues };
}

function earlierOrEqual(parent, child) {
  // Every native backend supplies an integer OS creation counter, not rounded JS dates.
  try { return BigInt(parent.startOrder) <= BigInt(child.startOrder); } catch { return false; }
}

/** Identity, not PID, survives reparenting. Reused parents cannot adopt older
 * children (Windows retains the original parent PID after its termination). */
export class ProcessTreeTracker {
  constructor(rootPid, rootStartIdentity) {
    if (!validPid(rootPid) || typeof rootStartIdentity !== 'string' || !rootStartIdentity) throw new Error('Invalid root identity');
    this.rootPid = rootPid; this.rootStartIdentity = rootStartIdentity;
    this.observed = new Map([[rootPid, rootStartIdentity]]);
    this.identities = new Set([`${rootPid}:${rootStartIdentity}`]);
  }
  select(table) {
    const rows = new Map(table.map(row => [row.pid, row]));
    const selected = new Map();
    const reused = [];
    for (const [pid, identity] of this.observed) {
      const row = rows.get(pid);
      if (row?.startIdentity === identity) selected.set(pid, row);
      else if (row) reused.push(pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table) {
        const parent = selected.get(row.parentPid);
        if (!selected.has(row.pid) && row.pid !== this.rootPid && parent && earlierOrEqual(parent, row)) {
          selected.set(row.pid, row); this.observed.set(row.pid, row.startIdentity);
          this.identities.add(`${row.pid}:${row.startIdentity}`); changed = true;
        }
      }
    }
    const root = rows.get(this.rootPid);
    return { processes: [...selected.values()].sort((a, b) => a.pid - b.pid), reused,
      rootState: !root ? 'exited' : root.startIdentity !== this.rootStartIdentity ? 'reused' : root.state === 'zombie' ? 'exited' : 'running' };
  }
}

async function linuxDriver({ procRoot = '/proc', ticksPerSecond } = {}) {
  if (ticksPerSecond === undefined) {
    const { stdout } = await execute('getconf', ['CLK_TCK'], { timeout: 10000, encoding: 'utf8' });
    ticksPerSecond = Number(stdout.trim());
  }
  if (!natural(ticksPerSecond) || !ticksPerSecond) throw new Error('Cannot determine OS CLK_TCK');
  const stat = async pid => parseLinuxStat(await readFile(join(procRoot, String(pid), 'stat'), 'utf8'), ticksPerSecond);
  return {
    memoryMetric: 'proportional-set-bytes', metadata: { clockTicksPerSecond: ticksPerSecond },
    async readTable() {
      const issues = [], unreadablePids = [], reusedPids = [];
      const names = (await readdir(procRoot)).filter(name => /^\d+$/u.test(name));
      const processes = (await mapBounded(names, async name => {
        try { return await stat(Number(name)); } catch (error) {
          if (!gone(error)) { unreadablePids.push(Number(name)); issues.push(issue('process-table', 'process-identity-unavailable', { pid: Number(name), error: errorCode(error) })); }
          return null;
        }
      })).filter(Boolean);
      // The first pass finishes for the entire table before validating any
      // parent. A parent PID reused while enumeration was in flight cannot
      // adopt an unrelated child first seen later in that enumeration.
      const stable = (await mapBounded(processes, async row => {
        try {
          const after = await stat(row.pid);
          if (after.startIdentity === row.startIdentity) return row;
          reusedPids.push(row.pid);
          issues.push(issue('process-table', 'identity-changed-during-enumeration', { pid: row.pid }));
        } catch (error) {
          if (!gone(error)) { unreadablePids.push(row.pid); issues.push(issue('process-table', 'process-identity-unavailable', { pid: row.pid, error: errorCode(error) })); }
        }
        return null;
      })).filter(Boolean);
      return { processes: stable, issues, unreadablePids, reusedPids };
    },
    async readCounters(row) {
      const issues = [], drm = [];
      let memoryBytes = null, handles = null, gpuReadable = true;
      const directory = join(procRoot, String(row.pid));
      if (row.state === 'zombie') return { ...row, memoryBytes: null, handles: null, issues: [], drm, gpuReadable: true };
      try {
        let text;
        try { text = await readFile(join(directory, 'smaps_rollup'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; text = await readFile(join(directory, 'smaps'), 'utf8'); }
        memoryBytes = parseLinuxPss(text);
      } catch (error) { issues.push(issue('process', 'memory-unavailable', { pid: row.pid, metric: 'proportional-set-bytes', error: errorCode(error) })); }
      try { handles = (await readdir(join(directory, 'fd'))).filter(name => /^\d+$/u.test(name)).length; }
      catch (error) { issues.push(issue('process', 'handles-unavailable', { pid: row.pid, error: errorCode(error) })); }
      try {
        const fds = (await readdir(join(directory, 'fdinfo'))).filter(name => /^\d+$/u.test(name));
        await mapBounded(fds, async fd => {
          try {
            const record = parseDrmFdinfo(await readFile(join(directory, 'fdinfo', fd), 'utf8'));
            if (record) drm.push({ ...record, pid: row.pid });
            else {
              // A GPU FD whose driver exports no counters must not disappear
              // behind a different GPU's successfully observed DRM clients.
              let target;
              try { target = await readlink(join(directory, 'fd', fd)); }
              catch (error) { if (error.code !== 'EINVAL') throw error; }
              if (/^\/dev\/(?:dri\/(?:card\d+|renderD\d+)|nvidia(?:\d+|-uvm|-modeset|-caps\/nvidia-cap\d+))$/u.test(target ?? '')) {
                gpuReadable = false; issues.push(issue('gpu', 'gpu-device-counters-unavailable', { pid: row.pid }));
              }
            }
          }
          catch (error) { gpuReadable = false; issues.push(issue('gpu', 'fdinfo-unavailable', { pid: row.pid, error: errorCode(error) })); }
        });
      } catch (error) { gpuReadable = false; issues.push(issue('gpu', 'fdinfo-unavailable', { pid: row.pid, error: errorCode(error) })); }
      // Refuse counters sampled across PID reuse or exit, rather than attach them
      // to the previous identity. No reread of denied memory is attempted.
      try {
        const after = await stat(row.pid);
        if (after.startIdentity !== row.startIdentity) throw Object.assign(new Error('PID changed'), { code: 'PID_REUSED' });
        return { ...after, memoryBytes, handles, issues, drm, gpuReadable };
      } catch (error) {
        return { ...row, state: gone(error) ? 'exited' : error.code === 'PID_REUSED' ? 'reused' : 'unknown', cpuTimeMs: null, memoryBytes: null, handles: null, drm: [], gpuReadable: false,
          issues: [...issues, issue('process', gone(error) ? 'process-exited-during-sample' : 'identity-changed-or-unavailable', { pid: row.pid, error: errorCode(error) })] };
      }
    },
    gpu(records) { return summarizeDrmClients(records.flatMap(row => row.drm), { complete: records.every(row => row.gpuReadable) }); },
    async close() {},
  };
}

// Request only process identity from CIM. .NET exposes unambiguous private
// bytes, cumulative CPU and handles, with another creation check before use.
// No Win32_Process CommandLine, ExecutablePath, owner, or environment is queried.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Identity($date) { if ($null -eq $date) { return $null }; return $date.ToUniversalTime().ToString('yyyyMMddHHmmssffffff', [System.Globalization.CultureInfo]::InvariantCulture) }
$table = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
$rows = @($table | ForEach-Object {
  $id = Identity $_.CreationDate
  $row = [ordered]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startOrder=$id;startIdentity=$null;state='running';cpuTimeMs=$null;memoryBytes=$null;handles=$null;counterError=$null;identityVerified=$false}
  if ($null -ne $id) { $row.startIdentity = 'win32:' + $id }
  $p = $null
  try {
    $p = Get-Process -Id $_.ProcessId -ErrorAction Stop
    $actual = Identity $p.StartTime
    if ($null -eq $id -or $actual -ne $id) { throw 'IDENTITY_UNAVAILABLE' }
    $p.Refresh()
    try { $row.cpuTimeMs = $p.TotalProcessorTime.TotalMilliseconds } catch { $row.counterError='CPU_UNAVAILABLE' }
    try { $row.memoryBytes = $p.PrivateMemorySize64 } catch { $row.counterError='MEMORY_UNAVAILABLE' }
    try { $row.handles = $p.HandleCount } catch { $row.counterError='HANDLES_UNAVAILABLE' }
    if ((Identity $p.StartTime) -ne $id -or $p.HasExited) { throw 'IDENTITY_CHANGED' }
    $row.identityVerified = $true
  } catch { $row.cpuTimeMs=$null; $row.memoryBytes=$null; $row.handles=$null; $row.counterError='COUNTERS_OR_IDENTITY_UNAVAILABLE' }
  finally { if ($null -ne $p) { $p.Dispose() } }
  [pscustomobject]$row
})
ConvertTo-Json -InputObject $rows -Depth 4 -Compress
`;

export function parseNativeProcessTable(text, platform) {
  const raw = JSON.parse(text.replace(/^\uFEFF/u, ''));
  const rows = Array.isArray(raw) ? raw : raw.processes;
  if (!Array.isArray(rows)) throw new Error('Native process table is malformed');
  const processes = [], issues = [], unreadablePids = [], unresolved = [], ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Native process entry is malformed');
    if (ids.has(row.pid)) throw new Error('Duplicate native process PID');
    ids.add(row.pid);
    if (row.pid === 0) continue;
    if (row.identityVerified === false || !validPid(row.pid) || !natural(row.parentPid) || typeof row.startIdentity !== 'string'
      || !row.startIdentity.startsWith(`${platform}:`) || !/^\d+$/u.test(row.startOrder ?? '')) {
      if (validPid(row.pid)) unreadablePids.push(row.pid);
      if (validPid(row.pid) && natural(row.parentPid)) unresolved.push({ pid: row.pid, parentPid: row.parentPid });
      else issues.push(issue('process-table', 'process-identity-unavailable', validPid(row.pid) ? { pid: row.pid } : {}));
      continue;
    }
    const counterIssues = [];
    for (const key of ['memoryBytes', 'handles', 'cpuTimeMs']) {
      if (key === 'cpuTimeMs' ? !(typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) : !natural(row[key])) {
        row[key] = null; counterIssues.push(issue('process', `${key}-unavailable`, { pid: row.pid }));
      }
    }
    if (row.counterError) counterIssues.push(issue('process', 'native-counters-unavailable', { pid: row.pid }));
    // Never pass through unrecognized fields from a helper or CIM response.
    processes.push({ pid: row.pid, parentPid: row.parentPid, startIdentity: row.startIdentity,
      startOrder: row.startOrder, state: row.state === 'zombie' ? 'zombie' : 'running',
      cpuTimeMs: row.cpuTimeMs, memoryBytes: row.memoryBytes, handles: row.handles, issues: counterIssues });
  }
  if (raw.tableErrors) issues.push(issue('process-table', 'native-process-enumeration-incomplete', { count: raw.tableErrors }));
  return { processes, issues, unreadablePids, unresolved, ...(platform === 'darwin' && natural(raw.machTimebase?.numer) && raw.machTimebase.numer > 0 && natural(raw.machTimebase?.denom) && raw.machTimebase.denom > 0
    ? { machTimebase: { numer: raw.machTimebase.numer, denom: raw.machTimebase.denom } } : {}) };
}

function unavailableGpu(platform) {
  return { gpuBytes: null, gpu: { source: `${platform}-unavailable`, metric: null, complete: false, clients: [],
    accounting: 'No verified per-owned-tree GPU allocation deduplication is available. Per-process shared GPU counters are not summed.' },
  issues: [issue('gpu', 'gpu-accounting-unavailable')] };
}

async function nativeDriver(platform) {
  let directory;
  let command, args;
  if (platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')];
  } else {
    directory = await mkdtemp(join(tmpdir(), 'varin-process-counters-'));
    command = join(directory, 'benchmark-macos'); args = [];
    try {
      await execute('/usr/bin/cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./benchmark-macos.c', import.meta.url)), '-o', command, '-lproc'], { timeout: 60000 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(`Cannot compile macOS counter helper using the installed SDK (${errorCode(error)})`);
    }
  }
  const metadata = { cpuTimeSource: platform === 'win32' ? 'System.Diagnostics.Process.TotalProcessorTime' : 'proc_pid_rusage Mach absolute ticks converted with mach_timebase_info' };
  return { memoryMetric: platform === 'win32' ? 'private-bytes' : 'physical-footprint-bytes', metadata,
    async readTable() {
      const { stdout } = await execute(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const table = parseNativeProcessTable(stdout, platform);
      if (table.machTimebase) metadata.machTimebase = table.machTimebase;
      return table;
    },
    async readCounters(row) { return row; },
    gpu() { return unavailableGpu(platform); },
    async close() { if (directory) await rm(directory, { recursive: true, force: true }); },
  };
}

/** Prepare before launching a product, then await setRoot(child.pid). Sampling
 * starts only when called; callers own cadence and monotonic workload boundaries.
 * procRoot/ticksPerSecond support isolated proc fixtures, not product evidence.
 */
export async function createProcessCollector(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported collector platform: ${platform}`);
  if (platform !== process.platform && !(platform === 'linux' && options.procRoot && options.ticksPerSecond)) throw new Error('Native counters require the matching operating system');
  const driver = platform === 'linux' ? await linuxDriver(options) : await nativeDriver(platform);
  let tracker, closed = false, sampling = false, settingRoot = false;
  const collector = { platform, memoryMetric: driver.memoryMetric, metadata: driver.metadata,
    async setRoot(pid, startIdentity) {
      if (closed || sampling || settingRoot) throw new Error('Collector is closed or busy');
      if (tracker) throw new Error('Use a new collector for a different process tree');
      if (!validPid(pid)) throw new Error('Invalid root PID');
      settingRoot = true;
      try {
        const table = await driver.readTable();
        const root = table.processes.find(row => row.pid === pid);
        if (!root) throw new Error(table.unreadablePids.includes(pid) ? 'Root process identity is unavailable' : 'Root process has exited or was not found');
        if (startIdentity !== undefined && root.startIdentity !== startIdentity) throw new Error('Root process identity does not match');
        tracker = new ProcessTreeTracker(pid, root.startIdentity);
        tracker.select(table.processes); // Pin any descendants already present at launch registration.
        return root.startIdentity;
      } finally { settingRoot = false; }
    },
    async sample() {
      if (closed || !tracker || sampling) throw new Error('Collector is closed, has no root, or is already sampling');
      sampling = true;
      const monotonicMs = performance.now();
      const issues = [];
      let selected = { processes: [], rootState: 'unknown', reused: [] }, records = [], tableReadable = false;
      try {
        let table;
        try { table = await driver.readTable(); tableReadable = true; }
        catch (error) { issues.push(issue('process-table', 'process-table-unavailable', { error: errorCode(error) })); }
        if (table) {
          issues.push(...table.issues);
          selected = tracker.select(table.processes);
          if (table.unreadablePids.includes(tracker.rootPid)) selected.rootState = 'unknown';
          if (table.reusedPids?.includes(tracker.rootPid)) selected.rootState = 'reused';
          // Protected unrelated system processes need not disclose their counters.
          // Their CIM parent IDs still locate unresolved branches of OUR tree.
          const possibleOwned = new Set([...selected.processes.map(row => row.pid), ...tracker.observed.keys()]);
          const topology = [...table.processes, ...(table.unresolved ?? [])];
          let changed = true;
          while (changed) {
            changed = false;
            for (const row of topology) if (!possibleOwned.has(row.pid) && possibleOwned.has(row.parentPid)) { possibleOwned.add(row.pid); changed = true; }
          }
          for (const row of table.unresolved ?? []) if (possibleOwned.has(row.pid)) {
            issues.push(issue('process-table', 'owned-process-identity-unavailable', { pid: row.pid }));
          }
          for (const pid of selected.reused) issues.push(issue('ownership', 'observed-pid-reused', { pid }));
          records = await mapBounded(selected.processes, row => driver.readCounters(row));
          issues.push(...records.flatMap(row => row.issues ?? []));
        }
        const hasExited = row => ['zombie', 'exited'].includes(row.state);
        if (records.some(row => row.pid === tracker.rootPid && hasExited(row))) selected.rootState = 'exited';
        const rootRecord = records.find(row => row.pid === tracker.rootPid);
        if (rootRecord && ['reused', 'unknown'].includes(rootRecord.state)) selected.rootState = rootRecord.state;
        const living = records.filter(row => !hasExited(row) && row.state !== 'reused');
        const gpu = driver.gpu(living);
        issues.push(...gpu.issues);
        // An incomplete tree cannot have an exact whole-tree GPU total.
        if (!tableReadable || issues.some(item => item.scope === 'process-table')) { gpu.gpuBytes = null; gpu.gpu.complete = false; }
        const processes = living.map(row => ({ pid: row.pid, parentPid: row.parentPid,
          role: row.pid === tracker.rootPid ? 'shell' : 'descendant', startIdentity: row.startIdentity,
          state: row.state, cpuTimeMs: row.cpuTimeMs, memoryBytes: row.memoryBytes, handles: row.handles }));
        return { monotonicMs, sampleDurationMs: performance.now() - monotonicMs, processes,
          gpuBytes: gpu.gpuBytes, gpu: gpu.gpu,
          coverage: { complete: issues.length === 0, processCountersComplete: tableReadable && !issues.some(item => item.scope !== 'gpu'),
            rootState: selected.rootState, observedIdentities: tracker.identities.size,
            exitedProcesses: records.filter(hasExited).map(row => ({ pid: row.pid, startIdentity: row.startIdentity, cpuTimeMs: row.cpuTimeMs })),
            discovery: 'full-process-table-with-retained-observed-descendants', issues, limitations: [...limits] } };
      } finally { sampling = false; }
    },
    async close() { if (sampling || settingRoot) throw new Error('Wait for the active operation before closing'); if (!closed) { closed = true; await driver.close(); } },
  };
  if (options.rootPid !== undefined) {
    try { await collector.setRoot(options.rootPid, options.rootStartIdentity); }
    catch (error) { await collector.close(); throw error; }
  }
  return collector;
}
