import {
  VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
  type VarinExtensionActualState,
  type VarinExtensionCatalogEntry,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionCandidateCapabilityReviewRequest,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCapabilityReviewRequest,
  type VarinExtensionInstallationRecord,
  type VarinExtensionPreparedArtifact,
} from "@varin/extension-contract";
import type { VarinBuiltinExtensionDefinition } from "@varin/extension-builtins";
import { ExtensionCatalogStaleStateError } from "./errors.js";
import { ExtensionCatalogStore, type CatalogReadState } from "./catalog-store.js";

function actualKey(extensionId: string, state: VarinExtensionActualState): string {
  return `${extensionId}\0${state.realmKind}\0${state.realmId}\0${state.entrypointId}`;
}

export class ApplicationExtensionCatalog {
  readonly store: ExtensionCatalogStore;
  readonly #actual = new Map<string, { extensionId: string; state: VarinExtensionActualState }>();

  constructor(options: { dataDir: string; store?: ExtensionCatalogStore }) {
    this.store = options.store ?? new ExtensionCatalogStore(options.dataDir);
  }

  async snapshot(): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([this.store.getHostIdentity(), this.store.read()]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async upsert(record: VarinExtensionInstallationRecord, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.upsert(record, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async remove(extensionId: string, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.remove(extensionId, expectedRevision),
    ]);
    for (const [key, value] of this.#actual) if (value.extensionId === extensionId) this.#actual.delete(key);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setEnabled(extensionId, enabled, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setAllEnabled(enabled: boolean, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setAllEnabled(enabled, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setEnabledSet(extensionIds: readonly string[], expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setEnabledSet(extensionIds, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reconcileBuiltins(
    definitions: readonly VarinBuiltinExtensionDefinition[],
    ownedPrefix: string,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reconcileBuiltins(definitions, ownedPrefix),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setCapabilityGrant(
    extensionId: string,
    grant: VarinExtensionCapabilityGrant,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setCapabilityGrant(extensionId, grant, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reviewCapabilities(
    request: VarinExtensionCapabilityReviewRequest,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reviewCapabilities(request.extensionId, request.decisions, request.expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async stageCandidate(candidate: VarinExtensionPreparedArtifact, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.stageCandidate(candidate, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async selectBuiltinArtifact(candidate: VarinExtensionPreparedArtifact): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.selectBuiltinArtifact(candidate),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reviewCandidateCapabilities(
    request: VarinExtensionCandidateCapabilityReviewRequest,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reviewCandidateCapabilities(
        request.extensionId,
        request.candidateIntegrity,
        request.decisions,
        request.expectedRevision,
      ),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async selectCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.selectCandidate(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async requestCandidateApplication(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.requestCandidateApplication(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async discardCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.discardCandidate(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  /** Append a cleanup outcome to the existing actual-owner diagnostics without replacing a newer generation. */
  async recordHostCleanupUnconfirmed(extensionId: string, ownerGeneration: number): Promise<void> {
    const snapshot = await this.snapshot();
    const entry = snapshot.extensions.find(item => item.manifest.id === extensionId);
    if (!entry) return;
    const current = [...this.#actual.values()].find(value => value.extensionId === extensionId && value.state.realmKind === "host");
    const state: VarinExtensionActualState = current?.state ?? {
      desiredRevision: entry.desired.revision, diagnostics: [], entrypointId: "host", generation: ownerGeneration,
      hostId: snapshot.hostId, realmId: "application-host", realmKind: "host", status: "inactive", updatedAt: new Date().toISOString(),
    };
    const updated = { ...state, diagnostics: [...state.diagnostics, {
      code: "broker_cleanup_unconfirmed", message: `Broker generation ${ownerGeneration} exited; extension cleanup was not confirmed`,
      severity: "error" as const, timestamp: new Date().toISOString(),
    }] };
    this.#actual.set(actualKey(extensionId, updated), { extensionId, state: updated });
  }

  async reportActualState(extensionId: string, state: VarinExtensionActualState): Promise<void> {
    const snapshot = await this.snapshot();
    if (state.hostId !== snapshot.hostId) throw new ExtensionCatalogStaleStateError("Actual state belongs to another application host");
    const entry = snapshot.extensions.find((item) => item.manifest.id === extensionId);
    if (!entry) throw new ExtensionCatalogStaleStateError(`Actual state belongs to an uninstalled extension: ${extensionId}`);
    if (state.desiredRevision !== entry.desired.revision) {
      throw new ExtensionCatalogStaleStateError(`Actual state desired revision ${state.desiredRevision} is stale; current revision is ${entry.desired.revision}`);
    }
    const key = actualKey(extensionId, state);
    const previous = this.#actual.get(key)?.state;
    if (previous && state.generation < previous.generation) {
      throw new ExtensionCatalogStaleStateError(`Actual state generation ${state.generation} is stale; current generation is ${previous.generation}`);
    }
    this.#actual.set(key, { extensionId, state: structuredClone(state) });
  }

  #publicSnapshot(hostId: string, read: CatalogReadState): VarinExtensionCatalogSnapshot {
    const extensions = Object.values(read.document.extensions)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map<VarinExtensionCatalogEntry>((record) => {
        const actual = [...this.#actual.values()]
          .filter((value) => (
            value.extensionId === record.manifest.id
            && value.state.hostId === hostId
            && value.state.desiredRevision === record.desired.revision
          ))
          .map((value) => structuredClone(value.state))
          .sort((left, right) => left.realmId.localeCompare(right.realmId) || left.entrypointId.localeCompare(right.entrypointId));
        return {
          actual,
          ...(record.candidate ? {
            candidate: {
              applyRequested: record.candidate.applyRequested,
              capabilitiesReviewed: record.candidate.capabilitiesReviewed,
              capabilityDelta: structuredClone(record.candidate.capabilityDelta),
              capabilityGrants: structuredClone(record.candidate.capabilityGrants),
              integrity: record.candidate.integrity,
              manifest: structuredClone(record.candidate.manifest),
              preparedAt: record.candidate.preparedAt,
              resolvedVersion: record.candidate.resolvedVersion,
              source: {
                display: record.candidate.source.display,
                kind: record.candidate.source.kind,
              },
            },
          } : {}),
          capabilityGrants: structuredClone(record.capabilityGrants),
          desired: structuredClone(record.desired),
          installedAt: record.installedAt,
          manifest: structuredClone(record.manifest),
          resolvedVersion: record.resolvedVersion,
          selectedVersion: record.selectedVersion,
          source: { display: record.source.display, kind: record.source.kind },
          updatedAt: record.updatedAt,
          ...(record.integrity ? { integrity: record.integrity } : {}),
        };
      });
    return {
      authoritative: read.authoritative,
      diagnostics: structuredClone(read.diagnostics),
      extensions,
      hostId,
      loadedAt: new Date().toISOString(),
      revision: read.document.revision,
      schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
      storageState: read.storageState,
    };
  }
}
