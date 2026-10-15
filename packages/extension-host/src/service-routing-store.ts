import {
  VARIN_SERVICE_ROUTING_SCHEMA_VERSION,
  defaultVarinExtensionServiceRoutingDocument,
  parseVarinExtensionServiceRoutingRuleRemoveRequest,
  parseVarinExtensionServiceRoutingRuleUpdateRequest,
  serviceRoutingDocumentFromStorage,
  serviceRoutingRuleKey,
  type JsonObject,
  type VarinExtensionServiceRoutingDocument,
  type VarinExtensionServiceRoutingRuleRemoveRequest,
  type VarinExtensionServiceRoutingRuleUpdateRequest,
  type VarinExtensionServiceRoutingSnapshot,
} from "@varin/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";

const ADDRESS = {
  extensionId: "varin.core.service-routing",
  key: "rules",
  scope: "application",
} as const;

const dataFromDocument = (document: VarinExtensionServiceRoutingDocument): JsonObject => ({
  rules: structuredClone(document.rules) as unknown as JsonObject["rules"],
});

export class ServiceRoutingStore {
  readonly hostId: string;
  readonly storage: ExtensionStorageStore;
  #lastValid: VarinExtensionServiceRoutingDocument | null = null;
  #authoritative = false;
  #pendingMutations = 0;

  constructor(options: { hostId: string; storage: ExtensionStorageStore }) {
    this.hostId = options.hostId;
    this.storage = options.storage;
  }

  async read(): Promise<VarinExtensionServiceRoutingSnapshot> {
    try {
      const storage = await this.storage.read(ADDRESS);
      const document = serviceRoutingDocumentFromStorage(storage);
      this.#authoritative = storage.authoritative;
      if (storage.authoritative) this.#lastValid = structuredClone(document);
      return {
        authoritative: storage.authoritative,
        diagnostics: storage.diagnostics,
        document,
        hostId: this.hostId,
        storageState: storage.storageState,
      };
    } catch (error) {
      this.#authoritative = false;
      return {
        authoritative: false,
        diagnostics: [{
          code: "service_routing_read_failed",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          timestamp: new Date().toISOString(),
        }],
        document: structuredClone(this.#lastValid ?? defaultVarinExtensionServiceRoutingDocument()),
        hostId: this.hostId,
        storageState: "stale",
      };
    }
  }

  /** Synchronous admission at another owner's commit cut. Reads/mutations remain in this store;
   * no copied routing document or independently writable revision is introduced. */
  assertCurrentRevision(expectedRevision: number): void {
    if (!this.#authoritative || this.#pendingMutations !== 0 || this.#lastValid?.revision !== expectedRevision) {
      throw new Error('Host service routing changed before candidate publication');
    }
  }

  upsertRule(
    requestValue: VarinExtensionServiceRoutingRuleUpdateRequest | unknown,
  ): Promise<VarinExtensionServiceRoutingSnapshot> {
    const request = parseVarinExtensionServiceRoutingRuleUpdateRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const key = serviceRoutingRuleKey(request.rule);
      const index = document.rules.findIndex((rule) => serviceRoutingRuleKey(rule) === key);
      if (index === -1) document.rules.push(request.rule);
      else document.rules[index] = request.rule;
    });
  }

  removeRule(
    requestValue: VarinExtensionServiceRoutingRuleRemoveRequest | unknown,
  ): Promise<VarinExtensionServiceRoutingSnapshot> {
    const request = parseVarinExtensionServiceRoutingRuleRemoveRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const key = serviceRoutingRuleKey(request);
      document.rules = document.rules.filter((rule) => serviceRoutingRuleKey(rule) !== key);
    });
  }

  async #mutate(
    expectedRevision: number,
    mutate: (document: VarinExtensionServiceRoutingDocument) => void,
  ): Promise<VarinExtensionServiceRoutingSnapshot> {
    this.#pendingMutations += 1;
    try {
      const current = await this.read();
      if (!current.authoritative) throw new Error("Cannot update stale service routing state");
      const document = structuredClone(current.document);
      mutate(document);
      const storage = await this.storage.update(
        ADDRESS,
        expectedRevision,
        VARIN_SERVICE_ROUTING_SCHEMA_VERSION,
        dataFromDocument(document),
      );
      const next = {
        authoritative: storage.authoritative,
        diagnostics: storage.diagnostics,
        document: serviceRoutingDocumentFromStorage(storage),
        hostId: this.hostId,
        storageState: storage.storageState,
      } satisfies VarinExtensionServiceRoutingSnapshot;
      this.#authoritative = next.authoritative;
      if (next.authoritative) this.#lastValid = structuredClone(next.document);
      return next;
    } catch (error) { this.#authoritative = false; throw error; }
    finally { this.#pendingMutations -= 1; }
  }
}

export const emptyServiceRoutingDocument = defaultVarinExtensionServiceRoutingDocument;
