import type { VarinExtensionRestartCommit } from "@varin/extension-contract";
import {
  assertVarinApplicationVersion,
  assertVarinExtensionManifestCompatibility,
  parseVarinExtensionAssetRequest,
  parseVarinExtensionCandidateSelectionRequest,
  parseVarinExtensionManagedEntrypointRequest,
  parseVarinRuntimeSourceRequest,
  VARIN_RUNTIME_SOURCE_FAILURES,
  type VarinRuntimeSourceFailureCode,
  type VarinRuntimeSourceRequest,
  type VarinRuntimeSourceResult,
  type VarinExtensionActualState,
  type VarinExtensionAssetPayload,
  type VarinExtensionAssetRequest,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionInstallationRecord,
  type VarinExtensionManagedEntrypointPayload,
  type VarinExtensionManagedEntrypointRequest,
  type VarinExtensionLocalSourceReloadRequest,
  type VarinExtensionLocalSourceReloadResult,
  type VarinExtensionManifest,
  type VarinExtensionPackageSource,
  type VarinExtensionPreparedArtifact,
  type VarinExtensionSourceViewProvenance,
  type VarinExtensionPackageResult,
} from "@varin/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import {
  VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE,
  VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS,
} from "@varin/extension-builtins/host";
import type { VarinBuiltinExtensionDefinition } from "@varin/extension-builtins";
import { ExtensionArtifactStore } from "./artifact-store.js";
import type { BrokeredHostEntrypointArtifact } from "./artifact-store.js";
import { ExtensionCatalogRevisionConflictError } from "./errors.js";

class ArtifactSelectionError extends Error {
  constructor(readonly code: VarinRuntimeSourceFailureCode, message: string) { super(message); }
}

export interface ExtensionPackageManagerOptions {
  artifacts?: ExtensionArtifactStore;
  catalog: ApplicationExtensionCatalog;
  dataDir: string;
  varinVersion: string;
}

export class ExtensionPackageManager {
  readonly artifacts: ExtensionArtifactStore;
  readonly catalog: ApplicationExtensionCatalog;
  readonly varinVersion: string;
  readonly #verifiedBuiltinArtifacts = new Set<string>();

  constructor(options: ExtensionPackageManagerOptions) {
    this.catalog = options.catalog;
    this.varinVersion = options.varinVersion;
    assertVarinApplicationVersion(this.varinVersion);
    this.artifacts = options.artifacts ?? new ExtensionArtifactStore({
      builtinRoots: VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS,
      dataDir: options.dataDir,
      varinVersion: options.varinVersion,
    });
    if (this.artifacts.varinVersion !== this.varinVersion) {
      throw new Error("Extension artifact store targets another Varin application version");
    }
  }

  async installOrStage(
    source: VarinExtensionPackageSource,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const candidate = await this.artifacts.prepare(source, signal);
    return this.#installPrepared(candidate, expectedRevision, false, signal);
  }

  async stageCaptured(directory: string, provenance: VarinExtensionSourceViewProvenance, expectedRevision: number,
    signal?: AbortSignal, onMutation?: () => void): Promise<VarinExtensionPackageResult> {
    const artifact = await this.artifacts.prepareCaptured(directory, provenance, signal);
    const snapshot = await this.#installPrepared(artifact, expectedRevision, true, signal, onMutation);
    const installed = snapshot.extensions.find(entry => entry.manifest.id === artifact.manifest.id)!;
    const staged = installed.candidate?.integrity === artifact.integrity;
    return { outcome: staged ? "candidate_staged" : "installed_disabled", extensionId: artifact.manifest.id,
      artifactIntegrity: artifact.integrity, catalogRevision: snapshot.revision, applicationRequested: false, resumesOnRestart: false };
  }

