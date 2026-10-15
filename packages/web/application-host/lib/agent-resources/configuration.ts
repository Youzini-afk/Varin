import path from 'node:path';

export interface ConfiguredPackage {
  source: string;
  installedPath?: string;
  structured?: boolean;
  skills?: string[];
  autoload?: boolean;
}
export interface ResourceSettings { skills: string[]; packages: ConfiguredPackage[] }
const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be an array of strings`);
  return [...value] as string[];
};
export function parseResourceSettings(content: string): ResourceSettings { return readResourceSettings(JSON.parse(content)); }
/** Resources share the native settings transaction, never a second configuration writer. */
export function readResourceSettings(document: unknown): ResourceSettings {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Settings must be a JSON object');
  const configured = (document as Record<string, unknown>).resources;
  const value: unknown = configured === undefined ? {} : configured;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be a JSON object');
  const data = value as Record<string, unknown>;
  const skills = data.skills === undefined ? [] : stringArray(data.skills, 'skills');
  if (data.packages !== undefined && !Array.isArray(data.packages)) throw new Error('packages must be an array');
  const packages = ((data.packages ?? []) as unknown[]).map(entry => {
    if (typeof entry === 'string') { if (!entry.trim()) throw new Error('Package source must not be empty'); return { source: entry }; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Package must have a source');
    const value = entry as Record<string, unknown>;
    if (typeof value.source !== 'string' || !value.source.trim()) throw new Error('Package source must be a string');
    if (value.installedPath !== undefined && (typeof value.installedPath !== 'string' || !value.installedPath.trim())) throw new Error('Package installedPath must be a non-empty path');
    if (value.autoload !== undefined && typeof value.autoload !== 'boolean') throw new Error('Package autoload must be a boolean');
    return { source: value.source, structured: true, ...(value.installedPath === undefined ? {} : { installedPath: value.installedPath as string }), ...(value.skills === undefined ? {} : { skills: stringArray(value.skills, 'package.skills') }),
      ...(value.autoload === undefined ? {} : { autoload: value.autoload }) } as ConfiguredPackage;
  });
  return { skills, packages };
}
export function parsePackageSkillManifest(content: string): { hasManifest: boolean; skills?: string[] } {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Package manifest must be a JSON object');
  const manifest = (value as Record<string, unknown>).varin;
  if (manifest === undefined) {
    if (Object.hasOwn(value, 'pi')) throw new Error('Resource packages require a native varin manifest');
    return { hasManifest: false };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('varin manifest must be an object');
  const skills = (manifest as Record<string, unknown>).skills;
  return { hasManifest: true, ...(skills === undefined ? {} : { skills: stringArray(skills, 'varin.skills') }) };
}
export const isOverridePattern = (value: string): boolean => /^[!+-]/.test(value);
export const hasGlobPattern = (value: string): boolean => /[*?]/.test(value);
export const isLocalPattern = (value: string): boolean => isOverridePattern(value) || hasGlobPattern(value);
interface FilterPath { path: string; base: string; absolute?: string }
function matches(file: FilterPath, pattern: string, exact: boolean): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const relative = path.posix.relative(file.base || '.', file.path);
  const candidates = [relative, ...(file.absolute ? [file.absolute.replaceAll('\\', '/')] : [])];
  if (!exact) candidates.push(path.posix.basename(file.path));
  if (path.posix.basename(file.path) === 'SKILL.md') {
    candidates.push(path.posix.dirname(relative));
    if (file.absolute) candidates.push(path.posix.dirname(file.absolute.replaceAll('\\', '/')));
    if (!exact) candidates.push(path.posix.basename(path.posix.dirname(file.path)));
  }
  // Node's supported glob matcher uses minimatch semantics; no additional dependency or installer.
  return candidates.some(candidate => exact ? candidate === normalized : path.posix.matchesGlob(candidate, normalized));
}
/** Resource filters apply include, !exclude, +exact, -exact in that order, independent of array order. */
export function resourceEnabled(file: FilterPath, patterns: readonly string[], options: { overridesOnly?: boolean; emptyDisables?: boolean } = {}): boolean {
  if (options.emptyDisables && patterns.length === 0) return false;
  const selected = options.overridesOnly ? patterns.filter(isOverridePattern) : patterns;
  const includes = selected.filter(pattern => !isOverridePattern(pattern));
  let enabled = includes.length === 0 || includes.some(pattern => matches(file, pattern, false));
  if (selected.some(pattern => pattern.startsWith('!') && matches(file, pattern.slice(1), false))) enabled = false;
  if (selected.some(pattern => pattern.startsWith('+') && matches(file, pattern.slice(1), true))) enabled = true;
  if (selected.some(pattern => pattern.startsWith('-') && matches(file, pattern.slice(1), true))) enabled = false;
  return enabled;
}
/** autoload:false is an ordered delta; undefined means no decision, preserving an inherited entry. */
export function packageDelta(file: FilterPath, patterns: readonly string[]): boolean | undefined {
  let enabled: boolean | undefined;
  for (const pattern of patterns) {
    if (matches(file, isOverridePattern(pattern) ? pattern.slice(1) : pattern, /^[+-]/.test(pattern))) enabled = !/^[!-]/.test(pattern);
  }
  return enabled;
}
