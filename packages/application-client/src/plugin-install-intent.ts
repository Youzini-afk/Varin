import { parseGithubReleaseSource, parseNpmReleaseSource, type VarinExtensionPackageSource } from '@varin/extension-contract';
export interface PluginInstallIntent { source: VarinExtensionPackageSource; extensionId?: string }
let pending: PluginInstallIntent | null = null;
const listeners = new Set<() => void>();
/** An intent is navigation only. It cannot authorize preview installation or execution. */
export function parsePluginInstallIntent(value: unknown): PluginInstallIntent {
  if (!value || typeof value !== 'object') throw new Error('Invalid plugin install link');
  const input = value as { source?: unknown; extensionId?: unknown };
  const source = input.source as Partial<VarinExtensionPackageSource> | undefined;
  // Public links may name only network package identities, never local filesystem paths.
  if (!source || !['npm', 'github-release'].includes(source.kind ?? '') || typeof source.specifier !== 'string' || !source.specifier.trim()
    || typeof source.display !== 'string' || !source.display.trim()) throw new Error('Unsupported plugin install link source');
  if (source.kind === 'github-release') parseGithubReleaseSource(source.specifier);
  if (source.kind === 'npm') parseNpmReleaseSource(source.specifier);
  if (input.extensionId !== undefined && (typeof input.extensionId !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(input.extensionId))) throw new Error('Invalid plugin identity');
  // Reject URL userinfo and explicit credential-shaped query fields in public source references.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source.specifier)) {
    const url = new URL(source.specifier);
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|credential/i.test(key))) throw new Error('Install links cannot contain credentials');
  }
  return { source: { kind: source.kind as VarinExtensionPackageSource['kind'], specifier: source.specifier, display: source.display },
    ...(typeof input.extensionId === 'string' ? { extensionId: input.extensionId } : {}) };
}
export function publishPluginInstallIntent(value: unknown): void {
  pending = parsePluginInstallIntent(value); for (const listener of listeners) listener();
}
export function consumePluginInstallIntent(): PluginInstallIntent | null { const value = pending; pending = null; return value; }
export function subscribePluginInstallIntent(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function parsePluginInstallLink(raw: string): PluginInstallIntent | null {
  try {
    const url = new URL(raw);
    const source = url.protocol === 'varin:' && url.hostname === 'extensions' && url.pathname === '/install'
      ? url.searchParams.get('source') : /^https?:$/.test(url.protocol) ? url.searchParams.get('varin-plugin') : null;
    if (!source) return null;
    return parsePluginInstallIntent({ source: JSON.parse(source), ...(url.searchParams.has('extensionId') ? { extensionId: url.searchParams.get('extensionId') } : {}) });
  } catch { return null; }
}
