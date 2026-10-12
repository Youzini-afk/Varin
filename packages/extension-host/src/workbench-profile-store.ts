import {
  VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION,
  defaultVarinWorkbenchProfileDocument,
  migrateVarinWorkbenchProfileDocument,
  parseVarinWorkbenchLayoutUpdateRequest,
  parseVarinWorkbenchProfileRemoveRequest,
  parseVarinWorkbenchProfileSelectionRequest,
  parseVarinWorkbenchProfileUpsertRequest,
  type JsonObject,
  type VarinWorkbenchLayoutLayer,
  type VarinWorkbenchLayoutUpdateRequest,
  type VarinWorkbenchProfileDocument,
  type VarinWorkbenchProfileRemoveRequest,
  type VarinWorkbenchProfileSelectionRequest,
  type VarinWorkbenchProfileSnapshot,
  type VarinWorkbenchProfileUpsertRequest,
  workbenchDocumentFromStorage,
} from "@varin/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";

export type WorkspaceScopeResolver = (scopeId: string) => Promise<string | null>;

const ADDRESS = {
  extensionId: "varin.core.workbench",
  key: "profiles",
  scope: "application",
} as const;

const layerKey = (layer: VarinWorkbenchLayoutLayer): string => (
  `${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`
);

const dataFromDocument = (document: VarinWorkbenchProfileDocument): JsonObject => ({
  activeProfileId: document.activeProfileId,
  layouts: structuredClone(document.layouts) as unknown as JsonObject["layouts"],
  profileSelections: structuredClone(document.profileSelections) as unknown as JsonObject["profileSelections"],
  profiles: structuredClone(document.profiles) as unknown as JsonObject["profiles"],
});

export class WorkbenchProfileStore {
  readonly hostId: string;
  readonly storage: ExtensionStorageStore;
  #lastValid: VarinWorkbenchProfileDocument | null = null;
  #resolveWorkspaceScopeId: WorkspaceScopeResolver | null = null;

  constructor(options: { hostId: string; storage: ExtensionStorageStore }) {
    this.hostId = options.hostId;
    this.storage = options.storage;
  }

  setWorkspaceScopeResolver(resolver: WorkspaceScopeResolver | null): void {
    this.#resolveWorkspaceScopeId = resolver;
  }

  /** Observe the stored profile without migrations, workspace resolution or persistence. */
  snapshot(): Promise<VarinWorkbenchProfileSnapshot> {
    return this.#load();
  }

  async read(): Promise<VarinWorkbenchProfileSnapshot> {
    const snapshot = await this.#load();
    if (!snapshot.authoritative) return snapshot;
    const document = structuredClone(snapshot.document);
    const workspaceChanged = await this.#migrateWorkspaceScopes(document);
    const agentChanged = migrateVarinWorkbenchProfileDocument(document);
    if (!workspaceChanged && !agentChanged) return snapshot;
    return this.#persist(document, snapshot.document.revision);
  }

  async #load(): Promise<VarinWorkbenchProfileSnapshot> {
    try {
      const storage = await this.storage.read(ADDRESS);
      const document = workbenchDocumentFromStorage(storage);
      if (storage.authoritative) this.#lastValid = structuredClone(document);
      return {
        authoritative: storage.authoritative,
        diagnostics: storage.diagnostics,
        document,
        hostId: this.hostId,
        storageState: storage.storageState,
      };
    } catch (error) {
      return {
        authoritative: false,
        diagnostics: [{
          code: "workbench_profile_read_failed",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          timestamp: new Date().toISOString(),
        }],
        document: structuredClone(this.#lastValid ?? defaultVarinWorkbenchProfileDocument()),
        hostId: this.hostId,
        storageState: "stale",
      };
    }
  }

