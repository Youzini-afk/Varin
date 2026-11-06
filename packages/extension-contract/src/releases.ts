import semver from 'semver';
import type { VarinExtensionManifest, VarinExtensionPublicPackageSource, VarinExtensionPackageSource } from './types.js';

export interface VarinExtensionReleaseManifest {
  schemaVersion: 1;
  extensionId: string;
  version: string;
  engines: { varin: string };
  assets: { file: string; sha256: string; platform: string; arch: string }[];
}
export interface VarinExtensionReleasePreview {
  previewId: string;
  catalogRevision: number;
  hostId: string;
  source: VarinExtensionPublicPackageSource;
  manifest: VarinExtensionManifest;
  version: string;
  integrity: string;
  sourceChanged: boolean;
  previousVersion?: string;
  /** Public upstream notes for the exact resolved release, when the source exposes them. */
  releaseNotesUrl?: string;
  warnings: string[];
}
export interface VarinExtensionReleaseInstallRequest {
  previewId: string;
  expectedHostId: string;
  expectedRevision: number;
  replaceSource?: boolean;
}
export interface VarinExtensionUpdateCheck {
  extensionId: string;
  checkedAt: string;
  status: 'available' | 'current' | 'unavailable' | 'failed' | 'manual';
  version?: string;
  message?: string;
}
export function parseGithubReleaseSource(specifier: string): { repository: string; channel: 'stable' | 'prerelease'; tagPrefix: string; manifest: string } {
  const match = /^([\w.-]+)\/([\w.-]+)(?:#(stable|prerelease)(?:\?(.*))?)?$/.exec(specifier);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') throw new Error('GitHub release source must be owner/repository[#stable|prerelease?tagPrefix=v&manifest=varin.release.json]');
  const params = new URLSearchParams(match[4]);
  params.forEach((_value, key) => { if (key !== 'tagPrefix' && key !== 'manifest') throw new Error(`Unknown release selector: ${key}`); });
  const manifest = params.get('manifest') ?? 'varin.release.json';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest)) throw new Error('Invalid release manifest filename');
  return { repository: `${match[1]}/${match[2]}`.toLowerCase(), channel: match[3] === 'prerelease' ? 'prerelease' : 'stable',
    tagPrefix: params.get('tagPrefix') ?? 'v', manifest };
}
/** Public registry identity, not an npm CLI alias, URL, filesystem path or install command. */
export function parseNpmReleaseSource(specifier: string): { name: string; selection: string } {
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([\s\S]+))?$/.exec(specifier.trim());
  if (!match) throw new Error('npm release source requires a registry package name and optional version, range or dist-tag');
  const selection = match[2]?.trim() ?? 'latest';
  if (!selection || (!semver.validRange(selection) && encodeURIComponent(selection) !== selection)) {
    throw new Error('npm release selection must be a valid SemVer range or dist-tag');
  }
  return { name: match[1]!, selection };
}
export const extensionSourceIdentity = (source: VarinExtensionPackageSource): string => {
  if (source.kind === 'github-release') return `github-release:${JSON.stringify(parseGithubReleaseSource(source.specifier))}`;
  if (source.kind === 'npm') {
    try {
      const { name, selection } = parseNpmReleaseSource(source.specifier);
      return `npm:${name}${selection === 'latest' ? '' : `@${selection}`}`;
    } catch {
      // Legacy npm development sources may be CLI specifiers, not public registry identities.
      // Preserve their exact source rather than guessing a migration or breaking catalog reads.
      return `npm:${source.specifier}`;
    }
  }
  return `${source.kind}:${source.specifier}`;
};
export function parseVarinExtensionReleaseManifest(value: unknown): VarinExtensionReleaseManifest {
  const raw = value as VarinExtensionReleaseManifest;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.extensionId !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(raw.extensionId)
    || !semver.valid(raw.version) || !raw.engines || !semver.validRange(raw.engines.varin)
    || !Array.isArray(raw.assets) || !raw.assets.length) throw new Error('Invalid Varin release manifest');
  const files = new Set<string>();
  for (const asset of raw.assets) {
    if (!asset || typeof asset.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset.file)
      || files.has(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || typeof asset.platform !== 'string' || !asset.platform || typeof asset.arch !== 'string' || !asset.arch) {
      throw new Error('Invalid or duplicate Varin release asset');
    }
    files.add(asset.file);
  }
  return structuredClone(raw);
}
