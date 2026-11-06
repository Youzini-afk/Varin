/** OS facts for this Host, not a second execution or reservation owner. */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResourceMachineView, ResourcePressureView } from '@varin/protocol';

const MIB = 1024 * 1024;
type Read = (file: string) => string;
export interface LocalMachineProbe {
  cpuCores: number;
  memoryMb: number;
  usedMemoryMb?: number;
  memoryAvailableMb?: number;
  cpuPercent?: number;
  pidsLimit?: number;
  pidsCurrent?: number;
  pidsAvailable?: number;
  pressure?: ResourcePressureView;
  system?: NonNullable<ResourceMachineView['system']>;
}
interface Group { version: 1 | 2; controller: string; leaf: string; mount: string }
interface LinuxFacts {
  osAvailableBytes?: number;
  cpuCores?: number;
  memoryBytes?: number;
  memoryUsedBytes?: number;
  memoryAvailableBytes?: number;
  memoryHeadroomUnknown?: boolean;
  pidsLimit?: number;
  pidsCurrent?: number;
  pidsAvailable?: number;
  cpuUsageSeconds?: number;
  cpuUsageScope?: string;
  pressure?: ResourcePressureView;
  source: 'linux-cgroup-v1' | 'linux-cgroup-v2' | 'linux-cgroup-hybrid' | 'host-os';
  status: 'available' | 'partial' | 'unavailable';
  warnings: string[];
}
const decodeMount = (text: string): string => text.replace(/\\(040|011|012|134)/g, (_, value: string) => String.fromCharCode(Number.parseInt(value, 8)));
const safeAbsolute = (value: string): boolean => value.startsWith('/') && !value.split('/').includes('..');

/** Resolve both host-relative memberships and namespace-relative cgroup paths. Never walk outside a mounted hierarchy. */
function groups(membership: string, mountinfo: string): Group[] {
  const members = membership.trim().split('\n').flatMap(line => {
    const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
    return match && safeAbsolute(match[2]!) ? [{ controllers: match[1]!.split(','), directory: match[2]! }] : [];
  });
  const result: Group[] = [];
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    const fields = left?.split(' '), options = right?.split(' ');
    if (!fields || fields.length < 6 || !options || options.length < 3 || !['cgroup', 'cgroup2'].includes(options[0]!)) continue;
    const rawRoot = decodeMount(fields[3]!), rawMount = decodeMount(fields[4]!);
    if (!safeAbsolute(rawRoot) || !safeAbsolute(rawMount)) continue;
    const root = path.posix.normalize(rawRoot).replace(/\/$/, '') || '/';
    const mount = path.posix.normalize(rawMount).replace(/\/$/, '') || '/';
    const version = options[0] === 'cgroup2' ? 2 : 1;
    const controllers = version === 2 ? ['cpu', 'cpuset', 'memory', 'pids'] : options[2]!.split(',').filter(c => ['cpu', 'cpuacct', 'cpuset', 'memory', 'pids'].includes(c));
    for (const controller of controllers) {
      const member = members.find(m => version === 2 ? m.controllers[0] === '' : m.controllers.includes(controller));
      if (!member) continue;
      const relative = member.directory === root ? '' : member.directory.startsWith(`${root}/`)
        ? member.directory.slice(root.length) : member.directory;
      result.push({ version, controller, leaf: path.posix.join(mount, relative), mount });
    }
  }
  // Bind mounts can expose the same hierarchy twice. Prefer the view with the most visible ancestors.
  return result.filter(group => !result.some(other => other !== group && other.version === group.version
    && other.controller === group.controller && other.leaf.slice(other.mount.length).split('/').length > group.leaf.slice(group.mount.length).split('/').length));
}
function ancestors(group: Group): string[] {
  const result: string[] = [];
  for (let current = group.leaf; ; current = path.posix.dirname(current)) {
    result.push(current);
    if (current === group.mount) return result;
  }
}
type Range = [number, number];
function cpuSet(text: string): Range[] {
  if (!text.trim()) return [];
  const ranges: Range[] = text.trim().split(',').map(part => {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error('invalid CPU set');
    const [start, end = start] = part.split('-').map(Number) as [number, number?];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) throw new Error('invalid CPU set');
    return [start, end];
  });
  return ranges.sort((a, b) => a[0] - b[0]).reduce<Range[]>((merged, entry) => {
    const last = merged.at(-1);
    if (last && entry[0] <= last[1] + 1) last[1] = Math.max(last[1], entry[1]);
    else merged.push(entry);
    return merged;
  }, []);
}
function intersect(left: Range[], right: Range[]): Range[] {
  return left.flatMap(a => right.flatMap(b => Math.max(a[0], b[0]) <= Math.min(a[1], b[1])
    ? [[Math.max(a[0], b[0]), Math.min(a[1], b[1])] as Range] : []));
}
function unsigned(text: string): number {
  if (!/^\d+$/.test(text.trim())) throw new Error('invalid nonnegative integer');
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid nonnegative integer');
  return value;
}
function limit(text: string, v1Memory = false, negativeUnlimited = false): number | undefined {
  if (text.trim() === 'max' || ((v1Memory || negativeUnlimited) && text.trim() === '-1')) return undefined;
  if (v1Memory && /^\d+$/.test(text.trim()) && BigInt(text.trim()) >= 9223372036854771712n) return undefined;
  return unsigned(text);
}
const minimum = (left: number | undefined, right: number): number => left === undefined ? right : Math.min(left, right);

