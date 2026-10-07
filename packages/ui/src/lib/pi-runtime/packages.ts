import type {
  PackageDescriptor,
  PiPackageScope,
  RuntimeContextTarget,
} from '@varin/protocol';
import { getPiRuntimeConnection } from './client';

export const piPackageNameFromSource = (source: string): string => {
  const trimmed = source.trim();
  const npmSpec = trimmed.startsWith('npm:') ? trimmed.slice(4) : null;
  if (npmSpec !== null) {
    if (npmSpec.startsWith('@')) {
      const slashIndex = npmSpec.indexOf('/');
      const versionIndex = slashIndex === -1 ? -1 : npmSpec.indexOf('@', slashIndex);
      return versionIndex === -1 ? npmSpec : npmSpec.slice(0, versionIndex);
    }
    const versionIndex = npmSpec.lastIndexOf('@');
    return versionIndex > 0 ? npmSpec.slice(0, versionIndex) : npmSpec;
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.git$/i, '');
  if (normalized.includes('/')) return basename;
  const versionIndex = basename.lastIndexOf('@');
  return versionIndex > 0 ? basename.slice(0, versionIndex) : basename;
};

export const isPiPackageUpdatable = (source: string): boolean => {
  const trimmed = source.trim();
  return trimmed.startsWith('npm:')
    || /^git@/i.test(trimmed)
    || /^(?:git|https?|ssh):\/\//i.test(trimmed);
};

export const findPiPackage = (
  packages: PackageDescriptor[],
  name: string,
  scope?: PiPackageScope,
): PackageDescriptor | undefined => packages.find((candidate) => (
  (scope === undefined || candidate.scope === scope)
  && (candidate.name === name || piPackageNameFromSource(candidate.source) === name)
));

export const listPiPackages = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('package.list', target);
};

export const installPiPackage = async (
  target: RuntimeContextTarget,
  source: string,
  scope: PiPackageScope,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('package.install', { ...target, scope, source });
};

export const updatePiPackages = async (target: RuntimeContextTarget, source?: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('package.update', {
    ...target,
    ...(source === undefined ? {} : { source }),
  });
};

export const removePiPackage = async (
  target: RuntimeContextTarget,
  source: string,
  scope: PiPackageScope,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('package.remove', { ...target, scope, source });
};

export const setPiPackageEnabled = async (
  target: RuntimeContextTarget,
  source: string,
  scope: PiPackageScope,
  enabled: boolean,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('package.setEnabled', { ...target, enabled, scope, source });
};
