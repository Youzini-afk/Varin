/** Reuse the locked SDK's credential-value contract without opening its private store. */
interface Resolver {
  resolveConfigValue(value: string, env?: Record<string, string>): string | undefined;
  isCommandConfigValue(value: string): boolean;
  getConfigValueEnvVarNames(value: string): string[];
}
let loaded: Promise<Resolver> | undefined;
export function credentialValueResolver(): Promise<Resolver> {
  loaded ??= (async () => {
    const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const extension = new URL(entry).pathname.endsWith('.ts') ? 'ts' : 'js';
    const value = await import(new URL(`./core/resolve-config-value.${extension}`, entry).href) as Partial<Resolver>;
    if (typeof value.resolveConfigValue !== 'function' || typeof value.isCommandConfigValue !== 'function'
      || typeof value.getConfigValueEnvVarNames !== 'function') throw new Error('credential-value-resolver-unavailable');
    return value as Resolver;
  })();
  return loaded;
}
