#!/usr/bin/env python3
"""Observe a Docker cgroup from the host, so sampler memory is not charged to it."""
import json, os, pathlib, sys, time

pid, directory = int(sys.argv[1]), pathlib.Path(sys.argv[2])
entries = pathlib.Path(f'/proc/{pid}/cgroup').read_text().splitlines()
relative = next(line.split(':', 2)[2] for line in entries if line.startswith('0::'))
root = pathlib.Path('/sys/fs/cgroup') / relative.lstrip('/')
assert (root / 'memory.current').exists(), f'cgroup v2 is required: {root}'

def number(name):
    text = (root / name).read_text().strip()
    return int(text) if text != 'max' else text

def fields(name):
    return {line.split()[0]: int(line.split()[1]) for line in (root / name).read_text().splitlines()}

ancestors = []
for group in [root, *root.parents]:
    if not str(group).startswith('/sys/fs/cgroup'): break
    ancestors.append({'path':str(group), **{name:(group/name).read_text().strip() for name in ['cpu.max','cpuset.cpus.effective','memory.max','memory.current'] if (group/name).exists()}})
metadata = {'hostLogicalCpus':os.cpu_count(), 'samplerAffinityCpus':sorted(os.sched_getaffinity(0)), 'visibleCgroupAncestors':ancestors, 'cgroup': str(root), 'pid': pid, 'memoryMax': number('memory.max'),
            'swapMax': number('memory.swap.max'), 'pidsMax': number('pids.max'),
            'cpuMax': (root / 'cpu.max').read_text().strip(), 'intervalMs': 250,
            'samplerPlacement': 'host outside measured container',
            'rssDefinition': 'sum of /proc/<pid>/status VmRSS for container processes; shared pages can count more than once'}
(directory / 'measurement-environment.json').write_text(json.dumps(metadata, indent=2) + '\n')
with (directory / 'samples.jsonl').open('w', buffering=1) as out:
    while not (directory / 'stop-sampler').exists():
        started = time.monotonic()
        try:
            stat = fields('memory.stat')
            processes = []
            for task in (root / 'cgroup.procs').read_text().split():
                try:
                    data = pathlib.Path(f'/proc/{task}/status').read_text().splitlines()
                    attrs = {line.split(':', 1)[0]: line.split(':', 1)[1].strip() for line in data}
                    processes.append({'pid': int(task), 'name': attrs['Name'], 'rssBytes': int(attrs.get('VmRSS', '0 kB').split()[0]) * 1024,
                                      'rssAnonBytes': int(attrs.get('RssAnon', '0 kB').split()[0]) * 1024})
                except (FileNotFoundError, ProcessLookupError):
                    continue
            current = number('memory.current')
            record = {'unixMs': round(time.time() * 1000), 'monotonicMs': round(started * 1000),
                      'phase': (directory / 'phase').read_text().strip(), 'memoryCurrentBytes': current,
                      'memoryPeakBytes': number('memory.peak'), 'workingSetBytes': max(0, current - stat.get('inactive_file', 0)),
                      'rssBytes': sum(p['rssBytes'] for p in processes), 'memoryStat': stat,
                      'memoryEvents': fields('memory.events'), 'cpuStat': fields('cpu.stat'),
                      'pidsCurrent': number('pids.current'), 'processes': processes}
            out.write(json.dumps(record, separators=(',', ':')) + '\n')
        except Exception as exc:
            out.write(json.dumps({'unixMs': round(time.time()*1000), 'error': repr(exc)}) + '\n')
            if not root.exists(): break
        time.sleep(max(0, 0.25 - (time.monotonic() - started)))
