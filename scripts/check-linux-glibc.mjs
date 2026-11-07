import { execFileSync } from 'node:child_process';

const [binary, maximum = '2.35'] = process.argv.slice(2);
if (!binary || !/^\d+\.\d+$/.test(maximum)) {
  console.error('Usage: node scripts/check-linux-glibc.mjs <binary> [maximum-version]');
  process.exit(2);
}
const symbols = execFileSync('objdump', ['-T', binary], { encoding: 'utf8' });
const requirements = [...symbols.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.\d+)?\b/g)]
  .map((match) => [Number(match[1]), Number(match[2])]);
if (!requirements.length) throw new Error(`No GLIBC requirements found in ${binary}`);
const [maxMajor, maxMinor] = maximum.split('.').map(Number);
const tooNew = requirements.filter(([major, minor]) => major > maxMajor || (major === maxMajor && minor > maxMinor));
const versions = [...new Set(tooNew.map(([major, minor]) => `${major}.${minor}`))];
if (versions.length) throw new Error(`${binary} requires GLIBC ${versions.join(', ')}, above ${maximum}`);
console.log(`${binary}: GLIBC requirements are at most ${maximum}`);