  updateLayout(requestValue: VarinWorkbenchLayoutUpdateRequest | unknown): Promise<VarinWorkbenchProfileSnapshot> {
    const request = parseVarinWorkbenchLayoutUpdateRequest(requestValue);
    return this.#mutate(request.expectedRevision, async (document) => {
      if (!document.profiles.some((profile) => profile.id === request.layer.profileId)) {
        throw new Error(`Workbench profile is not installed: ${request.layer.profileId}`);
      }
      const layer = request.layer.scope === "workspace"
        ? { ...request.layer, scopeId: await this.#canonicalScopeId(request.layer.scopeId) }
        : request.layer;
      const key = layerKey(layer);
      const index = document.layouts.findIndex((candidate) => layerKey(candidate) === key);
      if (index === -1) document.layouts.push(layer);
      else document.layouts[index] = layer;
    });
  }

  selectProfile(requestValue: VarinWorkbenchProfileSelectionRequest | unknown): Promise<VarinWorkbenchProfileSnapshot> {
    const request = parseVarinWorkbenchProfileSelectionRequest(requestValue);
    return this.#mutate(request.expectedRevision, async (document) => {
      if (!document.profiles.some((profile) => profile.id === request.profileId)) {
        throw new Error(`Workbench profile is not installed: ${request.profileId}`);
      }
      if (request.scope === "application") document.activeProfileId = request.profileId;
      else document.profileSelections.users[request.scopeId as string] = request.profileId;
    });
  }

  upsertProfile(requestValue: VarinWorkbenchProfileUpsertRequest | unknown): Promise<VarinWorkbenchProfileSnapshot> {
    const request = parseVarinWorkbenchProfileUpsertRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const index = document.profiles.findIndex((profile) => profile.id === request.profile.id);
      if (index === -1) document.profiles.push(request.profile);
      else document.profiles[index] = request.profile;
    });
  }

  removeProfile(requestValue: VarinWorkbenchProfileRemoveRequest | unknown): Promise<VarinWorkbenchProfileSnapshot> {
    const request = parseVarinWorkbenchProfileRemoveRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      if (document.profiles.length === 1) throw new Error("The last workbench profile cannot be removed");
      if (!document.profiles.some((profile) => profile.id === request.profileId)) return;
      document.profiles = document.profiles.filter((profile) => profile.id !== request.profileId);
      document.layouts = document.layouts.filter((layer) => layer.profileId !== request.profileId);
      if (document.activeProfileId === request.profileId) document.activeProfileId = document.profiles[0]?.id ?? "default";
      for (const [scopeId, selected] of Object.entries(document.profileSelections.users)) {
        if (selected === request.profileId) delete document.profileSelections.users[scopeId];
      }
    });
  }

  async #canonicalScopeId(scopeId: string): Promise<string> {
    if (!this.#resolveWorkspaceScopeId) return scopeId;
    return await this.#resolveWorkspaceScopeId(scopeId) ?? scopeId;
  }

  async #migrateWorkspaceScopes(document: VarinWorkbenchProfileDocument): Promise<boolean> {
    if (!this.#resolveWorkspaceScopeId) return false;
    let changed = false;
    const layouts: VarinWorkbenchLayoutLayer[] = [];
    for (const layer of document.layouts) {
      if (layer.scope !== "workspace") {
        layouts.push(layer);
        continue;
      }
      const scopeId = await this.#canonicalScopeId(layer.scopeId);
      if (scopeId !== layer.scopeId) changed = true;
      layouts.push(scopeId === layer.scopeId ? layer : { ...layer, scopeId });
    }
    document.layouts = layouts;
    return changed;
  }

  async #persist(
    document: VarinWorkbenchProfileDocument,
    expectedRevision: number,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    const storage = await this.storage.update(
      ADDRESS,
      expectedRevision,
      VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION,
      dataFromDocument(document),
    );
    const next = {
      authoritative: storage.authoritative,
      diagnostics: storage.diagnostics,
      document: workbenchDocumentFromStorage(storage),
      hostId: this.hostId,
      storageState: storage.storageState,
    } satisfies VarinWorkbenchProfileSnapshot;
    if (next.authoritative) this.#lastValid = structuredClone(next.document);
    return next;
  }

  async #mutate(
    expectedRevision: number,
    mutate: (document: VarinWorkbenchProfileDocument) => void | Promise<void>,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    const current = await this.#load();
    if (!current.authoritative) throw new Error("Cannot update stale workbench profile state");
    const document = structuredClone(current.document);
    await this.#migrateWorkspaceScopes(document);
    migrateVarinWorkbenchProfileDocument(document);
    await mutate(document);
    return this.#persist(document, expectedRevision);
  }
}

export const emptyWorkbenchProfileDocument = defaultVarinWorkbenchProfileDocument;
