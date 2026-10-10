export const VARIN_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const VARIN_EXTENSION_CATALOG_SCHEMA_VERSION = 1 as const;
export const VARIN_EXTENSION_MANIFEST_FILE = "varin.extension.json" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type VarinApplicationSurface = "desktop" | "mobile" | "web";
export type VarinExtensionHostMode = "brokered" | "native";

export type VarinContextValue = string | number | boolean;

export type VarinContextExpressionV1 =
  | { op: "defined"; key: string }
  | { op: "equals"; key: string; value: VarinContextValue }
  | { op: "not"; expression: VarinContextExpressionV1 }
  | { op: "all" | "any"; expressions: VarinContextExpressionV1[] };
export type VarinExtensionSurfaceMode = "declarative" | "isolated" | "managed" | "native";
export type VarinExtensionIsolationKind = "iframe" | "worker";
export type VarinExtensionActivationEvent =
  | "application-startup"
  | "background"
  | "command"
  | "contribution-visible"
  | "service-request"
  | "workspace-match";

export interface VarinExtensionEntrypointBase {
  activation?: VarinExtensionActivationEvent[];
  file?: string;
}

export interface VarinExtensionHostEntrypoint extends VarinExtensionEntrypointBase {
  file: string;
  mode: VarinExtensionHostMode;
}

export interface VarinExtensionSurfaceEntrypoint extends VarinExtensionEntrypointBase {
  id: string;
  isolation?: VarinExtensionIsolationKind;
  mode: VarinExtensionSurfaceMode;
  supports: VarinApplicationSurface[];
}

export interface VarinExtensionServiceRequirement {
  binding?: "all" | "selected" | "single";
  id: string;
  optional?: boolean;
  version: number;
}

/** One service declaration also supplies its tool projection; read is a claim, never a grant. */
export interface VarinExtensionToolDeclaration {
  name: string;
  description: string;
  inputSchema: JsonObject | boolean;
  outputSchema: JsonObject | boolean;
  completion: "result";
  operation: "read" | "effect";
  examples?: JsonValue[];
  source?: { path: string; line?: number };
}

export interface VarinExtensionServiceProvision {
  id: string;
  multiple?: boolean;
  version: number;
  tool?: VarinExtensionToolDeclaration;
}

export type VarinExtensionContributionKind =
  | "command"
  | "composer-action"
  | "editor"
  | "keybinding"
  | "menu-item"
  | "message-renderer"
  | "page"
  | "panel"
  | "session-decoration"
  | "settings-page"
  | "shell"
  | "sidebar"
  | "status-item"
  | "transition-scene"
  | "tool-renderer"
  | "view";

export interface VarinExtensionContributionPlacement {
  after?: string[];
  before?: string[];
  order?: number;
  slot?: string;
}

export interface VarinExtensionContributionReplacement {
  priority?: number;
  target: string;
}

export interface VarinExtensionStaticContribution {
  contractVersion: number;
  data: JsonObject;
  entrypoint?: string;
  id: string;
  kind: VarinExtensionContributionKind;
  placement?: VarinExtensionContributionPlacement;
  replacement?: VarinExtensionContributionReplacement;
  requiresCapabilities?: string[];
  supports: VarinApplicationSurface[];
  title?: string;
  when?: VarinContextExpressionV1;
}

export interface VarinExtensionManifest {
  capabilities?: {
    host?: string[];
    surface?: string[];
  };
  contributions?: VarinExtensionStaticContribution[];
  displayName?: string;
  engines: {
    varin: string;
  };
  entrypoints?: {
    host?: VarinExtensionHostEntrypoint;
    surfaces?: VarinExtensionSurfaceEntrypoint[];
  };
  id: string;
  integrates?: {
    piPackages?: string[];
  };
  metadata?: {
    description?: string;
    homepage?: string;
    icon?: string;
    keywords?: string[];
    repository?: string;
  };
  provides?: {
    services?: VarinExtensionServiceProvision[];
  };
  requires?: {
    services?: VarinExtensionServiceRequirement[];
  };
  schemaVersion: typeof VARIN_EXTENSION_MANIFEST_SCHEMA_VERSION;
  storage?: {
    schemaVersion: number;
  };
  version: string;
}

export type VarinExtensionPackageSourceKind = "builtin" | "git" | "local" | "npm";

export interface VarinExtensionPackageSource {
  display: string;
  kind: VarinExtensionPackageSourceKind;
  specifier: string;
}

export interface VarinExtensionPublicPackageSource {
  display: string;
  kind: VarinExtensionPackageSourceKind;
}