/** Pure filesystem probe; fixtures test parsing, not real container enforcement. */
export function probeLinuxResources(read: Read = file => readFileSync(file, 'utf8')): LinuxFacts {
  const facts: LinuxFacts = { source: 'host-os', status: 'unavailable', warnings: [] };
  const warning = (message: string) => { if (!facts.warnings.includes(message)) facts.warnings.push(message); };
  const optional = (file: string): string | undefined => {
    try { return read(file).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warning(`${file}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`);
        if (/\/memory\.(?:max|limit_in_bytes)$/.test(file)) facts.memoryHeadroomUnknown = true;
      }
      return undefined;
    }
  };
  const parse = <T>(file: string, parser: (text: string) => T): T | undefined => {
    const text = optional(file);
    if (text === undefined) return undefined;
    try { return parser(text); } catch { warning(`${file}: malformed`); return undefined; }
  };
  const meminfo = optional('/proc/meminfo');
  const available = meminfo && /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
  if (available) facts.osAvailableBytes = unsigned(available) * 1024;
  const membership = optional('/proc/self/cgroup'), mounts = optional('/proc/self/mountinfo');
  if (membership === undefined || mounts === undefined) { warning('cgroup membership or mount information unavailable'); return facts; }
  const resolved = groups(membership, mounts);
  if (!resolved.length) { warning('no accessible cgroup hierarchy; using OS capacity'); return facts; }
  const versions = new Set(resolved.map(group => group.version));
  facts.source = versions.size > 1 ? 'linux-cgroup-hybrid' : versions.has(2) ? 'linux-cgroup-v2' : 'linux-cgroup-v1';
  // Affinity is a set, so intersection with cpusets must preserve identities rather than taking counts alone.
  let allowed: Range[] | undefined;
  const status = optional('/proc/self/status');
  const affinity = status && /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1];
  if (affinity) { try { allowed = cpuSet(affinity); } catch { warning('CPU affinity is malformed'); } }
  const seen = new Set<string>();
  for (const group of resolved) {
    for (const directory of ancestors(group)) {
      const leaf = directory === group.leaf;
      if (group.controller === 'cpu') {
        const quotaFile = `${directory}/${group.version === 2 ? 'cpu.max' : 'cpu.cfs_quota_us'}`;
        const quotaText = optional(quotaFile);
        if (quotaText !== undefined) {
          seen.add('cpu');
          try {
            const parts = quotaText.split(/\s+/);
            if (group.version === 2 && parts.length !== 2) throw new Error('invalid quota');
            const quota = limit(parts[0]!, false, group.version === 1);
            const period = group.version === 2 ? unsigned(parts[1]!) : parse(`${directory}/cpu.cfs_period_us`, unsigned);
            if (!period) throw new Error('invalid period');
            if (quota !== undefined) {
              if (quota <= 0) throw new Error('invalid quota');
              facts.cpuCores = minimum(facts.cpuCores, quota / period);
            }
          } catch { warning(`${quotaFile}: malformed`); }
        }
        if (leaf) {
          const stat = optional(`${directory}/cpu.stat`);
          const counter = (name: string) => {
            const value = stat && new RegExp(`^${name}\\s+(\\d+)$`, 'm').exec(stat)?.[1];
            return value === undefined || value === '' ? undefined : unsigned(value);
          };
          const usage = group.version === 2 ? counter('usage_usec') : undefined;
          if (usage !== undefined) { facts.cpuUsageSeconds = usage / 1e6; facts.cpuUsageScope = directory; }
          const throttled = counter(group.version === 2 ? 'throttled_usec' : 'throttled_time');
          const events = counter('nr_throttled');
          if (throttled !== undefined || events !== undefined) facts.pressure = { ...facts.pressure, cpu: {
            scope: directory,
            ...(throttled === undefined ? {} : { throttledSeconds: throttled / (group.version === 2 ? 1e6 : 1e9) }),
            ...(events === undefined ? {} : { throttleEvents: events }),
          } };
        }
      } else if (group.controller === 'cpuacct' && leaf) {
        const usage = parse(`${directory}/cpuacct.usage`, unsigned);
        if (usage !== undefined) { facts.cpuUsageSeconds = usage / 1e9; facts.cpuUsageScope = directory; }
      } else if (group.controller === 'cpuset') {
        const setFile = `${directory}/${group.version === 2 ? 'cpuset.cpus.effective' : 'cpuset.effective_cpus'}`;
        const effective = optional(setFile);
        const text = effective ?? optional(`${directory}/cpuset.cpus`);
        // An empty configured set inherits its parent's set; an observed empty effective set is zero.
        if (text !== undefined && (effective !== undefined || text !== '')) {
          try { const set = cpuSet(text); allowed = allowed ? intersect(allowed, set) : set; }
          catch { warning(`${setFile}: malformed`); }
        }
      } else if (group.controller === 'memory' || group.controller === 'pids') {
        const memory = group.controller === 'memory';
        if (memory && leaf) {
          const events = optional(`${directory}/${group.version === 2 ? 'memory.events' : 'memory.oom_control'}`);
          const counter = (name: string) => {
            const value = events && new RegExp(`^${name}\\s+(\\d+)$`, 'm').exec(events)?.[1];
            return value === undefined || value === '' ? undefined : unsigned(value);
          };
          const oom = group.version === 2 ? counter('oom') : undefined;
          const kills = counter('oom_kill');
          const hits = group.version === 2 ? counter('max') : parse(`${directory}/memory.failcnt`, unsigned);
          if (oom !== undefined || kills !== undefined || hits !== undefined) facts.pressure = { ...facts.pressure, memory: {
            scope: directory,
            ...(oom === undefined ? {} : { oomEvents: oom }),
            ...(kills === undefined ? {} : { oomKills: kills }),
            ...(hits === undefined ? {} : { limitEvents: hits }),
          } };
        }
        // v1 ancestors only account for descendants when hierarchical memory accounting is enabled.
        if (memory && group.version === 1 && !leaf) {
          const hierarchy = optional(`${directory}/memory.use_hierarchy`);
          if (hierarchy !== '1') { if (hierarchy !== '0') warning(`${directory}/memory.use_hierarchy: unavailable`); continue; }
        }
        const limitFile = `${directory}/${memory ? (group.version === 2 ? 'memory.max' : 'memory.limit_in_bytes') : 'pids.max'}`;
        const currentFile = `${directory}/${memory ? (group.version === 2 ? 'memory.current' : 'memory.usage_in_bytes') : 'pids.current'}`;
        const used = parse(currentFile, unsigned);
        if (leaf && used !== undefined) {
          if (memory) facts.memoryUsedBytes = used; else facts.pidsCurrent = used;
        }
        const limitText = optional(limitFile);
        if (limitText === undefined) continue;
        seen.add(group.controller);
        let maximum: number | undefined;
        try { maximum = limit(limitText, memory && group.version === 1); }
        catch { warning(`${limitFile}: malformed`); if (memory) facts.memoryHeadroomUnknown = true; continue; }
        if (maximum !== undefined) {
          if (memory) facts.memoryBytes = minimum(facts.memoryBytes, maximum); else facts.pidsLimit = minimum(facts.pidsLimit, maximum);
          if (used === undefined) {
            warning(`${currentFile}: usage unavailable for limited hierarchy`);
            if (memory) facts.memoryHeadroomUnknown = true;
          }
          else if (memory) facts.memoryAvailableBytes = minimum(facts.memoryAvailableBytes, Math.max(0, maximum - used));
          else facts.pidsAvailable = minimum(facts.pidsAvailable, Math.max(0, maximum - used));
        }
      }
    }
  }
  if (allowed) facts.cpuCores = minimum(facts.cpuCores, allowed.reduce((sum, [start, end]) => sum + end - start + 1, 0));
  if (!seen.has('cpu')) warning('CPU controller limit unavailable; using affinity/OS capacity');
  if (!seen.has('memory')) warning('memory controller limit unavailable; using OS capacity');
  if (!seen.has('pids')) warning('PID controller limit unavailable');
  facts.status = facts.warnings.length ? 'partial' : 'available';
  return facts;
}

