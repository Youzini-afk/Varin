import { describe, expect, it } from 'vitest';
import { probeLinuxResources, readResearchReserve } from './resources-system.js';

function fixture(entries: Record<string, string>) {
  return (file: string): string => {
    if (!(file in entries)) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
    return entries[file]!;
  };
}
const v2 = (entries: Record<string, string>, membership = '/tenant/job', root = '/') => fixture({
  '/proc/self/cgroup': `0::${membership}\n`,
  '/proc/self/mountinfo': `1 0 0:1 ${root} /cg rw - cgroup2 cgroup rw\n`,
  '/proc/self/status': 'Cpus_allowed_list:\t2-7\n',
  '/cg/tenant/job/cpu.max': 'max 100000', '/cg/tenant/cpu.max': '150000 100000', '/cg/cpu.max': 'max 100000',
  '/cg/tenant/job/cpuset.cpus.effective': '0-3,3-5', '/cg/tenant/cpuset.cpus.effective': '0-7',
  '/cg/tenant/job/memory.max': 'max', '/cg/tenant/job/memory.current': '100',
  '/cg/tenant/memory.max': '1000', '/cg/tenant/memory.current': '900',
  '/cg/tenant/job/pids.max': 'max', '/cg/tenant/job/pids.current': '4',
  '/cg/tenant/pids.max': '20', '/cg/tenant/pids.current': '18',
  '/cg/tenant/job/cpu.stat': 'usage_usec 1250000\nuser_usec 1000000\n',
  ...entries,
});

describe('Linux effective resource facts', () => {
  it('uses every visible ancestor, fractional quota, set intersection and sibling memory/PID pressure', () => {
    expect(probeLinuxResources(v2({}))).toMatchObject({
      source: 'linux-cgroup-v2', status: 'available', warnings: [], cpuCores: 1.5,
      memoryBytes: 1000, memoryUsedBytes: 100, memoryAvailableBytes: 100,
      pidsLimit: 20, pidsCurrent: 4, pidsAvailable: 2, cpuUsageSeconds: 1.25,
    });
    expect(probeLinuxResources(v2({ '/cg/tenant/cpu.max': 'max 100000' })).cpuCores).toBe(4);
    expect(probeLinuxResources(v2({ '/cg/cpu.max': '50000 100000' })).cpuCores).toBe(0.5);
    expect(probeLinuxResources(v2({ '/cg/tenant/job/cpuset.cpus.effective': '' })).cpuCores).toBe(0);
  });

  it.each(['/private/slice/job', '/job'])('maps %s through a cgroup subtree mount without reading hidden parents', membership => {
    const seen: string[] = [];
    const read = fixture({
      '/proc/self/cgroup': `0::${membership}`,
      '/proc/self/mountinfo': '1 0 0:1 /private/slice /cg\\040space rw - cgroup2 cgroup rw',
      '/proc/self/status': 'Cpus_allowed_list:\t0-7',
      '/cg space/job/cpu.max': 'max 100000', '/cg space/cpu.max': '75000 100000',
      '/cg space/job/memory.max': 'max', '/cg space/job/memory.current': '40',
      '/cg space/memory.max': '500', '/cg space/memory.current': '100',
      '/cg space/job/pids.max': 'max', '/cg space/job/pids.current': '5',
    });
    const result = probeLinuxResources(file => { seen.push(file); return read(file); });
    expect(result).toMatchObject({ cpuCores: 0.75, memoryBytes: 500, memoryAvailableBytes: 400 });
    expect(seen.some(file => file.startsWith('/private/') || file === '/cpu.max')).toBe(false);
  });

  it('supports v1 co-mounted CPU, legacy unlimited memory and nonhierarchical memory parents', () => {
    const entries = {
      '/proc/self/cgroup': '3:cpu,cpuacct:/batch/job\n4:memory:/batch/job\n5:pids:/batch/job\n6:cpuset:/batch/job',
      '/proc/self/mountinfo': '1 0 0:1 / /cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 / /mem rw - cgroup cgroup rw,memory\n3 0 0:3 / /pid rw - cgroup cgroup rw,pids\n4 0 0:4 / /set rw - cgroup cgroup rw,cpuset',
      '/proc/self/status': 'Cpus_allowed_list:\t0-3',
      '/cpu/batch/job/cpu.cfs_quota_us': '-1', '/cpu/batch/job/cpu.cfs_period_us': '100000',
      '/cpu/batch/cpu.cfs_quota_us': '50000', '/cpu/batch/cpu.cfs_period_us': '100000',
      '/cpu/batch/job/cpuacct.usage': '2500000000',
      '/mem/batch/job/memory.limit_in_bytes': '9223372036854771712', '/mem/batch/job/memory.usage_in_bytes': '50',
      '/mem/batch/memory.use_hierarchy': '1', '/mem/batch/memory.limit_in_bytes': '500', '/mem/batch/memory.usage_in_bytes': '150',
      '/mem/memory.use_hierarchy': '0', '/mem/memory.limit_in_bytes': '10',
      '/pid/batch/job/pids.max': 'max', '/pid/batch/job/pids.current': '7',
      '/set/batch/job/cpuset.cpus': '', '/set/batch/cpuset.cpus': '0-1',
    };
    expect(probeLinuxResources(fixture(entries))).toMatchObject({ source: 'linux-cgroup-v1', status: 'available',
      cpuCores: 0.5, cpuUsageSeconds: 2.5, memoryBytes: 500, memoryUsedBytes: 50, memoryAvailableBytes: 350, pidsCurrent: 7 });
    expect(probeLinuxResources(fixture({ ...entries, '/mem/batch/memory.use_hierarchy': '0' })).memoryBytes).toBeUndefined();
  });

  it('reports inaccessible/malformed controls rather than converting them to unlimited/free', () => {
    const read = v2({ '/cg/tenant/cpu.max': 'nonsense', '/cg/tenant/memory.current': 'not-a-number' });
    const facts = probeLinuxResources(file => {
      if (file === '/cg/tenant/job/pids.max') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(file);
    });
    expect(facts.status).toBe('partial');
    expect(facts.memoryAvailableBytes).toBeUndefined();
    expect(facts.memoryHeadroomUnknown).toBe(true);
    expect(facts.warnings).toContain('/cg/tenant/memory.current: usage unavailable for limited hierarchy');
    expect(facts.warnings).toContain('/cg/tenant/job/pids.max: EACCES');
    expect(probeLinuxResources(v2({ '/cg/tenant/memory.max': 'invalid' })).memoryHeadroomUnknown).toBe(true);
    expect(probeLinuxResources(fixture({ '/proc/self/cgroup': '0::/', '/proc/self/mountinfo': '' })))
      .toMatchObject({ status: 'unavailable', source: 'host-os' });
  });
});

