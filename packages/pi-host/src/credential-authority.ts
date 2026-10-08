import { credentialValueResolver } from './credential-value-resolver.js';
/** Application-Host-owned credential storage and relink metadata.
 * Uses the existing AuthStorage transaction; never creates a second secret file or token hash.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { FileAuthStorageBackend, ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AuthOperationOptions, AuthResult, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

export interface HostSelectedModel { providerId: string; modelId: string; name: string; api: string; baseUrl: string; maxTokens: number; compat?: Record<string, unknown> }
export interface HostCredentialScope { reference: string; authority: string; account: string; generation: number }
interface BindingMetadata { schema: 1; handle: string; generation: number; providerAccount?: string }
type Stored = Credential & { $varinCredentialBinding?: BindingMetadata };
export type CredentialMutationIntent = 'refresh' | 'replace';
const publicFailure = (code: string): Error => Object.assign(new Error(code), { code });
const plain = (credential: Stored | undefined): Credential | undefined => {
  if (!credential) return undefined;
  const { $varinCredentialBinding: _metadata, ...value } = credential;
  return value as Credential;
};
function metadata(value: Stored | undefined): BindingMetadata | undefined {
  const data = value?.$varinCredentialBinding;
  if (data === undefined) return undefined;
  if (data.schema !== 1 || typeof data.handle !== 'string' || !data.handle
    || !Number.isSafeInteger(data.generation) || data.generation < 1
    || (data.providerAccount !== undefined && (typeof data.providerAccount !== 'string' || !data.providerAccount))) {
    throw publicFailure('credential-metadata-invalid');
  }
  return data;
}
function providerAccount(credential: Credential): string | undefined {
  // Provider login/refresh handlers supply this metadata. Never derive it by hashing a token.
  const value = (credential as Credential & { accountId?: unknown }).accountId;
  return typeof value === 'string' && value ? value : undefined;
}
export class HostCredentialAuthority implements CredentialStore {
  readonly #intent = new AsyncLocalStorage<CredentialMutationIntent>();
  readonly #store: CredentialStore;
  readonly authorityId: string;
  #runtime: Promise<ModelRuntime> | undefined;
  readonly #modelsPath: string | null;
  constructor(options: { store: CredentialStore; authorityId: string; modelsPath?: string | null }) {
    if (!options.authorityId) throw publicFailure('credential-authority-invalid');
    this.#store = options.store;
    this.#modelsPath = options.modelsPath ?? null;
    this.authorityId = options.authorityId;
  }
  static open(agentDir = getAgentDir()): HostCredentialAuthority {
    const directory = resolve(agentDir);
    return new HostCredentialAuthority({ store: new ExistingBackendCredentialStore(join(directory, 'auth.json')),
      authorityId: `varin-store-${createHash('sha256').update(directory).digest('hex')}`, modelsPath: join(directory, 'models.json') });
  }
  async #record(providerId: string, options?: AuthOperationOptions): Promise<Stored | undefined> {
    const record = await this.#store.modify(providerId, async current => {
      const value = current as Stored | undefined;
      if (!value || metadata(value)) return undefined;
      const account = providerAccount(value);
      return { ...value, $varinCredentialBinding: { schema: 1, handle: randomUUID(), generation: 1,
        ...(account ? { providerAccount: account } : {}) } } as Stored;
    }, options);
    return record as Stored | undefined;
  }
  async readRaw(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return plain(await this.#record(providerId, options));
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const value = await this.readRaw(providerId, options);
    if (value?.type !== 'api_key' || value.key === undefined) return value;
    const resolver = await credentialValueResolver();
    // Dynamic helper/env keys stay available to delegated Pi workers, which resolve them in
    // their existing execution environment. Native binding requires an explicit source owner.
    if (resolver.isCommandConfigValue(value.key) || resolver.getConfigValueEnvVarNames(value.key).length) return value;
    const resolved = resolver.resolveConfigValue(value.key, value.env);
    const { key: _key, ...rest } = value;
    return resolved === undefined ? rest : { ...rest, key: resolved };
  }
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> { return this.#store.list(options); }
  async currentScope(providerId: string): Promise<HostCredentialScope> {
    const record = await this.#record(providerId);
    const binding = metadata(record);
    if (!binding) throw publicFailure('credential-missing');
    if (record?.type === 'api_key') {
      const resolver = await credentialValueResolver();
      if (!record.key || resolver.isCommandConfigValue(record.key) || resolver.getConfigValueEnvVarNames(record.key).length) throw publicFailure('credential-source-binding-required');
    }
    return { reference: `provider:${providerId}`, authority: this.authorityId, account: binding.handle, generation: binding.generation };
  }
  async currentProviderAccount(providerId: string): Promise<string | undefined> {
    return metadata(await this.#record(providerId))?.providerAccount;
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.modifyWithIntent(providerId, this.#intent.getStore() ?? 'replace', fn, options);
  }
  async modifyWithIntent(providerId: string, intent: CredentialMutationIntent,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const result = await this.#store.modify(providerId, async current => {
      const old = current as Stored | undefined;
      const oldMetadata = metadata(old);
      const next = await fn(plain(old));
      if (next === undefined) {
        if (!old || oldMetadata) return undefined;
        return { ...old, $varinCredentialBinding: { schema: 1, handle: randomUUID(), generation: 1,
          ...(providerAccount(old) ? { providerAccount: providerAccount(old) } : {}) } } as Stored;
      }
      if (next.type !== 'api_key' && next.type !== 'oauth') throw publicFailure('credential-type-invalid');
      if (intent === 'refresh' && (old?.type !== 'oauth' || next.type !== 'oauth')) throw publicFailure('credential-refresh-type-changed');
      const incomingAccount = providerAccount(next);
      const account = intent === 'refresh' ? incomingAccount ?? oldMetadata?.providerAccount : incomingAccount;
      const changedAccount = Boolean(incomingAccount && oldMetadata?.providerAccount && incomingAccount !== oldMetadata.providerAccount);
      const increment = intent === 'replace' || changedAccount;
      const generation = oldMetadata ? oldMetadata.generation + (increment ? 1 : 0) : 1;
      if (!Number.isSafeInteger(generation)) throw publicFailure('credential-generation-exhausted');
      // Credential and nonsecret relink metadata are one atomic existing-store modification.
      return { ...next, $varinCredentialBinding: { schema: 1, handle: oldMetadata?.handle ?? randomUUID(), generation,
        ...(account ? { providerAccount: account } : {}) } } as Stored;
    }, options);
    return plain(result as Stored | undefined);
  }
  delete(providerId: string, options?: AuthOperationOptions): Promise<void> { return this.#store.delete(providerId, options); }
  async #modelRuntime(): Promise<ModelRuntime> {
    this.#runtime ??= ModelRuntime.create({ credentials: this, modelsPath: this.#modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    return this.#runtime;
  }
  /** Existing SDK resolution uses this SAME authority; no independent authPath store is opened. */
  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    await this.currentScope(providerId);
    const runtime = await this.#modelRuntime();
    // A models.json key/command is a separate credential source. Do not silently stamp the
    // stored-credential handle onto it before that source has an explicit owner binding.
    if (runtime.getRegisteredProviderConfig(providerId)?.apiKey !== undefined) throw publicFailure('configured-key-binding-required');
    return this.#intent.run('refresh', () => runtime.getAuth(providerId));
  }
  async selectedModel(providerId: string, modelId: string): Promise<HostSelectedModel> {
    const runtime = await this.#modelRuntime();
    await runtime.refresh({ allowNetwork: false });
    if (runtime.getRegisteredProviderConfig(providerId)?.apiKey !== undefined) throw publicFailure('configured-key-binding-required');
    const model = runtime.getModel(providerId, modelId);
    if (!model) throw publicFailure('registered-model-not-found');
    return { providerId, modelId: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
      maxTokens: model.maxTokens, ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}) };
  }
  async listModels(): Promise<HostSelectedModel[]> {
    const runtime = await this.#modelRuntime();
    await runtime.refresh({ allowNetwork: false });
    const configured = new Set((await this.list()).map(entry => entry.providerId));
    return runtime.getModels().filter(model => configured.has(model.provider)
      && runtime.getRegisteredProviderConfig(model.provider)?.apiKey === undefined).map(model => ({ providerId: model.provider,
        modelId: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl, maxTokens: model.maxTokens,
        ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}) }));
  }
  async routingEnvironment(providerId: string): Promise<Record<string, string>> {
    const credential = await this.readRaw(providerId);
    const stored = credential?.type === 'api_key' ? credential.env : undefined;
    const names = ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
      'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_REGION'];
    const result: Record<string, string> = Object.create(null);
    for (const name of names) { const value = stored?.[name] ?? process.env[name]; if (value) result[name] = value; }
    return result;
  }
}