export function createDefaultResourceProbe(): () => LocalMachineProbe {
  let previous: { total: number; idle: number; timestamp: number; cgroupUsage: number | undefined; scope: string | undefined; cores: number } | undefined;
  return () => {
    const cpuSnapshots = os.cpus();
    const physicalCores = cpuSnapshots.length || os.availableParallelism();
    const physicalMemory = os.totalmem();
    const linux = process.platform === 'linux' ? probeLinuxResources() : undefined;
    const cores = Math.min(physicalCores, ...(linux ? [os.availableParallelism(), linux.cpuCores ?? Infinity] : []));
    const memory = Math.min(physicalMemory, linux?.memoryBytes ?? Infinity);
    const totals = cpuSnapshots.reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle, 0);
    const idle = cpuSnapshots.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const timestamp = performance.now();
    let cpuPercent: number | undefined;
    if (linux && linux.source !== 'host-os') {
      if (linux.cpuUsageSeconds !== undefined && previous?.cgroupUsage !== undefined && previous.scope === linux.cpuUsageScope
        && previous.cores === cores && cores > 0 && timestamp > previous.timestamp && linux.cpuUsageSeconds >= previous.cgroupUsage) {
        cpuPercent = (linux.cpuUsageSeconds - previous.cgroupUsage) / ((timestamp - previous.timestamp) / 1000) / cores * 100;
      }
    } else if (previous && totals > previous.total && idle >= previous.idle) cpuPercent = (1 - (idle - previous.idle) / (totals - previous.total)) * 100;
    previous = { total: totals, idle, timestamp, cgroupUsage: linux?.cpuUsageSeconds, scope: linux?.cpuUsageScope, cores };
    const used = linux?.source !== undefined && linux.source !== 'host-os' ? linux.memoryUsedBytes : physicalMemory - os.freemem();
    // A missing limited ancestor's usage cannot establish free capacity. Do not substitute host free RAM.
    const headroomUnknown = linux?.memoryHeadroomUnknown;
    const available = headroomUnknown ? undefined : Math.min(linux?.osAvailableBytes ?? os.freemem(), linux?.memoryAvailableBytes ?? Infinity, memory);
    return {
      cpuCores: cores, memoryMb: linux ? memory / MIB : Math.round(memory / MIB),
      ...(used === undefined ? {} : { usedMemoryMb: linux ? used / MIB : Math.round(used / MIB) }),
      ...(available === undefined || !linux ? {} : { memoryAvailableMb: available / MIB }),
      ...(cpuPercent === undefined ? {} : { cpuPercent: Math.min(100, Math.max(0, linux ? cpuPercent : Math.round(cpuPercent))) }),
      ...(linux?.pidsLimit === undefined ? {} : { pidsLimit: linux.pidsLimit }),
      ...(linux?.pidsCurrent === undefined ? {} : { pidsCurrent: linux.pidsCurrent }),
      ...(linux?.pidsAvailable === undefined ? {} : { pidsAvailable: linux.pidsAvailable }),
      ...(linux?.pressure ? { pressure: linux.pressure } : {}),
      system: {
        source: linux?.source ?? 'host-os', status: linux?.status ?? 'available',
        scope: linux && linux.source !== 'host-os' ? 'visible-cgroup-ancestors' : 'host',
        physical: { cpuCores: physicalCores, memoryMb: physicalMemory / MIB },
        warnings: linux?.warnings ?? [],
      },
    };
  };
}

export function readResearchReserve(env: NodeJS.ProcessEnv = process.env): { cpuCores: number; memoryMb: number } {
  const read = (name: string): number => {
    const text = env[name];
    if (text === undefined) return 0;
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative number`);
    return value;
  };
  return { cpuCores: read('VARIN_RESEARCH_RESERVE_CPU_CORES'), memoryMb: read('VARIN_RESEARCH_RESERVE_MEMORY_MB') };
}
