import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pending = new Map();
const serviceHandlers = new Map();
const activeCalls = new Map();
const disposers = [];
let modulePath = '';
let loadedModule = null;
let activationController = null;
let requestCounter = 0;
const storageClients = new Map();

const send = (message) => {
  if (typeof process.send !== 'function' || !process.connected) throw new Error('Broker parent is disconnected');
  process.send(message);
};

const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const storageKey = (address) => `${address?.scope || ''}\0${address?.key || ''}`;

const packageAssetPath = (packageRoot, logicalPath) => {
  if (!packageRoot || !isAbsolute(packageRoot)) {
    throw new Error('Host package root is unavailable');
  }
  if (typeof logicalPath !== 'string' || logicalPath.length === 0 || logicalPath.includes('\\') || logicalPath.includes('\0') || isAbsolute(logicalPath)) {
    throw new Error('Host asset path must be a non-empty package-relative path');
  }
  const target = resolve(packageRoot, ...logicalPath.split('/'));
  const fromRoot = relative(packageRoot, target);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Host asset path escapes the extension package: ${logicalPath}`);
  }
  return target;
};

const createStorageClient = (request, initialSnapshot) => {
  const state = { snapshot: initialSnapshot };
  const key = storageKey(request);
  const clients = storageClients.get(key) ?? new Set();
  clients.add(state);
  storageClients.set(key, clients);
  return {
    get snapshot() { return state.snapshot; },
    refresh: async () => {
      state.snapshot = await requestParent('storage.refresh', request);
      return state.snapshot;
    },
    update: async (data, expectedRevision = state.snapshot?.document?.revision) => {
      state.snapshot = await requestParent('storage.update', {
        data,
        expectedRevision,
        key: request.key,
        scope: request.scope,
      });
      return state.snapshot;
    },
  };
};

const requestParent = (method, params) => new Promise((resolve, reject) => {
  const id = `child-${process.pid}-${++requestCounter}`;
  pending.set(id, { resolve, reject });
  send({ kind: 'request', id, method, params });
});

const loadExtensionModule = (nextModulePath) => {
  if (loadedModule && modulePath === nextModulePath) return loadedModule;
  modulePath = nextModulePath;
  delete require.cache[require.resolve(modulePath)];
  loadedModule = require(modulePath);
  return loadedModule;
};

const resolveExtension = (module) => {
  const candidate = module?.default ?? module;
  if (typeof candidate === 'function') return { activate: candidate, migrate: module?.migrate };
  if (candidate && typeof candidate.activate === 'function') {
    return { activate: candidate.activate.bind(candidate), migrate: candidate.migrate?.bind(candidate) ?? module?.migrate };
  }
  if (typeof module?.activate === 'function') return { activate: module.activate, migrate: module.migrate };
  throw new Error('Brokered Varin Host module must export activate or a default extension definition');
};

const deactivate = async () => {
  for (const controller of activeCalls.values()) controller.abort(new Error('Brokered Host extension deactivated'));
  activationController?.abort('Brokered Host extension deactivated');
  activationController = null;
  serviceHandlers.clear();
  const errors = [];
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    try { await dispose(); }
    catch (error) { errors.push(errorMessage(error)); }
  }
  if (errors.length > 0) throw new Error(`Brokered Host cleanup failed: ${errors.join('; ')}`);
};

const handleParentRequest = async (message, signal) => {
  switch (message.method) {
    case 'migrate': {
      const extension = resolveExtension(loadExtensionModule(String(message.params?.modulePath || '')));
      if (typeof extension.migrate !== 'function') {
        if (message.params?.input?.fromSchemaVersion !== message.params?.input?.toSchemaVersion) {
          throw new Error('Extension storage requires migration but the Host module exports no migrate function');
        }
        return message.params?.input?.data ?? {};
      }
      return extension.migrate(message.params.input);
    }
    case 'activate': {
      await deactivate().catch(() => undefined);
      const extension = resolveExtension(loadExtensionModule(String(message.params?.modulePath || '')));
      activationController = new AbortController();
      const stagedHandlers = new Map();
      const stagedProvisions = [];
      storageClients.clear();
      const defaultStorage = createStorageClient(
        { key: 'state', scope: 'application' },
        message.params.storage,
      );
      const packageRoot = String(message.params?.packageRoot || '');
      const context = {
        assets: {
          path: (logicalPath) => packageAssetPath(packageRoot, logicalPath),
        },
        capabilities: {
          call: (capability, method, params) => requestParent('capability.call', { capability, method, params }),
        },
        effect: (disposer) => {
          if (typeof disposer !== 'function') throw new Error('Host effect disposer must be a function');
          disposers.push(disposer);
        },
        services: {
          provide: (descriptor, handler) => {
            const key = `${descriptor?.id}@${descriptor?.version}`;
            if (!descriptor?.id || !Number.isSafeInteger(descriptor?.version) || descriptor.version <= 0) {
              throw new Error('Host service descriptor is invalid');
            }
            if (!handler || typeof handler !== 'object') throw new Error(`Host service handler is invalid: ${key}`);
            if (stagedHandlers.has(key)) throw new Error(`Host service provided more than once: ${key}`);
            stagedHandlers.set(key, handler);
            stagedProvisions.push(descriptor);
          },
          use: (id, version, provider) => {
            const options = typeof provider === 'string' ? { providerId: provider } : (provider ?? {});
            return {
              call: (method, ...args) => requestParent('service.invoke', {
                args,
                method,
                ...(options.providerId ? { providerId: options.providerId } : {}),
                ...(options.routing ? { routing: options.routing } : {}),
                serviceId: id,
                version,
              }),
            };
          },
        },
        signal: activationController.signal,
        storage: {
          get snapshot() { return defaultStorage.snapshot; },
          open: async (request) => createStorageClient(
            request,
            await requestParent('storage.open', request),
          ),
          refresh: () => defaultStorage.refresh(),
          update: (data, expectedRevision) => defaultStorage.update(data, expectedRevision),
        },
      };
      const returned = await extension.activate(context);
      if (typeof returned === 'function') disposers.push(returned);
      for (const [key, handler] of stagedHandlers) serviceHandlers.set(key, handler);
      return { provisions: stagedProvisions };
    }
    case 'service.invoke': {
      const key = `${message.params?.serviceId}@${message.params?.version}`;
      const handler = serviceHandlers.get(key);
      const method = String(message.params?.method || '');
      const implementation = handler?.[method];
      if (typeof implementation !== 'function') throw new Error(`Brokered Host service method is unavailable: ${key}.${method}`);
      signal.throwIfAborted();
      return implementation(Array.isArray(message.params?.args) ? message.params.args : [], { signal, callId: message.id });
    }
    case 'storage.sync':
      for (const snapshot of Array.isArray(message.params?.storages)
        ? message.params.storages
        : [message.params?.storage].filter(Boolean)) {
        for (const state of storageClients.get(storageKey(snapshot?.address)) ?? []) state.snapshot = snapshot;
      }
      return null;
    case 'deactivate':
      await deactivate();
      return null;
    default:
      throw new Error(`Unknown broker request method: ${message.method}`);
  }
};

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.kind === 'response' && typeof message.id === 'string') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.success) entry.resolve(message.result);
    else entry.reject(new Error(String(message.error || 'Broker request failed')));
    return;
  }
  if (message.kind === 'cancel' && typeof message.id === 'string') {
    activeCalls.get(message.id)?.abort(new Error('Brokered Host call cancelled'));
    return;
  }
  if (message.kind !== 'request' || typeof message.id !== 'string') return;
  const controller = new AbortController();
  activeCalls.set(message.id, controller);
  void handleParentRequest(message, controller.signal)
    .then((result) => send({ kind: 'response', id: message.id, success: true, result }))
    .catch((error) => send({ kind: 'response', id: message.id, success: false, error: errorMessage(error) }))
    .finally(() => activeCalls.delete(message.id));
});

process.on('disconnect', () => {
  void deactivate().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  try { send({ kind: 'event', event: 'fatal', error: errorMessage(error) }); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  try { send({ kind: 'event', event: 'fatal', error: errorMessage(error) }); } catch {}
  process.exit(1);
});

send({ kind: 'event', event: 'ready' });
