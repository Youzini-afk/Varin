import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  JsonObject,
  JsonValue,
  VarinExtensionStorageOpenRequest,
  VarinExtensionStorageSnapshot,
} from "@varin/extension-contract";
import type { BrokeredHostTransport } from "./broker-supervisor.js";

type NativeServiceHandler = Record<string, (args: JsonValue[], call: { signal: AbortSignal; callId: string }) => unknown>;

interface NativeHostExtension {
  activate(context: NativeHostContext): unknown | Promise<unknown>;
  migrate?(input: unknown): JsonObject | Promise<JsonObject>;
}

interface NativeHostContext {
  assets: { path(logicalPath: string): string };
  capabilities: { call(capability: string, method: string, params: JsonValue): Promise<JsonValue> };
  effect(disposer: () => void | Promise<void>): void;
  services: {
    provide(descriptor: unknown, handler: NativeServiceHandler): void;
    use(id: string, version: number, providerId?: string): { call(method: string, ...args: JsonValue[]): Promise<JsonValue> };
  };
  signal: AbortSignal;
  storage: {
    readonly snapshot: VarinExtensionStorageSnapshot;
    open(request: VarinExtensionStorageOpenRequest): Promise<NativeStorageDocumentClient>;
    refresh(): Promise<VarinExtensionStorageSnapshot>;
    update(data: JsonObject, expectedRevision?: number): Promise<VarinExtensionStorageSnapshot>;
  };
}

const packageAssetPath = (packageRoot: string, logicalPath: string): string => {
  if (!packageRoot || !isAbsolute(packageRoot)) {
    throw new Error("Host package root is unavailable");
  }
  if (!logicalPath || logicalPath.includes("\\") || logicalPath.includes("\0") || isAbsolute(logicalPath)) {
    throw new Error("Host asset path must be a non-empty package-relative path");
  }
  const target = resolve(packageRoot, ...logicalPath.split("/"));
  const fromRoot = relative(packageRoot, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`Host asset path escapes the extension package: ${logicalPath}`);
  }
  return target;
};

interface NativeStorageDocumentClient {
  readonly snapshot: VarinExtensionStorageSnapshot;
  refresh(): Promise<VarinExtensionStorageSnapshot>;
  update(data: JsonObject, expectedRevision?: number): Promise<VarinExtensionStorageSnapshot>;
}

interface NativeStorageClientState {
  snapshot: VarinExtensionStorageSnapshot;
}

const storageKey = (address: Pick<VarinExtensionStorageOpenRequest, "key" | "scope">): string => (
  `${address.scope}\0${address.key}`
);

export interface NativeHostTransportOptions {
  requestFromExtension(method: string, params: unknown, signal: AbortSignal): Promise<JsonValue>;
}

const resolveExtension = (moduleValue: unknown): NativeHostExtension => {
  const module = moduleValue as { activate?: unknown; default?: unknown; migrate?: unknown };
  const candidate = module?.default ?? module;
  if (typeof candidate === "function") {
    const extension: NativeHostExtension = { activate: candidate as NativeHostExtension["activate"] };
    if (typeof module.migrate === "function") extension.migrate = module.migrate as NonNullable<NativeHostExtension["migrate"]>;
    return extension;
  }
  if (candidate && typeof candidate === "object" && typeof (candidate as { activate?: unknown }).activate === "function") {
    const extension = candidate as NativeHostExtension;
    return {
      activate: extension.activate.bind(extension),
      ...(typeof extension.migrate === "function" ? { migrate: extension.migrate.bind(extension) } : {}),
    };
  }
  if (typeof module?.activate === "function") {
    const extension: NativeHostExtension = { activate: module.activate as NativeHostExtension["activate"] };
    if (typeof module.migrate === "function") extension.migrate = module.migrate as NonNullable<NativeHostExtension["migrate"]>;
    return extension;
  }
  throw new Error("Trusted-native Varin Host module must export activate or a default extension definition");
};