/** Reuses the existing SDK lock authority and path, replacing its truncating writes with an
 * atomic same-file replacement. There is no parallel credential cache or journal store.
 */
export class ExistingBackendCredentialStore implements CredentialStore {
  readonly #backend: FileAuthStorageBackend;
  readonly #path: string;
  constructor(path: string) { this.#path = path; this.#backend = new FileAuthStorageBackend(path); }
  #parse(content: string | undefined): Record<string, Credential> {
    if (content === undefined) return {};
    let value: unknown;
    try { value = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw publicFailure('credential-store-corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw publicFailure('credential-store-corrupt');
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== 'object' || !['api_key', 'oauth'].includes((entry as { type?: string }).type ?? '')) throw publicFailure('credential-store-corrupt');
    }
    return value as Record<string, Credential>;
  }
  async #syncDirectory(): Promise<void> {
    // Windows does not support opening directories through this API; file replacement remains
    // atomic there, while the Unix path also flushes the containing directory entry.
    if (process.platform === 'win32') return;
    const directory = await fs.open(dirname(this.#path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async #write(value: Record<string, Credential>): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const original = await fs.stat(this.#path);
    const handle = await fs.open(temporary, 'wx', original.mode & 0o777);
    try {
      // Creation applies umask; restore the existing mode rather than silently changing it.
      await handle.chmod(original.mode & 0o777);
      if (process.platform !== 'win32') {
        const created = await handle.stat();
        if (created.uid !== original.uid || created.gid !== original.gid) await handle.chown(original.uid, original.gid);
      }
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, this.#path);
      await this.#syncDirectory();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async #locked<T>(fn: (current: Record<string, Credential>) => Promise<{ result: T; next?: Record<string, Credential> }>, options?: AuthOperationOptions): Promise<T> {
    return this.#backend.withLockAsync(async content => {
      const current = this.#parse(content);
      const { result, next } = await fn(current);
      if (next) await this.#write(next);
      // Deliberately omit SDK `next`: the existing lock remains held through our atomic commit.
      return { result };
    }, options);
  }
  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#locked(async current => ({ result: current[providerId] }), options);
  }
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#locked(async current => ({ result: Object.entries(current).map(([providerId, credential]) => ({ providerId, type: credential.type })) }), options);
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#locked(async current => {
      const next = await fn(current[providerId]);
      return next === undefined ? { result: current[providerId] } : { result: next, next: { ...current, [providerId]: next } };
    }, options);
  }
  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#locked(async current => { const next = { ...current }; delete next[providerId]; return { result: undefined, next }; }, options);
  }
}

const sharedAuthorities = new Map<string, HostCredentialAuthority>();
/** One authority per configured store in the Application Host process, shared across runtimes. */
export function sharedHostCredentialAuthority(agentDir = getAgentDir()): HostCredentialAuthority {
  const directory = resolve(agentDir);
  let authority = sharedAuthorities.get(directory);
  if (!authority) { authority = HostCredentialAuthority.open(directory); sharedAuthorities.set(directory, authority); }
  return authority;
}

export { CredentialStoreServer } from "./credential-store-rpc.js";
