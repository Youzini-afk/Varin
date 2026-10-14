import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
  VarinExtensionContractError,
  parseVarinExtensionManifest,
  parseVarinExtensionCatalogDocument,
  parseVarinExtensionHostIdentityDocument,
  parseVarinExtensionInstallationRecord,
  type VarinExtensionRestartHandoff,
  type VarinExtensionRestartCommit,
  type VarinExtensionCatalogDocument,
  type VarinExtensionCapabilityDecision,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCapabilityReference,
  type VarinExtensionDiagnostic,
  type VarinExtensionHostIdentityDocument,
  type VarinExtensionInstallationRecord,
  type VarinExtensionManifest,
  type VarinExtensionPreparedArtifact,
} from "@varin/extension-contract";
import type { VarinBuiltinExtensionDefinition } from "@varin/extension-builtins";
import {
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from "./errors.js";

const LOCK_RETRY_MS = 25;

interface CatalogReadState {
  authoritative: boolean;
  diagnostics: VarinExtensionDiagnostic[];
  document: VarinExtensionCatalogDocument;
  storageState: "missing" | "ready" | "stale";
}

interface LastValidCatalog {
  document: VarinExtensionCatalogDocument;
  fingerprint: string;
  storageState: "missing" | "ready";
}

interface ParsedBuiltinDefinition {
  definition: VarinBuiltinExtensionDefinition;
  manifest: VarinExtensionManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (handle) {
      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
        await handle.sync();
        return async () => {
          await handle.close();
          try {
            const owner = JSON.parse(await readFile(path, "utf8")) as unknown;
            if (isRecord(owner) && owner.token === token) await rm(path, { force: true });
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    let removeAbandoned = false;
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as unknown;
      removeAbandoned = !isRecord(owner) || !processIsAlive(Number(owner.pid));
    } catch (readError) {
      if (errorCode(readError) === "ENOENT") continue;
      try {
        const info = await stat(path);
        removeAbandoned = Date.now() - info.mtimeMs > 2_000;
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") continue;
        throw statError;
      }
    }
    if (removeAbandoned) {
      const abandoned = `${path}.abandoned.${process.pid}.${randomUUID()}`;
      try {
        await rename(path, abandoned);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      await rm(abandoned, { force: true });
      continue;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
}

function emptyDocument(): VarinExtensionCatalogDocument {
  return {
    extensions: {},
    revision: 0,
    schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
  };
}

function cloneDocument(document: VarinExtensionCatalogDocument): VarinExtensionCatalogDocument {
  return structuredClone(document);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Varin extension catalog contains a non-JSON value");
}

function fingerprint(document: VarinExtensionCatalogDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

function diagnostic(code: string, message: string): VarinExtensionDiagnostic {
  return { code, message, severity: "error", timestamp: new Date().toISOString() };
}

const capabilityKey = (value: VarinExtensionCapabilityReference): string => `${value.realm}:${value.capability}`;

function manifestCapabilities(manifest: VarinExtensionManifest): VarinExtensionCapabilityReference[] {
  return (["host", "surface"] as const).flatMap((realm) => (
    (manifest.capabilities?.[realm] ?? []).map((capability) => ({ capability, realm }))
  ));
}

function builtinCapabilityGrants(
  manifest: VarinExtensionManifest,
  updatedAt: string,
): VarinExtensionCapabilityGrant[] {
  return manifestCapabilities(manifest).map((reference) => ({
    ...reference,
    granted: true,
    manifestVersion: manifest.version,
    updatedAt,
  }));
}

function sameCapabilityGrants(
  left: readonly VarinExtensionCapabilityGrant[],
  right: readonly VarinExtensionCapabilityGrant[],
): boolean {
  const project = (values: readonly VarinExtensionCapabilityGrant[]) => values
    .map(({ capability, granted, manifestVersion, realm }) => ({ capability, granted, manifestVersion, realm }))
    .sort((first, second) => capabilityKey(first).localeCompare(capabilityKey(second)));
  return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function capabilitiesReviewed(record: VarinExtensionInstallationRecord): boolean {
  if (record.source.kind === "builtin") return true;
  const decided = new Set(record.capabilityGrants
    .filter((grant) => grant.manifestVersion === record.manifest.version)
    .map(capabilityKey));
  return manifestCapabilities(record.manifest).every((reference) => decided.has(capabilityKey(reference)));
}

function assertCanEnable(record: VarinExtensionInstallationRecord): void {
  if (!capabilitiesReviewed(record)) {
    throw new Error(`Varin extension capabilities require review before activation: ${record.manifest.id}`);
  }
}

function assertRestartCandidate(record: VarinExtensionInstallationRecord, handoff: VarinExtensionRestartHandoff): void {
  const candidate = record.candidate;
  if (!record.desired.enabled || record.desired.revision !== handoff.desiredRevision
    || record.integrity !== handoff.selectedIntegrity || record.selectedVersion !== handoff.selectedVersion
    || !candidate?.capabilitiesReviewed || candidate.integrity !== handoff.candidateIntegrity
    || !sameCapabilityGrants(candidate.capabilityGrants, handoff.capabilityGrants)
    || JSON.stringify(candidate.manifest.updateReadiness?.surfaceEntrypoints ?? []) !== JSON.stringify(handoff.surfaceEntrypoints)) {
    throw new Error('Restart handoff candidate, selection, review, or desired state changed');
  }
}

function failPendingRestart(record: VarinExtensionInstallationRecord, now: string, code: string, message: string): void {
  const handoff = record.restartHandoffs?.at(-1);
  if (handoff && ['pending-restart', 'preparing', 'waiting-surface'].includes(handoff.status)) {
    Object.assign(handoff, { status: 'failed', updatedAt: now, failure: { code, message } });
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ExtensionCatalogStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly catalogPath: string;
  readonly identityPath: string;
  readonly #lockPath: string;
  #lastValid: LastValidCatalog | null = null;
  #identity: VarinExtensionHostIdentityDocument | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.directory = join(this.dataDir, "extensions");
    this.catalogPath = join(this.directory, "catalog.json");
    this.identityPath = join(this.directory, "identity.json");
    this.#lockPath = join(this.directory, ".catalog.lock");
  }

  getHostIdentity(): Promise<VarinExtensionHostIdentityDocument> {
    return this.#serialize(async () => this.#readOrCreateIdentity());
  }

  read(): Promise<CatalogReadState> {
    return this.#serialize(async () => {
      await this.#readOrCreateIdentity();
      return this.#readPreservingAuthority();
    });
  }

  upsert(recordValue: VarinExtensionInstallationRecord, expectedRevision: number): Promise<CatalogReadState> {
    const record = parseVarinExtensionInstallationRecord(recordValue);
    return this.#mutate(expectedRevision, (document) => {
      document.extensions[record.manifest.id] = record;
      return true;
    });
  }

  remove(extensionId: string, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document) => {
      if (!(extensionId in document.extensions)) return false;
      delete document.extensions[extensionId];
      return true;
    });
  }

  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if (record.desired.enabled === enabled) return false;
      if (enabled) assertCanEnable(record);
      record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
      record.updatedAt = now;
      return true;
    });
  }

  setAllEnabled(enabled: boolean, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      let changed = false;
      for (const record of Object.values(document.extensions)) {
        if (record.desired.enabled === enabled) continue;
        if (enabled) assertCanEnable(record);
        record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
        record.updatedAt = now;
        changed = true;
      }
      return changed;
    });
  }

  setEnabledSet(extensionIds: readonly string[], expectedRevision: number): Promise<CatalogReadState> {
    const selected = new Set(extensionIds);
    return this.#mutate(expectedRevision, (document, now) => {
      let changed = false;
      for (const [extensionId, record] of Object.entries(document.extensions)) {
        const enabled = selected.has(extensionId);
        if (record.desired.enabled === enabled) continue;
        if (enabled) assertCanEnable(record);
        record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
        record.updatedAt = now;
        changed = true;
      }
      return changed;
    });
  }

  reconcileBuiltins(
    definitions: readonly VarinBuiltinExtensionDefinition[],
    ownedPrefix: string,
  ): Promise<CatalogReadState> {
    const manifests: ParsedBuiltinDefinition[] = definitions.map((definition) => ({
      definition,
      manifest: parseVarinExtensionManifest(definition.manifest),
    }));
    const desiredIds = new Set(manifests.map(({ manifest }) => manifest.id));
    return this.#mutateCurrent((document, now) => {
      let changed = false;
      for (const [extensionId, record] of Object.entries(document.extensions)) {
        if (
          record.source.kind === "builtin"
          && record.source.specifier.startsWith(ownedPrefix)
          && !desiredIds.has(extensionId)
        ) {
          delete document.extensions[extensionId];
          changed = true;
        }
      }
      for (const { definition, manifest } of manifests) {
        const existing = document.extensions[manifest.id];
        if (!existing) {
          document.extensions[manifest.id] = {
            capabilityGrants: builtinCapabilityGrants(manifest, now),
            desired: { enabled: definition.enabledByDefault, revision: 1, updatedAt: now },
            installedAt: now,
            manifest: structuredClone(manifest),
            resolvedVersion: manifest.version,
            selectedVersion: manifest.version,
            source: { display: "Varin", kind: "builtin", specifier: manifest.id },
            updatedAt: now,
          };
          changed = true;
          continue;
        }
        if (existing.source.kind !== "builtin" || existing.source.specifier !== manifest.id) {
          throw new Error(`Varin built-in extension ID is already owned by another source: ${manifest.id}`);
        }
        const nextManifest = JSON.stringify(manifest);
        const desiredGrants = builtinCapabilityGrants(manifest, now);
        if (
          JSON.stringify(existing.manifest) === nextManifest
          && existing.resolvedVersion === manifest.version
          && existing.selectedVersion === manifest.version
          && existing.source.display === "Varin"
          && existing.candidate === undefined
          && sameCapabilityGrants(existing.capabilityGrants, desiredGrants)
        ) continue;
        const artifactVersionChanged = existing.resolvedVersion !== manifest.version
          || existing.selectedVersion !== manifest.version;
        const manifestChanged = JSON.stringify(existing.manifest) !== nextManifest;
        existing.manifest = structuredClone(manifest);
        existing.resolvedVersion = manifest.version;
        existing.selectedVersion = manifest.version;
        existing.source = { display: "Varin", kind: "builtin", specifier: manifest.id };
        existing.capabilityGrants = desiredGrants;
        delete existing.candidate;
        if (manifestChanged || artifactVersionChanged) {
          delete existing.integrity;
          delete existing.resolvedPath;
        }
        existing.updatedAt = now;
        changed = true;
      }
      return changed;
    });
  }

  selectBuiltinArtifact(candidate: VarinExtensionPreparedArtifact): Promise<CatalogReadState> {
    return this.#mutateCurrent((document, now) => {
      const record = document.extensions[candidate.manifest.id];
      if (!record || record.source.kind !== "builtin" || record.source.specifier !== candidate.manifest.id) {
        throw new Error(`Varin built-in extension is not reconciled: ${candidate.manifest.id}`);
      }
      if (candidate.source.kind !== "builtin" || candidate.source.specifier !== candidate.manifest.id) {
        throw new Error(`Varin built-in artifact source is invalid: ${candidate.manifest.id}`);
      }
      if (JSON.stringify(record.manifest) !== JSON.stringify(candidate.manifest)) {
        throw new Error(`Varin built-in artifact manifest does not match the distribution: ${candidate.manifest.id}`);
      }
      if (
        record.integrity === candidate.integrity
        && record.resolvedPath === candidate.resolvedPath
        && record.resolvedVersion === candidate.resolvedVersion
        && record.selectedVersion === candidate.resolvedVersion
      ) return false;
      record.integrity = candidate.integrity;
      record.resolvedPath = candidate.resolvedPath;
      record.resolvedVersion = candidate.resolvedVersion;
      record.selectedVersion = candidate.resolvedVersion;
      record.updatedAt = now;
      return true;
    });
  }

  setCapabilityGrant(
    extensionId: string,
    grant: VarinExtensionCapabilityGrant,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if ((grant.realm !== "host" && grant.realm !== "surface") || typeof grant.granted !== "boolean") {
        throw new Error("Capability grant realm and granted state are invalid");
      }
      if (grant.manifestVersion !== record.manifest.version) {
        throw new Error(`Capability grant version ${grant.manifestVersion} does not match installed manifest ${record.manifest.version}`);
      }
      const requested = record.manifest.capabilities?.[grant.realm] ?? [];
      if (!requested.includes(grant.capability)) {
        throw new Error(`Capability was not requested by ${extensionId}: ${grant.realm}:${grant.capability}`);
      }
      const next = { ...grant, updatedAt: now };
      const index = record.capabilityGrants.findIndex((item) => (
        item.capability === grant.capability && item.realm === grant.realm
      ));
      const previous = index >= 0 ? record.capabilityGrants[index] : undefined;
      if (previous?.granted === grant.granted && previous.manifestVersion === grant.manifestVersion) return false;
      if (index >= 0) record.capabilityGrants[index] = next;
      else record.capabilityGrants.push(next);
      record.desired = { ...record.desired, revision: record.desired.revision + 1, updatedAt: now };
      record.updatedAt = now;
      return true;
    });
  }

  reviewCapabilities(
    extensionId: string,
    decisions: readonly VarinExtensionCapabilityDecision[],
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if (record.source.kind === "builtin") {
        throw new Error(`Built-in Varin extensions are managed by the distribution: ${extensionId}`);
      }
      const requested = new Set(manifestCapabilities(record.manifest).map(capabilityKey));
      let changed = false;
      for (const decision of decisions) {
        const key = capabilityKey(decision);
        if (!requested.has(key)) throw new Error(`Capability was not requested by ${extensionId}: ${key}`);
        const next: VarinExtensionCapabilityGrant = {
          ...decision,
          manifestVersion: record.manifest.version,
          updatedAt: now,
        };
        const index = record.capabilityGrants.findIndex((grant) => capabilityKey(grant) === key);
        const previous = index >= 0 ? record.capabilityGrants[index] : undefined;
        if (previous?.granted === next.granted && previous.manifestVersion === next.manifestVersion) continue;
        changed = true;
        if (index >= 0) record.capabilityGrants[index] = next;
        else record.capabilityGrants.push(next);
      }
      if (changed) {
        record.desired = { ...record.desired, revision: record.desired.revision + 1, updatedAt: now };
        record.updatedAt = now;
      }
      return changed;
    });
  }

  stageCandidate(candidate: VarinExtensionPreparedArtifact, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[candidate.manifest.id];
      if (!record) throw new Error(`Varin extension is not installed: ${candidate.manifest.id}`);
      if (record.candidate?.integrity === candidate.integrity) return false;
      const selectedCapabilities = new Set(manifestCapabilities(record.manifest).map(capabilityKey));
      const candidateCapabilities = manifestCapabilities(candidate.manifest);
      const candidateKeys = new Set(candidateCapabilities.map(capabilityKey));
      const added = candidateCapabilities.filter((reference) => !selectedCapabilities.has(capabilityKey(reference)));
      const removed = manifestCapabilities(record.manifest).filter((reference) => !candidateKeys.has(capabilityKey(reference)));
      const capabilityGrants = record.capabilityGrants
        .filter((grant) => candidateKeys.has(capabilityKey(grant)))
        .map((grant) => ({ ...grant, manifestVersion: candidate.manifest.version, updatedAt: now }));
      failPendingRestart(record, now, 'candidate_replaced', 'The restart candidate was replaced');
      record.candidate = {
        ...structuredClone(candidate),
        applyRequested: false,
        capabilitiesReviewed: added.length === 0,
        capabilityDelta: { added, removed },
        capabilityGrants,
      };
      record.updatedAt = now;
      return true;
    });
  }

  reviewCandidateCapabilities(
    extensionId: string,
    candidateIntegrity: string,
    decisions: readonly VarinExtensionCapabilityDecision[],
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      const candidate = record.candidate;
      if (!candidate || candidate.integrity !== candidateIntegrity) {
        throw new Error(`Varin extension candidate is no longer current: ${extensionId}`);
      }
      const added = new Set(candidate.capabilityDelta.added.map(capabilityKey));
      for (const decision of decisions) {
        const key = capabilityKey(decision);
        if (!added.has(key)) throw new Error(`Capability is not newly requested by the candidate: ${key}`);
        const next: VarinExtensionCapabilityGrant = {
          capability: decision.capability,
          granted: decision.granted,
          manifestVersion: candidate.manifest.version,
          realm: decision.realm,
          updatedAt: now,
        };
        const index = candidate.capabilityGrants.findIndex((grant) => capabilityKey(grant) === key);
        if (index >= 0) candidate.capabilityGrants[index] = next;
        else candidate.capabilityGrants.push(next);
      }
      const decided = new Set(candidate.capabilityGrants.map(capabilityKey));
      candidate.capabilitiesReviewed = [...added].every((key) => decided.has(key));
      record.updatedAt = now;
      return decisions.length > 0;
    });
  }

  selectCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
    validateBeforeCommit?: () => void,
    restartCommit?: VarinExtensionRestartCommit,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      const candidate = record.candidate;
      if (!candidate || candidate.integrity !== candidateIntegrity) {
        throw new Error(`Varin extension candidate is no longer current: ${extensionId}`);
      }
      if (!candidate.capabilitiesReviewed) {
        throw new Error(`Varin extension candidate capability changes require review: ${extensionId}`);
      }
      if (!candidate.applyRequested) {
        throw new Error(`Varin extension candidate application was not requested: ${extensionId}`);
      }
      const handoff = record.restartHandoffs?.at(-1);
      if (handoff && !['applied', 'restored'].includes(handoff.status)) {
        if (!restartCommit || handoff.id !== restartCommit.id || handoff.executionProcessId !== restartCommit.processId
          || !['preparing', 'waiting-surface'].includes(handoff.status)) throw new Error('Restart handoff is not prepared in this process');
        assertRestartCandidate(record, handoff);
        if (handoff.surfaceEntrypoints.length && restartCommit.surfaceReadiness?.preparedConsumerCount === undefined) throw new Error('Restart handoff requires the original Surface consumer preparation receipt');
        handoff.status = 'applied';
        handoff.updatedAt = now;
        if (restartCommit.surfaceReadiness) handoff.surfaceReadiness = structuredClone(restartCommit.surfaceReadiness);
      }
      // Pure Host-owned readiness/owner check after the real catalog lock and CAS checks.
      validateBeforeCommit?.();
      record.manifest = structuredClone(candidate.manifest);
      record.source = structuredClone(candidate.source);
      record.integrity = candidate.integrity;
      record.resolvedPath = candidate.resolvedPath;
      record.resolvedVersion = candidate.resolvedVersion;
      record.selectedVersion = candidate.resolvedVersion;
      record.capabilityGrants = structuredClone(candidate.capabilityGrants);
      delete record.candidate;
      record.updatedAt = now;
      return true;
    });
  }

  requestCandidateApplication(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      const candidate = record.candidate;
      if (!candidate || candidate.integrity !== candidateIntegrity) {
        throw new Error(`Varin extension candidate is no longer current: ${extensionId}`);
      }
      if (!candidate.capabilitiesReviewed) {
        throw new Error(`Varin extension candidate capability changes require review: ${extensionId}`);
      }
      if (candidate.applyRequested) return false;
      candidate.applyRequested = true;
      record.updatedAt = now;
      return true;
    });
  }

  discardCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if (!record.candidate || record.candidate.integrity !== candidateIntegrity) return false;
      failPendingRestart(record, now, 'candidate_discarded', 'The restart candidate was discarded');
      delete record.candidate;
      record.updatedAt = now;
      return true;
    });
  }

  requestRestartHandoff(extensionId: string, handoff: VarinExtensionRestartHandoff, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if (record.restartHandoffs?.some(value => value.id === handoff.id)) throw new Error('Restart handoff identity already exists');
      if (record.restartHandoffs?.some(value => !['applied', 'failed', 'restored'].includes(value.status))) throw new Error('A restart handoff is already pending');
      assertRestartCandidate(record, handoff);
      if (record.candidate?.manifest.entrypoints?.host?.mode !== 'native' && record.manifest.entrypoints?.host?.mode !== 'native') throw new Error('Restart handoff requires a trusted-native Host entrypoint');
      record.candidate!.applyRequested = true;
      (record.restartHandoffs ??= []).push(structuredClone(handoff));
      record.updatedAt = now;
      return true;
    });
  }

  /** CAS retries only on unrelated Catalog writers; terminal original results always win. */
  async transitionRestartHandoff(extensionId: string, id: string, from: VarinExtensionRestartHandoff['status'][],
    update: Partial<Pick<VarinExtensionRestartHandoff, 'status' | 'executionProcessId' | 'restoreRequestedProcessId' | 'failure'>>,
    expectedRevision?: number): Promise<CatalogReadState> {
    for (;;) {
      const revision = expectedRevision ?? (await this.read()).document.revision;
      try {
        return await this.#mutate(revision, (document, now) => {
          const record = document.extensions[extensionId];
          const handoff = record?.restartHandoffs?.find(value => value.id === id);
          if (!record || !handoff) throw new Error('Restart handoff is no longer available');
          if (!from.includes(handoff.status)) return false;
          if (update.status === 'preparing') assertRestartCandidate(record, handoff);
          if (['preparing', 'restore-pending-restart', 'restored'].includes(update.status ?? '') && record.restartHandoffs?.at(-1)?.id !== id) throw new Error('A newer restart handoff owns this extension');
          if (update.status === 'restore-pending-restart' || update.status === 'restored') {
            if (record.integrity !== handoff.selectedIntegrity) throw new Error('The original selected artifact changed');
            if (record.candidate?.integrity === handoff.candidateIntegrity) record.candidate.applyRequested = false;
          }
          Object.assign(handoff, structuredClone(update), { updatedAt: now });
          record.updatedAt = now;
          return true;
        });
      } catch (error) {
        if (expectedRevision === undefined && error instanceof ExtensionCatalogRevisionConflictError) continue;
        throw error;
      }
    }
  }

  async #mutate(
    expectedRevision: number,
    mutator: (document: VarinExtensionCatalogDocument, now: string) => boolean,
  ): Promise<CatalogReadState> {
    return this.#serialize(async () => {
      await mkdir(this.directory, { mode: 0o700, recursive: true });
      await this.#readOrCreateIdentity();
      const release = await acquireLock(this.#lockPath);
      try {
        const strictRead = await this.#readStrictForMutation();
        const document = strictRead.document;
        if (document.revision !== expectedRevision) {
          throw new ExtensionCatalogRevisionConflictError(expectedRevision, document.revision);
        }
        const now = new Date().toISOString();
        const changed = mutator(document, now);
        if (changed) {
          document.revision += 1;
          document.updatedAt = now;
          await atomicWrite(this.catalogPath, document);
        }
        this.#lastValid = {
          document: cloneDocument(document),
          fingerprint: fingerprint(document),
          storageState: strictRead.storageState === "ready" || changed ? "ready" : "missing",
        };
        return this.#stateFromLastValid();
      } finally {
        await release();
      }
    });
  }

  async #mutateCurrent(
    mutator: (document: VarinExtensionCatalogDocument, now: string) => boolean,
  ): Promise<CatalogReadState> {
    return this.#serialize(async () => {
      await mkdir(this.directory, { mode: 0o700, recursive: true });
      await this.#readOrCreateIdentity();
      const release = await acquireLock(this.#lockPath);
      try {
        const now = new Date().toISOString();
        const strictRead = await this.#readStrictForMutation();
        const document = strictRead.document;
        const changed = mutator(document, now);
        if (changed) {
          document.revision += 1;
          document.updatedAt = now;
          await atomicWrite(this.catalogPath, document);
        }
        this.#lastValid = {
          document: cloneDocument(document),
          fingerprint: fingerprint(document),
          storageState: strictRead.storageState === "ready" || changed ? "ready" : "missing",
        };
        return this.#stateFromLastValid();
      } finally {
        await release();
      }
    });
  }

  async #readOrCreateIdentity(): Promise<VarinExtensionHostIdentityDocument> {
    if (this.#identity) return this.#identity;
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    try {
      this.#identity = parseVarinExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")) as unknown);
      return this.#identity;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        const code = error instanceof SyntaxError || error instanceof VarinExtensionContractError
          ? "identity_invalid"
          : "identity_read_failed";
        throw new ExtensionCatalogStorageError(code, "Failed to read Varin extension host identity", { cause: error });
      }
    }

    const release = await acquireLock(this.#lockPath);
    try {
      try {
        this.#identity = parseVarinExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")) as unknown);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        this.#identity = {
          createdAt: new Date().toISOString(),
          hostId: randomUUID(),
          schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
        };
        await atomicWrite(this.identityPath, this.#identity);
      }
      return this.#identity;
    } catch (error) {
      throw new ExtensionCatalogStorageError("identity_read_failed", "Failed to create Varin extension host identity", { cause: error });
    } finally {
      await release();
    }
  }

  async #readStrictForMutation(): Promise<{
    document: VarinExtensionCatalogDocument;
    storageState: "missing" | "ready";
  }> {
    try {
      return {
        document: parseVarinExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown),
        storageState: "ready",
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { document: emptyDocument(), storageState: "missing" };
      throw new ExtensionCatalogStorageError(
        error instanceof SyntaxError || error instanceof VarinExtensionContractError
          ? "catalog_invalid"
          : "catalog_read_failed",
        "Cannot mutate an unreadable Varin extension catalog",
        { cause: error },
      );
    }
  }

  async #readPreservingAuthority(): Promise<CatalogReadState> {
    try {
      const document = parseVarinExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown);
      const nextFingerprint = fingerprint(document);
      if (this.#lastValid && document.revision < this.#lastValid.document.revision) {
        return this.#stale("catalog_revision_regressed", `Catalog revision regressed from ${this.#lastValid.document.revision} to ${document.revision}`);
      }
      if (
        this.#lastValid
        && document.revision === this.#lastValid.document.revision
        && nextFingerprint !== this.#lastValid.fingerprint
      ) {
        return this.#stale("catalog_revision_reused", `Catalog content changed without advancing revision ${document.revision}`);
      }
      this.#lastValid = { document: cloneDocument(document), fingerprint: nextFingerprint, storageState: "ready" };
      return this.#stateFromLastValid();
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (this.#lastValid?.storageState === "ready") {
          return this.#stale("catalog_disappeared", "The catalog file disappeared after a valid catalog was loaded");
        }
        const document = emptyDocument();
        this.#lastValid = { document, fingerprint: fingerprint(document), storageState: "missing" };
        return this.#stateFromLastValid();
      }
      if (this.#lastValid) {
        return this.#stale("catalog_read_failed", "Current catalog storage could not be read; the last valid catalog is preserved");
      }
      throw new ExtensionCatalogStorageError(
        error instanceof SyntaxError || error instanceof VarinExtensionContractError
          ? "catalog_invalid"
          : "catalog_read_failed",
        "Failed to read Varin extension catalog",
        { cause: error },
      );
    }
  }

  #stateFromLastValid(): CatalogReadState {
    if (!this.#lastValid) throw new Error("Varin extension catalog has no valid state");
    return {
      authoritative: true,
      diagnostics: [],
      document: cloneDocument(this.#lastValid.document),
      storageState: this.#lastValid.storageState,
    };
  }

  #stale(code: string, message: string): CatalogReadState {
    if (!this.#lastValid) throw new Error("Varin extension catalog has no state to preserve");
    return {
      authoritative: false,
      diagnostics: [diagnostic(code, message)],
      document: cloneDocument(this.#lastValid.document),
      storageState: "stale",
    };
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export type { CatalogReadState };