  async #installPrepared(candidate: VarinExtensionPreparedArtifact, expectedRevision: number,
    forceDisabled: boolean, signal?: AbortSignal, onMutation?: () => void): Promise<VarinExtensionCatalogSnapshot> {
    signal?.throwIfAborted();
    assertVarinExtensionManifestCompatibility(candidate.manifest, this.varinVersion);
    const current = await this.catalog.store.read();
    if (current.document.revision !== expectedRevision) {
      // Use the catalog mutation to raise the normal revision-conflict error and keep one failure envelope.
      return this.catalog.stageCandidate(candidate, expectedRevision);
    }
    const installed = current.document.extensions[candidate.manifest.id];
    if (installed?.source.kind === "builtin" && candidate.source.kind !== "builtin") {
      throw new Error(`Built-in Varin extensions are managed by the distribution: ${candidate.manifest.id}`);
    }
    signal?.throwIfAborted();
    if (installed) { onMutation?.(); return this.catalog.stageCandidate(candidate, expectedRevision); }
    const now = new Date().toISOString();
    const requestsCapabilities = (candidate.manifest.capabilities?.host?.length ?? 0) > 0
      || (candidate.manifest.capabilities?.surface?.length ?? 0) > 0;
    const record: VarinExtensionInstallationRecord = {
      capabilityGrants: [],
      desired: { enabled: !forceDisabled && !requestsCapabilities, revision: 1, updatedAt: now },
      installedAt: now,
      integrity: candidate.integrity,
      manifest: candidate.manifest,
      resolvedPath: candidate.resolvedPath,
      resolvedVersion: candidate.resolvedVersion,
      selectedVersion: candidate.resolvedVersion,
      source: candidate.source,
      updatedAt: now,
    };
    onMutation?.();
    return this.catalog.upsert(record, expectedRevision);
  }

  async reconcileBuiltinArtifacts(
    definitions: readonly VarinBuiltinExtensionDefinition[],
    snapshot: VarinExtensionCatalogSnapshot,
  ): Promise<VarinExtensionCatalogSnapshot> {
    let current = snapshot;
    for (const definition of definitions) {
      if (!definition.manifest.entrypoints?.host) continue;
      const catalogState = await this.catalog.store.read();
      const existing = catalogState.document.extensions[definition.manifest.id];
      const distributionFingerprint = await this.artifacts.builtinDistributionFingerprint(
        definition.manifest.id,
        VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE,
      );
      const verificationKey = existing?.integrity && distributionFingerprint
        ? `${definition.manifest.id}\0${existing.integrity}\0${distributionFingerprint}`
        : null;
      if (
        existing?.source.kind === "builtin"
        && existing.integrity
        && existing.resolvedPath
        && existing.selectedVersion === definition.manifest.version
        && distributionFingerprint
        && (this.#verifiedBuiltinArtifacts.has(verificationKey!)
          || await this.artifacts.builtinArtifactMatchesDistribution({
            artifactIntegrity: existing.integrity,
            artifactRoot: existing.resolvedPath,
            distributionFingerprint,
            fingerprintFile: VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE,
            manifest: existing.manifest,
          }))
      ) {
        this.#verifiedBuiltinArtifacts.add(verificationKey!);
        continue;
      }
      const prepared = await this.artifacts.prepare({
        display: "Varin",
        kind: "builtin",
        specifier: definition.manifest.id,
      });
      current = await this.catalog.selectBuiltinArtifact(prepared);
      if (distributionFingerprint) {
        this.#verifiedBuiltinArtifacts.add(
          `${definition.manifest.id}\0${prepared.integrity}\0${distributionFingerprint}`,
        );
      }
    }
    return current;
  }

  async reloadLocalSource(
    request: VarinExtensionLocalSourceReloadRequest,
    signal?: AbortSignal,
  ): Promise<VarinExtensionLocalSourceReloadResult> {
    const current = await this.catalog.store.read();
    if (!current.authoritative) throw new Error("Cannot reload a local source from a stale extension catalog");
    if (current.document.revision !== request.expectedRevision) {
      throw new ExtensionCatalogRevisionConflictError(request.expectedRevision, current.document.revision);
    }
    const record = current.document.extensions[request.extensionId];
    if (!record) throw new Error(`Varin extension is not installed: ${request.extensionId}`);
    if (record.source.kind !== "local") {
      throw new Error(`Varin extension is not installed from a local source: ${request.extensionId}`);
    }

    const candidate = await this.artifacts.prepare(structuredClone(record.source), signal);
    assertVarinExtensionManifestCompatibility(candidate.manifest, this.varinVersion);
    if (candidate.manifest.id !== request.extensionId) {
      throw new Error(
        `Local Varin extension source now declares ${candidate.manifest.id}; expected ${request.extensionId}`,
      );
    }

    const latest = await this.catalog.snapshot();
    if (!latest.authoritative) throw new Error("Cannot reload a local source from a stale extension catalog");
    if (latest.revision !== request.expectedRevision) {
      throw new ExtensionCatalogRevisionConflictError(request.expectedRevision, latest.revision);
    }
    const selected = latest.extensions.find((entry) => entry.manifest.id === request.extensionId);
    if (!selected) throw new Error(`Varin extension is not installed: ${request.extensionId}`);
    if (selected.source.kind !== "local") {
      throw new Error(`Varin extension is not installed from a local source: ${request.extensionId}`);
    }
    if (selected.integrity === candidate.integrity) return { outcome: "unchanged", snapshot: latest };

    const snapshot = await this.catalog.stageCandidate(candidate, request.expectedRevision);
    return { candidateIntegrity: candidate.integrity, outcome: "staged", snapshot };
  }

  selectCandidate(requestValue: VarinExtensionCandidateSelectionRequest | unknown, validateBeforeCommit?: () => void, restartCommit?: VarinExtensionRestartCommit): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidateSelectionRequest(requestValue);
    return this.catalog.selectCandidate(request.extensionId, request.candidateIntegrity, request.expectedRevision, validateBeforeCommit, restartCommit);
  }

  async readAsset(requestValue: VarinExtensionAssetRequest | unknown): Promise<VarinExtensionAssetPayload> {
    const request = parseVarinExtensionAssetRequest(requestValue);
    const artifact = await this.#artifact(request.extensionId, request.slot, request.integrity, true);
    return this.artifacts.readAsset(artifact.resolvedPath, request.integrity, request.path, artifact.manifest);
  }

  async readSource(requestValue: VarinRuntimeSourceRequest | unknown, signal?: AbortSignal): Promise<VarinRuntimeSourceResult> {
    const request = parseVarinRuntimeSourceRequest(requestValue);
    const { extensionId, slot, artifactIntegrity, path } = request;
    const basis = { action: 'read' as const, kind: 'source' as const, origin: 'immutable_artifact' as const,
      permission: 'checked_on_invocation' as const, extensionId, slot, artifactIntegrity, path };
    signal?.throwIfAborted();
    try {
      const artifact = await this.#artifact(extensionId, slot, artifactIntegrity);
      signal?.throwIfAborted();
      const result = await this.artifacts.readSource(artifact.resolvedPath, request, artifact.manifest, signal);
      signal?.throwIfAborted();
      // Unrelated catalog changes do not restart I/O. A retained old directory is not a current slot.
      await this.#artifact(extensionId, slot, artifactIntegrity);
      signal?.throwIfAborted();
      return { ...basis, ...result };
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ArtifactSelectionError)) throw error;
      return { ...basis, status: VARIN_RUNTIME_SOURCE_FAILURES[error.code], code: error.code } as VarinRuntimeSourceResult;
    }
  }

  async readManagedEntrypoint(
    requestValue: VarinExtensionManagedEntrypointRequest | unknown,
  ): Promise<VarinExtensionManagedEntrypointPayload> {
    const request = parseVarinExtensionManagedEntrypointRequest(requestValue);
    const artifact = await this.#artifact(request.extensionId, request.slot, request.integrity, true);
    return this.artifacts.readManagedEntrypoint(
      artifact.resolvedPath,
      request.integrity,
      request.entrypointId,
      artifact.manifest,
    );
  }

  reportActualState(extensionId: string, state: VarinExtensionActualState): Promise<void> {
    return this.catalog.reportActualState(extensionId, state);
  }

  async resolveBrokeredHostEntrypoint(
    extensionId: string,
    slot: "candidate" | "selected",
    integrity: string,
  ): Promise<BrokeredHostEntrypointArtifact> {
    const artifact = await this.#artifact(extensionId, slot, integrity);
    return this.artifacts.resolveBrokeredHostEntrypoint(artifact.resolvedPath, integrity, artifact.manifest);
  }

  async #artifact(
    extensionId: string,
    slot: "candidate" | "selected",
    integrity: string,
    allowPromotedCandidate = false,
  ): Promise<{ manifest: VarinExtensionManifest; resolvedPath: string }> {
    const read = await this.catalog.store.read();
    if (!read.authoritative) throw new ArtifactSelectionError('catalog_stale', 'Varin extension catalog is stale');
    const record = Object.hasOwn(read.document.extensions, extensionId) ? read.document.extensions[extensionId] : undefined;
    if (!record) throw new ArtifactSelectionError('extension_missing', `Varin extension is not installed: ${extensionId}`);
    // Surface consumers may still hold an admitted candidate asset while that exact
    // content address is promoted. Explicit read/source queries remain slot-strict.
    const promoted = allowPromotedCandidate && slot === "candidate" && record.integrity === integrity;
    const artifact = slot === "candidate" && !promoted ? record.candidate : record;
    if (!artifact) throw new ArtifactSelectionError('candidate_missing', `Varin extension candidate is missing: ${extensionId}`);
    if (!artifact.integrity) throw new ArtifactSelectionError('artifact_unmaterialized', `Varin extension has no immutable artifact: ${extensionId}`);
    if (artifact.integrity !== integrity) throw new ArtifactSelectionError('artifact_changed', `Varin extension ${slot} artifact is no longer current: ${extensionId}`);
    if (!artifact.resolvedPath) throw new ArtifactSelectionError('artifact_unmaterialized', `Varin extension has no immutable artifact: ${extensionId}`);
    return { manifest: artifact.manifest, resolvedPath: artifact.resolvedPath };
  }
}
