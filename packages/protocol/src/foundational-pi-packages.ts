import type { PackageDescriptor } from "./types.js";

export const FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION = 4 as const;

export const FOUNDATIONAL_PI_PACKAGE_IDS = [
  "mcp",
] as const;

export type FoundationalPiPackageId = (typeof FOUNDATIONAL_PI_PACKAGE_IDS)[number];

export interface FoundationalPiPackageManifestEntry {
  /** Optional external integration; only an explicit restore installs it. */
  defaultProvision?: boolean;
  /** Stable Varin integration identity. It is not a package-source allowlist. */
  id: FoundationalPiPackageId;
  introducedRevision: number;
  /** Name declared by the package itself. */
  packageName: string;
  /** Package identities accepted when matching Pi's observed package descriptor. */
  packageAliases: readonly string[];
  /** Current source used only for default provisioning. */
  source: string;
}

export interface FoundationalPiPackageManifest {
  integrations: readonly FoundationalPiPackageManifestEntry[];
  revision: typeof FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION;
}

export interface PackageBootstrapItemResult {
  error?: string;
  source: string;
  status: "installed" | "already_configured" | "failed";
}

/** Private Host batch result used by the broker-owned provisioner. */
export interface PackageBootstrapResult {
  packages: PackageDescriptor[];
  results: PackageBootstrapItemResult[];
}

export const FOUNDATIONAL_PI_PACKAGE_MANIFEST = {
  integrations: [
    {
      id: "mcp",
      defaultProvision: false,
      introducedRevision: 1,
      packageAliases: ["@varin/pi-mcp-adapter", "pi-mcp-adapter"],
      packageName: "@varin/pi-mcp-adapter",
      source: "npm:@varin/pi-mcp-adapter",
    },
  ],
  revision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
} as const satisfies FoundationalPiPackageManifest;

export const FOUNDATIONAL_PI_PACKAGE_INTENTS = [
  "eligible",
  "suppressed",
  "policy_skipped",
] as const;

export type FoundationalPiPackageIntent = (typeof FOUNDATIONAL_PI_PACKAGE_INTENTS)[number];

export const FOUNDATIONAL_PI_PACKAGE_PROVENANCES = ["none", "auto_managed", "adopted"] as const;

export type FoundationalPiPackageProvenance =
  (typeof FOUNDATIONAL_PI_PACKAGE_PROVENANCES)[number];

export const FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES = [
  "missing",
  "enabled",
  "disabled",
  "configured_broken",
  "incompatible",
  "source_conflict",
] as const;

export type FoundationalPiPackageObservedState =
  (typeof FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES)[number];

export const FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES = [
  "idle",
  "planned",
  "mutating",
  "verifying",
  "failed_retryable",
  "action_required",
] as const;

export type FoundationalPiPackageOperationState =
  (typeof FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES)[number];

export const FOUNDATIONAL_PI_PACKAGE_STATUS_STATES = [
  "idle",
  "running",
  "ready",
  "degraded",
] as const;

export type FoundationalPiPackageStatusState =
  (typeof FOUNDATIONAL_PI_PACKAGE_STATUS_STATES)[number];

/** Browser-safe projection of one foundational package's current state. */
export interface FoundationalPiPackageStatusEntry {
  error?: string;
  id: FoundationalPiPackageId;
  intent: FoundationalPiPackageIntent;
  observed: FoundationalPiPackageObservedState;
  operation: FoundationalPiPackageOperationState;
  provenance: FoundationalPiPackageProvenance;
  /** Actual source reported by Pi, which may differ from the manifest source. */
  source?: string;
}

/**
 * JSON-safe projection that excludes receipt internals. `source` and actionable errors retain the
 * same host path visibility as Pi's existing PackageDescriptor surface.
 */
export interface FoundationalPiPackageStatusSnapshot {
  autoInstallNew: boolean;
  entries: FoundationalPiPackageStatusEntry[];
  manifestRevision: number;
  /** Monotonic within one broker lifetime so stale reads cannot replace newer status. */
  revision: number;
  state: FoundationalPiPackageStatusState;
}

function packageNameFromIdentity(value: string): string {
  let identity = value.trim();
  if (identity.startsWith("npm:")) identity = identity.slice(4);
  if (identity.startsWith("@")) {
    const slash = identity.indexOf("/");
    const version = slash < 0 ? -1 : identity.indexOf("@", slash);
    return (version < 0 ? identity : identity.slice(0, version)).toLowerCase();
  }
  if (/^[A-Za-z0-9_.-]+(?:@[^@/]+)?$/.test(identity)) {
    return (identity.split("@")[0] ?? identity).toLowerCase();
  }
  const normalized = identity.replaceAll("\\", "/").replace(/\/+$/, "");
  const leaf = normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":")) + 1);
  return (leaf.replace(/\.git$/i, "") || identity).toLowerCase();
}

export function foundationalPackageIdentity(value: string): string {
  return packageNameFromIdentity(value);
}

export function matchesFoundationalPackage(
  entry: FoundationalPiPackageManifestEntry,
  descriptor: Pick<PackageDescriptor, "name" | "source">,
): boolean {
  if (descriptor.source === entry.source) return true;
  const identities = new Set(
    [entry.packageName, ...entry.packageAliases, entry.source].map(packageNameFromIdentity),
  );
  return identities.has(packageNameFromIdentity(descriptor.name))
    || identities.has(packageNameFromIdentity(descriptor.source));
}

export function findFoundationalPackageBySource(
  integrations: readonly FoundationalPiPackageManifestEntry[],
  source: string,
): FoundationalPiPackageManifestEntry | undefined {
  const identity = packageNameFromIdentity(source);
  return integrations.find((entry) => (
    entry.source === source
    || [entry.packageName, ...entry.packageAliases, entry.source]
      .some((candidate) => packageNameFromIdentity(candidate) === identity)
  ));
}
