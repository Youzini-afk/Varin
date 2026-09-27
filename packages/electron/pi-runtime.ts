import path from 'node:path';
import {
  assertExternalPiHostEntry,
  isExternalPiHostEntry,
  PiHostEntryUnavailableError,
  PiRuntimeBroker,
  applicationHostClientCapabilities,
  resolveBundledPiHostEntry,
} from '@varin/runtime-broker';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@varin/protocol';
import type { FoundationalPiPackageManifestEntry } from '@varin/protocol';
import type { PiRuntimeBrokerEvent, PiRuntimeBrokerOptions } from '@varin/runtime-broker';

const PI_HOST_PACKAGE_ENTRY = path.join(
  'node_modules',
  '@varin',
  'pi-host',
  'dist',
  'host-bootstrap.js',
);

const uniquePaths = (entries: Array<string | null | undefined>): string[] => [
  ...new Set(entries.filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry))),
];

const unpackedEntryFromAsar = (entry: string): string | null => {
  const normalized = path.resolve(entry);
  const marker = `${path.sep}app.asar${path.sep}`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex === -1) return null;
  return `${normalized.slice(0, markerIndex)}${path.sep}app.asar.unpacked${path.sep}${normalized.slice(markerIndex + marker.length)}`;
};

export const electronPiHostEntryCandidates = ({
  packaged,
  resourcesPath,
  resolvedEntry = resolveBundledPiHostEntry(),
}: {
  packaged: boolean;
  resolvedEntry?: string;
  resourcesPath?: string;
}): string[] => {
  const normalizedEntry = path.resolve(resolvedEntry);
  const unpackedFromResolved = unpackedEntryFromAsar(normalizedEntry);
  const packagedCandidate = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', PI_HOST_PACKAGE_ENTRY)
    : null;
  if (!packaged && !unpackedFromResolved) return [normalizedEntry];
  return uniquePaths([
    unpackedFromResolved,
    packagedCandidate,
    ...(unpackedFromResolved ? [] : [normalizedEntry]),
  ]);
};

export const resolveElectronPiHostEntry = (options: {
  packaged: boolean;
  resolvedEntry?: string;
  resourcesPath?: string;
}): string => {
  const candidates = electronPiHostEntryCandidates(options);
  const candidate = candidates.find(isExternalPiHostEntry);
  if (!candidate) {
    if (!options.packaged && candidates.length === 1 && !unpackedEntryFromAsar(candidates[0]!)) {
      throw new Error(
        `Pi host build is missing at ${candidates[0]}; run bun run --cwd packages/runtime-broker build`,
      );
    }
    throw new PiHostEntryUnavailableError(candidates);
  }
  return candidate;
};

export interface DesktopPiRuntimeBrokerOptions {
  admitSessionExecution?: PiRuntimeBrokerOptions['admitSessionExecution'];
  agentDir?: string;
  clientVersion: string;
  cwd?: string;
  emit: (event: PiRuntimeBrokerEvent) => void;
  foundationalPackages?: readonly FoundationalPiPackageManifestEntry[];
  hostEntry?: string;
  nodePath?: string;
  packageRoot?: string;
  packaged: boolean;
  resourcesPath?: string;
  resolveProjectWorkFocus?: PiRuntimeBrokerOptions['resolveProjectWorkFocus'];
  runtimeGeneration?: number;
  runtimeSource?: PiRuntimeBrokerOptions['runtimeSource'];
}

export const createDesktopPiRuntimeBroker = ({
  admitSessionExecution,
  agentDir,
  clientVersion,
  cwd,
  emit,
  foundationalPackages = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations,
  hostEntry,
  nodePath,
  packaged,
  packageRoot,
  resourcesPath,
  resolveProjectWorkFocus,
  runtimeGeneration,
  runtimeSource,
}: DesktopPiRuntimeBrokerOptions): PiRuntimeBroker => {
  const resolvedHostEntry = hostEntry
    ? assertExternalPiHostEntry(hostEntry)
    : resolveElectronPiHostEntry({
        packaged,
        ...(resourcesPath !== undefined ? { resourcesPath } : {}),
      });
  return new PiRuntimeBroker({
    ...(admitSessionExecution ? { admitSessionExecution } : {}),
    ...(agentDir ? { agentDir } : {}),
    client: {
      capabilities: applicationHostClientCapabilities({
        documentRead: true,
        documentPathOverlay: true,
        webRead: true,
        webSearch: true,
      }),
      clientName: 'varin-electron',
      clientVersion,
      mode: 'desktop',
    },
    emit,
    foundationalPackages,
    hostEntry: resolvedHostEntry,
    ...(cwd ? { cwd } : {}),
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(resolveProjectWorkFocus ? { resolveProjectWorkFocus } : {}),
    ...(runtimeGeneration !== undefined ? { runtimeGeneration } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  });
};