export interface VarinExtensionCapabilityGrant {
  capability: string;
  granted: boolean;
  manifestVersion: string;
  realm: VarinExtensionRealmKind;
  updatedAt: string;
}

export interface VarinExtensionCapabilityReference {
  capability: string;
  realm: VarinExtensionRealmKind;
}

export interface VarinExtensionCapabilityDelta {
  added: VarinExtensionCapabilityReference[];
  removed: VarinExtensionCapabilityReference[];
}

export interface VarinExtensionCapabilityDecision extends VarinExtensionCapabilityReference {
  granted: boolean;
}

export interface VarinExtensionDesiredState {
  enabled: boolean;
  revision: number;
  updatedAt: string;
}

export type VarinExtensionActualStatus =
  | "active"
  | "activating"
  | "deactivating"
  | "failed"
  | "inactive"
  | "loading"
  | "resolving"
  | "restart-required"
  | "rolling-back"
  | "updating"
  | "waiting";

export type VarinExtensionRealmKind = "host" | "surface";

export interface VarinExtensionDiagnostic {
  code: string;
  extensionId?: string;
  message: string;
  realmId?: string;
  severity: "error" | "info" | "warning";
  timestamp: string;
}

export interface VarinExtensionActualState {
  desiredRevision: number;
  diagnostics: VarinExtensionDiagnostic[];
  entrypointId: string;
  generation: number;
  hostId: string;
  realmId: string;
  realmKind: VarinExtensionRealmKind;
  status: VarinExtensionActualStatus;
  updatedAt: string;
}

export interface VarinExtensionInstallationRecord {
  candidate?: VarinExtensionCandidateRecord;
  capabilityGrants: VarinExtensionCapabilityGrant[];
  desired: VarinExtensionDesiredState;
  installedAt: string;
  integrity?: string;
  manifest: VarinExtensionManifest;
  resolvedVersion: string;
  resolvedPath?: string;
  selectedVersion: string;
  source: VarinExtensionPackageSource;
  updatedAt: string;
}

export interface VarinExtensionCandidateRecord {
  applyRequested: boolean;
  capabilitiesReviewed: boolean;
  capabilityDelta: VarinExtensionCapabilityDelta;
  capabilityGrants: VarinExtensionCapabilityGrant[];
  integrity: string;
  manifest: VarinExtensionManifest;
  preparedAt: string;
  resolvedPath: string;
  resolvedVersion: string;
  source: VarinExtensionPackageSource;
}

export interface VarinExtensionPreparedArtifact {
  integrity: string;
  manifest: VarinExtensionManifest;
  preparedAt: string;
  resolvedPath: string;
  resolvedVersion: string;
  source: VarinExtensionPackageSource;
}

export interface VarinExtensionPublicCandidate {
  applyRequested: boolean;
  capabilitiesReviewed: boolean;
  capabilityDelta: VarinExtensionCapabilityDelta;
  capabilityGrants: VarinExtensionCapabilityGrant[];
  integrity: string;
  manifest: VarinExtensionManifest;
  preparedAt: string;
  resolvedVersion: string;
  source: VarinExtensionPublicPackageSource;
}

export interface VarinExtensionCatalogEntry {
  actual: VarinExtensionActualState[];
  candidate?: VarinExtensionPublicCandidate;
  capabilityGrants: VarinExtensionCapabilityGrant[];
  desired: VarinExtensionDesiredState;
  installedAt: string;
  integrity?: string;
  manifest: VarinExtensionManifest;
  resolvedVersion: string;
  selectedVersion: string;
  source: VarinExtensionPublicPackageSource;
  updatedAt: string;
}

export type VarinExtensionArtifactSlot = "candidate" | "selected";

export interface VarinExtensionAssetRequest {
  extensionId: string;
  integrity: string;
  path: string;
  slot: VarinExtensionArtifactSlot;
}

export interface VarinExtensionAssetPayload {
  artifactIntegrity: string;
  bytesBase64: string;
  contentType: string;
  integrity: string;
  path: string;
}

export interface VarinExtensionManagedEntrypointRequest {
  entrypointId: string;
  extensionId: string;
  integrity: string;
  slot: VarinExtensionArtifactSlot;
}

export interface VarinExtensionManagedEntrypointPayload {
  artifactIntegrity: string;
  entrypointId: string;
  module: VarinExtensionAssetPayload;
  styles: VarinExtensionAssetPayload[];
}

export interface VarinExtensionCandidateSelectionRequest {
  candidateIntegrity: string;
  expectedRevision: number;
  extensionId: string;
}

export interface VarinExtensionCandidateCapabilityReviewRequest {
  candidateIntegrity: string;
  decisions: VarinExtensionCapabilityDecision[];
  expectedRevision: number;
  extensionId: string;
}

