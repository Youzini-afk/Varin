import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function checkGlibcSymbols(symbols, maximum = '2.35') {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(maximum)) throw new Error('Invalid GLIBC baseline');
  const requirements = [...new Set([...symbols.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/g)].map(match => match[1]))];
  if (!requirements.length) throw new Error('No GLIBC requirements found');
  const baseline = maximum.split('.').map(Number);
  const tooNew = requirements.filter(version => {
    const parts = version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const delta = (parts[i] ?? 0) - (baseline[i] ?? 0);
      if (delta !== 0) return delta > 0;
    }
    return false;
  });
  if (tooNew.length) throw new Error(`Requires GLIBC ${tooNew.join(', ')}, above ${maximum}`);
  return requirements;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [binary, maximum = '2.35'] = process.argv.slice(2);
  if (!binary) throw new Error('Usage: node scripts/check-linux-glibc.mjs <binary> [maximum-version]');
  checkGlibcSymbols(execFileSync('objdump', ['-T', binary], { encoding: 'utf8' }), maximum);
  console.log(`${binary}: GLIBC requirements are at most ${maximum}`);
}