export class NativeHostTransport implements BrokeredHostTransport {
  readonly #disposers: Array<() => void | Promise<void>> = [];
  readonly #requestFromExtension: NativeHostTransportOptions["requestFromExtension"];
  readonly #serviceHandlers = new Map<string, NativeServiceHandler>();
  #controller: AbortController | null = null;
  #modulePath = "";
  #moduleValue: unknown;
  readonly #storages = new Map<string, Set<NativeStorageClientState>>();
  #terminated = false;
  #callId = 0;

  constructor(options: NativeHostTransportOptions) {
    this.#requestFromExtension = options.requestFromExtension;
  }

  async request(method: string, paramsValue?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.#terminated && method !== "deactivate") throw new Error("Trusted-native Host entrypoint is inactive");
    const params = paramsValue && typeof paramsValue === "object" && !Array.isArray(paramsValue)
      ? paramsValue as Record<string, unknown>
      : {};
    switch (method) {
      case "migrate": {
        const extension = this.#load(String(params.modulePath ?? ""));
        if (!extension.migrate) {
          const input = params.input as { fromSchemaVersion?: unknown; toSchemaVersion?: unknown; data?: unknown } | undefined;
          if (input?.fromSchemaVersion !== input?.toSchemaVersion) {
            throw new Error("Extension storage requires migration but the trusted-native Host module exports no migrate function");
          }
          return input?.data ?? {};
        }
        return extension.migrate(params.input);
      }
      case "activate": {
        await this.#deactivate().catch(() => undefined);
        this.#terminated = false;
        const extension = this.#load(String(params.modulePath ?? ""));
        this.#controller = new AbortController();
        this.#storages.clear();
        const stagedHandlers = new Map<string, NativeServiceHandler>();
        const provisions: unknown[] = [];
        const createStorageClient = (
          request: VarinExtensionStorageOpenRequest,
          initialSnapshot: VarinExtensionStorageSnapshot,
        ): NativeStorageDocumentClient => {
          const state: NativeStorageClientState = { snapshot: initialSnapshot };
          const key = storageKey(request);
          const clients = this.#storages.get(key) ?? new Set<NativeStorageClientState>();
          clients.add(state);
          this.#storages.set(key, clients);
          return {
            get snapshot() { return state.snapshot; },
            refresh: async () => {
              state.snapshot = await this.#requestFromExtension(
                "storage.refresh",
                request,
                this.#controller?.signal ?? new AbortController().signal,
              ) as unknown as VarinExtensionStorageSnapshot;
              return state.snapshot;
            },
            update: async (data, expectedRevision = state.snapshot.document.revision) => {
              state.snapshot = await this.#requestFromExtension(
                "storage.update",
                { data, expectedRevision, key: request.key, scope: request.scope },
                this.#controller?.signal ?? new AbortController().signal,
              ) as unknown as VarinExtensionStorageSnapshot;
              return state.snapshot;
            },
          };
        };
        const defaultStorage = createStorageClient(
          { key: "state", scope: "application" },
          params.storage as VarinExtensionStorageSnapshot,
        );
        const packageRoot = String(params.packageRoot ?? "");
        const context: NativeHostContext = {
          assets: {
            path: (logicalPath) => packageAssetPath(packageRoot, logicalPath),
          },
          capabilities: {
            call: (capability, capabilityMethod, capabilityParams) => this.#requestFromExtension(
              "capability.call",
              { capability, method: capabilityMethod, params: capabilityParams },
              this.#controller?.signal ?? new AbortController().signal,
            ),
          },
          effect: (disposer) => {
            if (typeof disposer !== "function") throw new Error("Trusted-native Host effect disposer must be a function");
            this.#disposers.push(disposer);
          },
          services: {
            provide: (descriptorValue, handler) => {
              const descriptor = descriptorValue as { id?: unknown; version?: unknown };
              const key = `${String(descriptor.id ?? "")}@${Number(descriptor.version)}`;
              if (!descriptor.id || !Number.isSafeInteger(descriptor.version) || Number(descriptor.version) <= 0) {
                throw new Error("Trusted-native Host service descriptor is invalid");
              }
              if (!handler || typeof handler !== "object") throw new Error(`Trusted-native Host service handler is invalid: ${key}`);
              if (stagedHandlers.has(key)) throw new Error(`Trusted-native Host service provided more than once: ${key}`);
              stagedHandlers.set(key, handler);
              provisions.push(descriptorValue);
            },
            use: (id, version, providerId) => ({
              call: (serviceMethod, ...args) => this.#requestFromExtension(
                "service.invoke",
                { args, method: serviceMethod, providerId, serviceId: id, version },
                this.#controller?.signal ?? new AbortController().signal,
              ),
            }),
          },
          signal: this.#controller.signal,
          storage: {
            get snapshot() {
              return defaultStorage.snapshot;
            },
            open: async (request) => createStorageClient(
              request,
              await this.#requestFromExtension(
                "storage.open",
                request,
                this.#controller?.signal ?? new AbortController().signal,
              ) as unknown as VarinExtensionStorageSnapshot,
            ),
            refresh: () => defaultStorage.refresh(),
            update: (data, expectedRevision) => defaultStorage.update(data, expectedRevision),
          },
        };
        try {
          const returned = await extension.activate(context);
          if (typeof returned === "function") this.#disposers.push(returned as () => void | Promise<void>);
          for (const [key, handler] of stagedHandlers) this.#serviceHandlers.set(key, handler);
          return { provisions };
        } catch (error) {
          await this.#deactivate().catch(() => undefined);
          throw error;
        }
      }
      case "service.invoke": {
        const key = `${String(params.serviceId ?? "")}@${Number(params.version)}`;
        const methodHandler = this.#serviceHandlers.get(key)?.[String(params.method ?? "")];
        if (typeof methodHandler !== "function") throw new Error(`Trusted-native Host service method is unavailable: ${key}.${String(params.method ?? "")}`);
        const callSignal = signal && this.#controller
          ? AbortSignal.any([signal, this.#controller.signal])
          : signal ?? this.#controller?.signal ?? new AbortController().signal;
        callSignal.throwIfAborted();
        return methodHandler(Array.isArray(params.args) ? params.args as JsonValue[] : [], {
          signal: callSignal, callId: `native-${++this.#callId}`,
        });
      }
      case "storage.sync":
        for (const snapshot of Array.isArray(params.storages)
          ? params.storages as VarinExtensionStorageSnapshot[]
          : params.storage ? [params.storage as VarinExtensionStorageSnapshot] : []) {
          for (const state of this.#storages.get(storageKey(snapshot.address)) ?? []) state.snapshot = snapshot;
        }
        return null;
      case "deactivate":
        await this.#deactivate();
        this.#terminated = true;
        return null;
      default:
        throw new Error(`Unknown trusted-native Host request method: ${method}`);
    }
  }

  async terminate(): Promise<void> {
    await this.request("deactivate");
  }

  forceTerminate(): void {
    this.#controller?.abort("Trusted-native Host entrypoint force-disabled");
    this.#terminated = true;
  }

  #load(modulePath: string): NativeHostExtension {
    if (!modulePath) throw new Error("Trusted-native Host module path is required");
    if (this.#moduleValue === undefined || this.#modulePath !== modulePath) {
      this.#modulePath = modulePath;
      this.#moduleValue = createRequire(modulePath)(modulePath);
    }
    return resolveExtension(this.#moduleValue);
  }

  async #deactivate(): Promise<void> {
    this.#controller?.abort("Trusted-native Host entrypoint deactivated");
    this.#controller = null;
    this.#serviceHandlers.clear();
    const errors: string[] = [];
    while (this.#disposers.length > 0) {
      const disposer = this.#disposers.pop();
      try { await disposer?.(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (errors.length > 0) throw new Error(`Trusted-native Host cleanup failed: ${errors.join("; ")}`);
  }
}