export interface VarinExtensionCapabilityReviewRequest {
  decisions: VarinExtensionCapabilityDecision[];
  expectedRevision: number;
  extensionId: string;
}

export interface VarinExtensionPackageInstallRequest {
  expectedRevision: number;
  source: VarinExtensionPackageSource;
}

export interface VarinExtensionLocalSourceReloadRequest {
  expectedRevision: number;
  extensionId: string;
}

export type VarinExtensionLocalSourceReloadResult =
  | {
      outcome: "unchanged";
      snapshot: VarinExtensionCatalogSnapshot;
    }
  | {
      candidateIntegrity: string;
      outcome: "staged";
      snapshot: VarinExtensionCatalogSnapshot;
    };

export interface VarinExtensionRemoveRequest {
  deleteData: boolean;
  expectedRevision: number;
  extensionId: string;
}

export type VarinExtensionServiceProviderStatus = "active" | "candidate" | "draining";

export interface VarinExtensionServiceProviderSnapshot {
  descriptor: VarinExtensionServiceProvision;
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  providerId: string;
  providerKey: string;
  status: VarinExtensionServiceProviderStatus;
}

export interface VarinExtensionServiceCatalogSnapshot {
  hostId: string;
  providers: VarinExtensionServiceProviderSnapshot[];
  revision: number;
  selections: Record<string, string>;
}

export interface VarinExtensionServiceInvocationRequest {
  args: JsonValue[];
  method: string;
  providerId?: string;
  routing?: import("./service-routing.js").VarinExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface VarinExtensionServiceSelectionRequest {
  providerId: string | null;
  serviceId: string;
  version: number;
}

export interface VarinExtensionCandidatePreparationResult {
  extensionId: string;
  integrity: string;
  providers: VarinExtensionServiceProviderSnapshot[];
}

export interface VarinExtensionHostStateSnapshot {
  catalog: VarinExtensionCatalogSnapshot;
  revision: number;
  services: VarinExtensionServiceCatalogSnapshot;
  routing: import("./service-routing.js").VarinExtensionServiceRoutingSnapshot;
  workbench: import("./workbench.js").VarinWorkbenchProfileSnapshot;
}

export interface VarinExtensionHostStateWaitRequest {
  hostId: string;
  revision: number;
}

export type VarinExtensionStorageScope = "application" | "profile" | "session" | "surface" | "workspace";

export interface VarinExtensionStorageAddress {
  extensionId: string;
  key: string;
  scope: VarinExtensionStorageScope;
}

export interface VarinExtensionStorageOpenRequest {
  key: string;
  schemaVersion?: number;
  scope: VarinExtensionStorageScope;
}

export interface VarinExtensionStorageDocument {
  data: JsonObject;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
}

export interface VarinExtensionStorageSnapshot {
  address: VarinExtensionStorageAddress;
  authoritative: boolean;
  diagnostics: VarinExtensionDiagnostic[];
  document: VarinExtensionStorageDocument;
  exists: boolean;
  storageState: "missing" | "ready" | "stale";
}

export type VarinExtensionCatalogStorageState = "missing" | "ready" | "stale";

export interface VarinExtensionCatalogSnapshot {
  authoritative: boolean;
  diagnostics: VarinExtensionDiagnostic[];
  extensions: VarinExtensionCatalogEntry[];
  hostId: string;
  loadedAt: string;
  revision: number;
  schemaVersion: typeof VARIN_EXTENSION_CATALOG_SCHEMA_VERSION;
  storageState: VarinExtensionCatalogStorageState;
}

export interface VarinExtensionCatalogError {
  code: string;
  message: string;
  retryable: boolean;
}

export type VarinExtensionCatalogAvailability =
  | {
      supported: false;
      reason: string;
    }
  | {
      error: VarinExtensionCatalogError;
      supported: true;
      status: "error";
    }
  | {
      snapshot: VarinExtensionCatalogSnapshot;
      supported: true;
      status: "ready";
    };

export interface VarinExtensionCatalogDocument {
  extensions: Record<string, VarinExtensionInstallationRecord>;
  revision: number;
  schemaVersion: typeof VARIN_EXTENSION_CATALOG_SCHEMA_VERSION;
  updatedAt: string;
}

export interface VarinExtensionHostIdentityDocument {
  createdAt: string;
  hostId: string;
  schemaVersion: typeof VARIN_EXTENSION_CATALOG_SCHEMA_VERSION;
}

export interface VarinExtensionPackageCandidate {
  integrity?: string;
  manifest: VarinExtensionManifest;
  resolvedPath: string;
  source: VarinExtensionPackageSource;
}
