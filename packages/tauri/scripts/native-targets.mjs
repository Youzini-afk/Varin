/** Native CI target selection. A focused observation is never six-target acceptance. */
export const nativeTargets = Object.freeze([
  { platform: 'linux', architecture: 'x64', runner: 'ubuntu-24.04' },
  { platform: 'win32', architecture: 'x64', runner: 'windows-latest' },
  { platform: 'darwin', architecture: 'arm64', runner: 'macos-15' },
  { platform: 'linux', architecture: 'arm64', runner: 'ubuntu-24.04-arm' },
  { platform: 'win32', architecture: 'arm64', runner: 'windows-11-arm' },
  { platform: 'darwin', architecture: 'x64', runner: 'macos-15-intel' },
].map(Object.freeze));

export function selectNativeTargets({ full = false, target = '' } = {}) {
  if (typeof full !== 'boolean' || typeof target !== 'string') throw new Error('Invalid native target selection');
  if (!target || target === 'default') return nativeTargets.slice(0, full ? 6 : 3);
  if (full) throw new Error('A focused native target cannot replace an explicitly requested full run');
  const selected = nativeTargets.find(value => `${value.platform}-${value.architecture}` === target);
  if (!selected) throw new Error('Unknown native target');
  return [selected];
}
