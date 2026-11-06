#!/usr/bin/env python3
"""Summarize raw observations without pretending an arbitrary workload is a universal maximum."""
import json, pathlib, statistics, sys
path = pathlib.Path(sys.argv[1])
samples = [json.loads(line) for line in (path / 'samples.jsonl').read_text().splitlines()]
environment = json.loads((path / 'measurement-environment.json').read_text())
quota, period = environment['cpuMax'].split()
cores = int(quota) / int(period) if quota != 'max' else None
mib = 1024 * 1024
summary = {'environment': environment, 'samplingErrors': [s for s in samples if 'error' in s], 'phases': {}}
for phase in dict.fromkeys(s['phase'] for s in samples if 'phase' in s):
    rows = [s for s in samples if s.get('phase') == phase]
    if len(rows) < 2: continue
    elapsed = (rows[-1]['monotonicMs'] - rows[0]['monotonicMs']) / 1000
    # Last 30 s is the reported stable window; do not force a GC or evict caches.
    stable = [s for s in rows if s['monotonicMs'] >= rows[-1]['monotonicMs'] - 30000]
    result = {'sampleCount': len(rows), 'durationSeconds': elapsed, 'stableWindowSeconds': min(30, elapsed)}
    for key in ['memoryCurrentBytes', 'workingSetBytes', 'rssBytes']:
        values = sorted(s[key] / mib for s in rows)
        result[key.replace('Bytes', 'MiB')] = {'mean': statistics.mean(values), 'median': statistics.median(values),
            'p95': values[min(len(values)-1, int(len(values)*.95))], 'sampledPeak': max(values),
            'stableMedian': statistics.median(s[key] / mib for s in stable), 'final': rows[-1][key] / mib,
            'last30sMinusFirst30sMedian': statistics.median(s[key]/mib for s in stable) - statistics.median(s[key]/mib for s in rows if s['monotonicMs'] <= rows[0]['monotonicMs'] + 30000)}
    result['cgroupLifetimePeakMiB'] = rows[-1]['memoryPeakBytes'] / mib
    usage = (rows[-1]['cpuStat']['usage_usec'] - rows[0]['cpuStat']['usage_usec']) / 1000000
    result['meanCpuCores'] = usage / elapsed
    result['quotaUtilizationPercent'] = usage / elapsed / cores * 100 if cores else None
    result['throttledPeriods'] = rows[-1]['cpuStat'].get('nr_throttled', 0) - rows[0]['cpuStat'].get('nr_throttled', 0)
    result['memoryEventsDelta'] = {key: value - rows[0]['memoryEvents'].get(key, 0) for key, value in rows[-1]['memoryEvents'].items()}
    result['finalBreakdownMiB'] = {key: rows[-1]['memoryStat'].get(key, 0)/mib for key in ['anon','file','kernel','slab','inactive_file','active_file']}
    result['finalProcesses'] = rows[-1]['processes']
    result['maxTasks'] = max(s['pidsCurrent'] for s in rows)
    summary['phases'][phase] = result
(path / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