it('keeps reserves explicit, fractional and validated rather than inventing a per-worker memory cost', () => {
  expect(readResearchReserve({})).toEqual({ cpuCores: 0, memoryMb: 0 });
  expect(readResearchReserve({ VARIN_RESEARCH_RESERVE_CPU_CORES: '0.25', VARIN_RESEARCH_RESERVE_MEMORY_MB: '384' }))
    .toEqual({ cpuCores: 0.25, memoryMb: 384 });
  for (const value of ['', '-1', 'NaN', 'Infinity']) expect(() => readResearchReserve({ VARIN_RESEARCH_RESERVE_MEMORY_MB: value })).toThrow(/finite nonnegative/);
});

it('recognizes hybrid hierarchies and does not let a v2 mount hide v1 memory limits', () => {
  const read = fixture({
    '/proc/self/cgroup': '0::/job\n2:memory:/job',
    '/proc/self/mountinfo': '1 0 0:1 / /v2 rw - cgroup2 cgroup rw\n2 0 0:2 / /v1 rw - cgroup cgroup rw,memory',
    '/proc/self/status': 'Cpus_allowed_list:\t0-7',
    '/v2/job/cpu.max': '250000 100000', '/v2/job/pids.max': 'max', '/v2/job/pids.current': '10',
    '/v1/job/memory.limit_in_bytes': '2000', '/v1/job/memory.usage_in_bytes': '400', '/v1/memory.use_hierarchy': '0',
  });
  expect(probeLinuxResources(read)).toMatchObject({ source: 'linux-cgroup-hybrid', status: 'available', cpuCores: 2.5,
    memoryBytes: 2000, memoryUsedBytes: 400, memoryAvailableBytes: 1600 });
});

it('samples scoped throttling/OOM counters without inventing absent metrics', () => {
  expect(probeLinuxResources(v2({
    '/cg/tenant/job/cpu.stat': 'usage_usec 1250000\nnr_throttled 3\nthrottled_usec 250000',
    '/cg/tenant/job/memory.events': 'low 0\nhigh 0\nmax 5\noom 2\noom_kill 1',
  })).pressure).toEqual({
    cpu: { scope: '/cg/tenant/job', throttledSeconds: 0.25, throttleEvents: 3 },
    memory: { scope: '/cg/tenant/job', oomEvents: 2, oomKills: 1, limitEvents: 5 },
  });
  expect(probeLinuxResources(v2({})).pressure).toBeUndefined();
  const legacy = fixture({
    '/proc/self/cgroup': '1:cpu:/job\n2:memory:/job',
    '/proc/self/mountinfo': '1 0 0:1 / /cpu rw - cgroup cgroup rw,cpu\n2 0 0:2 / /mem rw - cgroup cgroup rw,memory',
    '/cpu/job/cpu.stat': 'nr_throttled 7\nthrottled_time 1000000000',
    '/mem/job/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 2',
    '/mem/job/memory.failcnt': '12',
  });
  expect(probeLinuxResources(legacy).pressure).toEqual({
    cpu: { scope: '/cpu/job', throttledSeconds: 1, throttleEvents: 7 },
    memory: { scope: '/mem/job', oomKills: 2, limitEvents: 12 },
  });
});
