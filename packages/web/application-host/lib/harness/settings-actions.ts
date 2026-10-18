/**
 * Domain-action adapters for `owner: "action"` settings catalog entries
 * (Stage S / D-309).
 *
 * Every adapter talks to the real owning authority — a native settings owner, an
 * in-process Host service, or the owning module — never a config field that
 * merely looks like state. Entries whose owner API does not exist stay
 * `unavailable`; nothing here fakes an install, login, or connection.
 */

import { type SettingsCatalogEntry } from '@varin/application-client';
import type { SettingsActionResult } from '@varin/protocol';
import { HarnessServiceError } from './service-error.js';
import type { AppPersistOutcome, SettingsServiceCaller } from './settings-service.js';

export interface SettingsActionContext {
  caller: SettingsServiceCaller;
  /** Resolved workspace root; null when the Thread has no project. */
  workspaceRoot: string | null;
}

export interface ActionStatus {
  /** One-line live state summary for `settings.read`. */
  summary?: string;
  /** Structured owner state for `detail` reads. */
  data?: unknown;
  /** Verbs the owner can actually execute right now. */
  verbs?: string[];
  /** Why the domain is not operable (offline, missing dep, …). */
  unavailable?: string;
}

export interface ActionInvocation {
  status: SettingsActionResult['status'];
  detail?: string;
  data?: unknown;
  operation?: SettingsActionResult['operation'];
}

/**
 * An adapter declares this before invoke when the owner may outlive the
 * request. The Host can then refuse before side effects if its durable record
 * authority or the owner's observation API is unavailable.
 */
export interface SettingsActionCapabilities {
  execution: 'sync' | 'async';
  operation?: {
    query: boolean;
    cancel?: boolean;
  };
}

export interface SettingsActionAdapter {
  /** Verbs this adapter implements; catalog declarations are intersected with this list. */
  verbs: readonly string[];
  describe(ctx: SettingsActionContext, entry: SettingsCatalogEntry): Promise<ActionStatus>;
  invoke(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    verb: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
  capabilities?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    verb: string,
    args: Record<string, unknown>,
  ): SettingsActionCapabilities | Promise<SettingsActionCapabilities>;
  /** Query an owner operation using the real identity returned by invoke. */
  getOperation?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    operationId: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
  /** Cancel an owner operation only when the owner exposes a real cancel API. */
  cancelOperation?(
    ctx: SettingsActionContext,
    entry: SettingsCatalogEntry,
    operationId: string,
    args: Record<string, unknown>,
  ): Promise<ActionInvocation>;
}

/* ── dep handles (narrow views over the real services) ──────────────────── */

export interface ExtensionRuntimeHandle {
  state(): Promise<unknown>;
  removeExtension?(request: Record<string, unknown>): Promise<unknown>;
  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<unknown>;
  selectWorkbenchProfile?(request: Record<string, unknown>): Promise<unknown>;
  updateWorkbenchLayout?(request: Record<string, unknown>): Promise<unknown>;
  applyWorkbenchProfile?(request: Record<string, unknown>): Promise<unknown>;
}

export interface TunnelHandle {
  resolveActiveMode(): unknown;
  resolveActiveProvider(): unknown;
  getPublicUrl(): string | null;
  checkAvailability(provider?: string): Promise<unknown>;
  start(input: Record<string, unknown>): Promise<unknown>;
  stop(): unknown;
}

export interface RemoteClientsHandle {
  listClients(): Promise<unknown> | unknown;
  hasActiveRelayClients(): Promise<boolean> | boolean;
  revokeClient?(id: string): Promise<unknown>;
}

export interface LanguageSupportHandle {
  getStatus(request: { workspaceId: string }): Promise<unknown>;
  prepareServer(request: { workspaceId: string; languageId: string }): Promise<unknown>;
  cancelServerPreparation(request: { workspaceId: string; languageId: string }): Promise<unknown>;
}

/** Profiles carry sshKey/signingKey secrets — never hand raw rows to callers. */
export interface GitIdentityStore {
  getProfiles(): import('../git/identity-storage.js').GitIdentityProfile[];
  getProfile(id: string): import('../git/identity-storage.js').GitIdentityProfile | null;
  createProfile(
    input: Partial<import('../git/identity-storage.js').GitIdentityProfile>
      & Pick<import('../git/identity-storage.js').GitIdentityProfile, 'id' | 'userEmail' | 'userName'>,
  ): import('../git/identity-storage.js').GitIdentityProfile;
  updateProfile(
    id: string,
    updates: Partial<Omit<import('../git/identity-storage.js').GitIdentityProfile, 'id'>>,
  ): import('../git/identity-storage.js').GitIdentityProfile;
  deleteProfile(id: string): true;
}

export interface SettingsActionDeps {
  semanticIndex?(): Pick<ReturnType<typeof import('../knowledge/semantic/index-management.js').createSemanticIndexManagement>, 'read' | 'save' | 'active' | 'activeDirectory' | 'configuredDirectory'>;
  models?(): import('../models/service.js').ModelsService | null;
  modelFetch?: import('./egress.js').EgressFetch;
  mcpSettings?(): Pick<ReturnType<typeof import('../mcp/settings.js').createMcpSettings>, 'invoke'> | null;
  agentProfiles?(): import('@varin/application-client').AgentProfilesAPI | null;
  extensionPackages?(): Pick<import('@varin/extension-host').ExtensionPackageManager, 'catalog'> | null;
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
  /** In-process host services; lazy getters because the service is created
   *  before several of them exist. Missing handle = domain unavailable. */
  extensionRuntime?(): ExtensionRuntimeHandle | null;
  tunnel?(): TunnelHandle | null;
  remoteClients?(): RemoteClientsHandle | null;
  languageSupport?(): LanguageSupportHandle | null;
  gitIdentities?: GitIdentityStore;
  gitHubAuthStatus?(): Promise<Record<string, unknown>>;
  /** Single connected surface kind when unambiguous (web/desktop/mobile). */
  surfaceHint?(): string | null;
  /** Project metadata writes go through the real app-document CAS pipeline. */
  readAppSettings(): Promise<Record<string, unknown>>;
  persistAppSettings(
    changes: Record<string, unknown>,
    removals: readonly string[],
    expectedRevision: string | undefined,
  ): Promise<AppPersistOutcome>;
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

const needString = (args: Record<string, unknown>, key: string): string => {
  const value = str(args, key);
  if (!value) throw new HarnessServiceError('invalid-params', `verb argument "${key}" is required`);
  return value;
};

const unavailable = (detail: string): ActionInvocation => ({ status: 'unavailable', detail });

const wrapError = (error: unknown): ActionInvocation => ({
  status: 'failed',
  detail: error instanceof Error ? error.message : String(error),
});

const sanitizeUrl = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|secret|key|password|credential/i.test(key)) parsed.searchParams.set(key, '[present]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
};

const sanitizeTextDocument = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const content = typeof value.content === 'string' ? value.content : undefined;
  return {
    ...Object.fromEntries(['exists', 'format', 'path', 'revision', 'root', 'scope'].flatMap((key) => (
      value[key] === undefined ? [] : [[key, value[key]]]
    ))),
    content: { isSet: content !== undefined && content.length > 0, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) },
  };
};

const authorizationResult = (state: import('@varin/application-client').AuthorizationState, operationId = state.id): ActionInvocation => ({
  status: state.status === 'pending' ? 'pending' : state.status === 'completed' ? 'applied' : 'failed',
  data: state,
  operation: { id: operationId, state: state.status === 'pending' ? 'running' : state.status === 'completed' ? 'succeeded' : state.status,
    ...(state.status === 'pending' ? { cancelVerb: 'cancel' } : {}) },
});

/** Connection headers and account secrets never enter agent-visible settings results. */
const safeModels = (snapshot: import('@varin/application-client').ModelConnectionsSnapshot) => ({
  revision: snapshot.revision, types: snapshot.types, issues: snapshot.issues,
  channels: snapshot.channels.map(({ connection, baseUrl, ...channel }) => ({ ...channel, baseUrl: sanitizeUrl(baseUrl),
    ...(connection ? { connection: { paths: connection.paths, headersConfigured: Boolean(connection.headers && Object.keys(connection.headers).length),
      ...(connection.proxy ? { proxy: { ...connection.proxy, ...('url' in connection.proxy ? { url: sanitizeUrl(connection.proxy.url) } : {}) } } : {}) } } : {}) })),
});
const providersAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'status', 'read', 'save', 'remove', 'connect', 'login', 'disconnect', 'discover-models', 'models', 'reply'],
  async describe() {
    const owner = deps.models?.();
    if (!owner) return { unavailable: 'Native model settings are unavailable' };
    const snapshot = await owner.read();
    return { summary: `${snapshot.channels.length} native model channels`, data: safeModels(snapshot) };
  },
  capabilities(_ctx, _entry, verb) {
    return ['connect', 'login'].includes(verb)
      ? { execution: 'async', operation: { query: true, cancel: true } } : { execution: 'sync' };
  },
  async getOperation(_ctx, _entry, id) {
    const owner = deps.models?.();
    return owner ? authorizationResult(owner.authorizations.read(id)) : unavailable('Native model authorization owner is unavailable');
  },
  async cancelOperation(_ctx, _entry, id) {
    const owner = deps.models?.();
    if (!owner) return unavailable('Native model authorization owner is unavailable');
    owner.authorizations.cancel(id);
    return authorizationResult(owner.authorizations.read(id));
  },
  async invoke(ctx, _entry, verb, args) {
    const owner = deps.models?.();
    if (!owner) return unavailable('Native model settings are unavailable');
    try {
      switch (verb) {
        case 'list': case 'status': case 'read': return { status: 'applied', data: safeModels(await owner.read()) };
        case 'save': return { status: 'applied', data: safeModels(await owner.save(args.channel as import('@varin/application-client').ModelChannel, needString(args, 'expectedRevision'))) };
        case 'remove': return { status: 'applied', data: safeModels(await owner.remove(needString(args, 'id'), needString(args, 'expectedRevision'))) };
        case 'connect': case 'login': return authorizationResult(owner.signIn(needString(args, 'provider'), needString(args, 'reference')));
        case 'reply': {
          const id = needString(args, 'operationId');
          owner.authorizations.reply(id, needString(args, 'redirect'));
          return authorizationResult(owner.authorizations.read(id));
        }
        case 'disconnect': await owner.removeCredential(needString(args, 'reference')); return { status: 'applied' };
        case 'models': return { status: 'applied', data: await owner.listModels() };
        case 'discover-models': {
          if (!deps.modelFetch) return unavailable('Model discovery egress is unavailable');
          return { status: 'applied', data: await owner.discover(needString(args, 'id'), deps.modelFetch, ctx.caller.signal) };
        }
        default: return unavailable(`Unsupported model action: ${verb}`);
      }
    } catch (error) { return wrapError(error); }
  },
});

const mcpAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => {
  const views = new Map<string, string>();
  const key = (ctx: SettingsActionContext) => JSON.stringify([ctx.caller.threadId, ctx.caller.branchId, ctx.workspaceRoot]);
  const call = (action: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const owner = deps.mcpSettings?.();
    if (!owner) throw new Error('Native MCP settings are unavailable');
    return owner.invoke(action, args, signal);
  };
  const view = async (ctx: SettingsActionContext): Promise<string> => {
    const known = views.get(key(ctx));
    if (known) return known;
    const opened = await call('open', { ...(ctx.workspaceRoot ? { cwd: ctx.workspaceRoot } : {}) }, ctx.caller.signal) as import('@varin/application-client').McpConfigurationSnapshot;
    views.set(key(ctx), opened.view); return opened.view;
  };
  const operation = (id: string): { view: string; id: string } => {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid MCP authorization identity');
    return { view: parsed[0] as string, id: parsed[1] as string };
  };
  return {
    verbs: ['status', 'read', 'write', 'reconnect', 'connect', 'disconnect', 'login', 'reply'],
    async describe(ctx) {
      if (!deps.mcpSettings?.()) return { unavailable: 'Native MCP settings are unavailable' };
      const snapshot = await call('read', { view: await view(ctx) }, ctx.caller.signal) as import('@varin/application-client').McpConfigurationSnapshot;
      return { summary: `${snapshot.servers.length} native MCP servers`, data: snapshot };
    },
    capabilities(_ctx, _entry, verb) {
      return verb === 'login' ? { execution: 'async', operation: { query: true, cancel: true } } : { execution: 'sync' };
    },
    async getOperation(ctx, _entry, id) {
      return authorizationResult(await call('authorization/read', operation(id), ctx.caller.signal) as import('@varin/application-client').AuthorizationState, id);
    },
    async cancelOperation(ctx, _entry, id) {
      const target = operation(id);
      await call('authorization/cancel', target, ctx.caller.signal);
      return authorizationResult(await call('authorization/read', target, ctx.caller.signal) as import('@varin/application-client').AuthorizationState, id);
    },
    async invoke(ctx, _entry, verb, args) {
      try {
        const selected = await view(ctx);
        switch (verb) {
          case 'status': return { status: 'applied', data: await call('read', { view: selected }, ctx.caller.signal) };
          case 'read': return { status: 'applied', data: str(args, 'path')
            ? sanitizeTextDocument(await call('document/read', { view: selected, path: needString(args, 'path') }, ctx.caller.signal))
            : await call('read', { view: selected }, ctx.caller.signal) };
          case 'write': {
            if (typeof args.content !== 'string') throw new Error('content is required');
            return { status: 'applied', data: sanitizeTextDocument(await call('document/save', { view: selected, path: needString(args, 'path'), content: args.content, expectedRevision: needString(args, 'expectedRevision') }, ctx.caller.signal)) };
          }
          case 'connect': case 'reconnect': case 'disconnect': return { status: 'applied', data: await call('command', { view: selected, name: needString(args, 'name'), command: verb }, ctx.caller.signal) };
          case 'login': {
            const state = await call('authorization/start', { view: selected, name: needString(args, 'name') }, ctx.caller.signal) as import('@varin/application-client').AuthorizationState;
            return authorizationResult(state, JSON.stringify([selected, state.id]));
          }
          case 'reply': {
            const id = needString(args, 'operationId'), target = operation(id);
            await call('authorization/reply', { ...target, redirect: needString(args, 'redirect') }, ctx.caller.signal);
            return authorizationResult(await call('authorization/read', target, ctx.caller.signal) as import('@varin/application-client').AuthorizationState, id);
          }
          default: return unavailable(`Unsupported MCP action: ${verb}`);
        }
      } catch (error) { return wrapError(error); }
    },
  };
};

const extensionPackagesAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'remove'],
  async describe() {
    const owner = deps.extensionPackages?.();
    if (!owner) return { unavailable: 'Native extension packages are unavailable' };
    return { summary: 'Native extension package catalog; stage/apply uses extension_package with admitted source capture', data: await owner.catalog.snapshot() };
  },
  async invoke(_ctx, _entry, verb, args) {
    const owner = deps.extensionPackages?.();
    if (!owner) return unavailable('Native extension packages are unavailable');
    try {
      if (verb === 'list') return { status: 'applied', data: await owner.catalog.snapshot() };
      if (verb !== 'remove') return unavailable('Stage and apply packages through extension_package');
      const runtime = deps.extensionRuntime?.();
      if (!runtime?.removeExtension) return unavailable('Native extension removal owner is unavailable');
      if (!Number.isSafeInteger(args.expectedRevision)) throw new Error('expectedRevision is required');
      return { status: 'applied', data: await runtime.removeExtension({ extensionId: needString(args, 'id'), expectedRevision: args.expectedRevision, deleteData: false }) };
    } catch (error) { return wrapError(error); }
  },
});

const agentsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'status', 'read', 'create', 'update', 'enable', 'disable', 'delete'],
  async describe(ctx) {
    const owner = deps.agentProfiles?.();
    if (!owner) return { unavailable: 'Native Agent profiles are unavailable' };
    const snapshot = await owner.read({ runtime: 'agent' }, ctx.caller.signal);
    return { summary: `${snapshot.profiles.length} native Agent profiles`, data: snapshot };
  },
  async invoke(ctx, _entry, verb, args) {
    const owner = deps.agentProfiles?.();
    if (!owner) return unavailable('Native Agent profiles are unavailable');
    try {
      if (['list', 'status', 'read'].includes(verb)) return { status: 'applied', data: await owner.read({ runtime: 'agent' }, ctx.caller.signal) };
      const expectedRevision = needString(args, 'expectedRevision');
      if (verb === 'delete') return { status: 'applied', data: await owner.remove({ runtime: 'agent', expectedRevision, id: needString(args, 'id') }, ctx.caller.signal) };
      let config = args.config as import('@varin/application-client').AgentProfileConfig;
      if (verb === 'enable' || verb === 'disable') {
        const current = await owner.read({ runtime: 'agent' }, ctx.caller.signal);
        const profile = current.profiles.find(value => value.id === needString(args, 'id'));
        if (!profile) throw new Error('Agent profile is unavailable');
        config = profile.config.kind === 'builtin'
          ? { ...profile.config, binding: { ...profile.config.binding, enabled: verb === 'enable' } }
          : { ...profile.config, agent: { ...profile.config.agent, enabled: verb === 'enable' } };
      }
      return { status: 'applied', data: await owner.save({ runtime: 'agent', expectedRevision,
        ...(verb !== 'create' ? { id: needString(args, 'id') } : {}), config,
        ...(args.tools !== undefined ? { tools: args.tools as string[] | null } : {}) }, ctx.caller.signal) };
    } catch (error) { return wrapError(error); }
  },
});

/**
 * Profiles hold sshKey/signingKey material. Agents get presence facts, never
 * secret values — the same rule as password fields on ordinary entries.
 */
const sanitizeGitProfile = (profile: import('../git/identity-storage.js').GitIdentityProfile) => ({
  id: profile.id,
  name: profile.name,
  host: profile.host,
  userName: profile.userName,
  userEmail: profile.userEmail,
  authType: profile.authType,
  icon: profile.icon,
  color: profile.color,
  signCommits: profile.signCommits,
  sshKey: { isSet: Boolean(profile.sshKey) },
  signingKey: { isSet: Boolean(profile.signingKey) },
});

const gitAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'list', 'create', 'update', 'delete'],
  async describe() {
    if (!deps.gitIdentities) return { unavailable: 'git identity store unavailable' };
    const profiles = deps.gitIdentities.getProfiles();
    return { summary: `${profiles.length} identities`, data: profiles.map(sanitizeGitProfile) };
  },
  async invoke(_ctx, entry, verb, args) {
    const identities = deps.gitIdentities;
    try {
      switch (verb) {
        case 'status': {
          if (entry.id === 'git.github-account') {
            if (!deps.gitHubAuthStatus) return unavailable('github auth service unavailable');
            return { status: 'applied', data: await deps.gitHubAuthStatus() };
          }
          return { status: 'applied', data: (identities?.getProfiles() ?? []).map(sanitizeGitProfile) };
        }
        case 'list':
          if (!identities) return unavailable('git identity store unavailable');
          return { status: 'applied', data: identities.getProfiles().map(sanitizeGitProfile) };
        case 'create': {
          if (!identities) return unavailable('git identity store unavailable');
          const userName = needString(args, 'userName');
          const userEmail = needString(args, 'userEmail');
          const id = str(args, 'id') ?? `git-id-${Date.now().toString(36)}`;
          return {
            status: 'applied',
            data: sanitizeGitProfile(identities.createProfile({
              id, userName, userEmail,
              ...(str(args, 'name') ? { name: str(args, 'name')! } : {}),
            })),
          };
        }
        case 'update': {
          if (!identities) return unavailable('git identity store unavailable');
          const id = needString(args, 'id');
          const updates: Partial<import('../git/identity-storage.js').GitIdentityProfile> = {};
          for (const key of ['userName', 'userEmail', 'name'] as const) {
            if (args[key] !== undefined) updates[key] = String(args[key]);
          }
          return { status: 'applied', data: sanitizeGitProfile(identities.updateProfile(id, updates)) };
        }
        case 'delete': {
          if (!identities) return unavailable('git identity store unavailable');
          identities.deleteProfile(needString(args, 'id'));
          return { status: 'applied', detail: 'identity deleted' };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the git owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const projectsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['rename', 'set-default-model', 'set-default-work-focus', 'set-color', 'set-icon'],
  async describe() {
    const document = await deps.readAppSettings();
    const projects = Array.isArray(document.projects) ? document.projects : [];
    return { summary: `${projects.length} projects`, data: projects };
  },
  async invoke(_ctx, entry, verb, args) {
    try {
      const document = await deps.readAppSettings();
      const projects = Array.isArray(document.projects) ? [...document.projects] : [];
      const projectId = str(args, 'projectId') ?? str(args, 'id');
      const findIndex = () => {
        if (!projectId) return -1;
        return projects.findIndex((p) => isRecord(p) && (p.id === projectId || p.path === projectId));
      };
      const patchProject = async (patch: Record<string, unknown>): Promise<ActionInvocation> => {
        const index = findIndex();
        if (index < 0) return { status: 'failed', detail: `unknown project "${projectId ?? ''}"` };
        const next = [...projects];
        next[index] = { ...(next[index] as Record<string, unknown>), ...patch };
        const outcome = await deps.persistAppSettings({ projects: next }, [], str(args, 'expectedRevision'));
        if (outcome.conflict) {
          return { status: 'failed', detail: `revision conflict — re-read and retry (current ${outcome.revision})` };
        }
        return { status: 'applied', detail: 'project updated', data: next[index] };
      };
      switch (verb) {
        case 'rename': {
          const label = str(args, 'name') ?? str(args, 'label');
          if (!label) throw new HarnessServiceError('invalid-params', 'verb argument "name" or "label" is required');
          return patchProject({ label });
        }
        case 'set-default-model':
          return patchProject({ defaultModel: str(args, 'model') ?? null });
        case 'set-default-work-focus':
          return patchProject({ defaultWorkFocus: needString(args, 'focus') ?? needString(args, 'workFocus') });
        case 'set-color':
          return patchProject({ color: str(args, 'color') ?? null });
        case 'set-icon':
          return patchProject({ icon: str(args, 'icon') ?? null });
        case 'list-actions':
          // Per-project action definitions live in the project config, read
          // by the surface that runs them; the host store only holds metadata.
          return unavailable('project actions are defined in the project config file and executed by a surface — list via the project config, run via a surface');
        case 'run-action':
          return unavailable('project actions execute in a connected surface (terminal tab / url / ssh forward) — not host-side');
        default:
          return unavailable(`verb "${verb}" is not supported by the projects owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const remoteInstancesAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'revoke'],
  async describe() {
    const clients = deps.remoteClients?.();
    if (!clients) return { unavailable: 'remote client auth service unavailable' };
    const [list, relayActive] = await Promise.all([
      Promise.resolve(clients.listClients()),
      Promise.resolve(clients.hasActiveRelayClients()),
    ]);
    const count = Array.isArray(list) ? list.length : 0;
    return {
      summary: `${count} paired clients, relay ${relayActive ? 'active' : 'idle'}`,
      data: list,
    };
  },
  async invoke(_ctx, _entry, verb, args) {
    const clients = deps.remoteClients?.();
    if (!clients) return unavailable('remote client auth service unavailable');
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: {
              clients: await Promise.resolve(clients.listClients()),
              relayActive: await Promise.resolve(clients.hasActiveRelayClients()),
            },
          };
        case 'revoke': {
          if (!clients.revokeClient) return unavailable('client revoke not supported by this service');
          const id = needString(args, 'clientId') ?? needString(args, 'id');
          return { status: 'applied', data: await clients.revokeClient(id) };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the remote-instances owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const WORKBENCH_SHELL_TARGET = 'shell';
const WORKBENCH_SURFACES = new Set(['web', 'desktop', 'mobile']);

/**
 * Write the `shell` replacement selection on the surface-keyed workbench
 * layout layer — mirrors the UI's persistReplacementSelection against the
 * host workbench document revision.
 */
const selectWorkbenchShell = async (
  runtime: ExtensionRuntimeHandle,
  deps: SettingsActionDeps,
  contributionId: string | null,
  args: Record<string, unknown>,
): Promise<ActionInvocation> => {
  const surfaceArg = str(args, 'surface');
  const hinted = surfaceArg ?? deps.surfaceHint?.() ?? undefined;
  if (!hinted || !WORKBENCH_SURFACES.has(hinted)) {
    return {
      status: 'failed',
      detail: `shell selection needs a target surface (${[...WORKBENCH_SURFACES].join('/')}) — pass args.surface`,
    };
  }
  const state = await runtime.state() as {
    workbench?: {
      document?: {
        revision?: number;
        layouts?: Record<string, unknown>[];
      };
    };
  };
  const document = state.workbench?.document;
  const revision = document?.revision;
  if (!document || typeof revision !== 'number') {
    return { status: 'unavailable', detail: 'workbench document has no readable revision' };
  }
  const scope = str(args, 'scopeId') ? 'workspace' : 'user';
  const scopeId = str(args, 'scopeId') ?? 'default';
  // Land the layer on the profile currently resolved for this surface.
  const profileId = str(args, 'profileId')
    ?? (() => {
      const match = (document.layouts ?? []).find((layer) => (
        layer.surface === hinted && layer.scope === scope && layer.scopeId === scopeId
      ));
      return typeof match?.profileId === 'string' ? match.profileId : 'default';
    })();
  const currentLayer = (document.layouts ?? []).find((layer) => (
    layer.profileId === profileId && layer.surface === hinted && layer.scope === scope && layer.scopeId === scopeId
  ));
  const replacementSelections = { ...((currentLayer?.replacementSelections ?? {}) as Record<string, string>) };
  if (contributionId === null) delete replacementSelections[WORKBENCH_SHELL_TARGET];
  else replacementSelections[WORKBENCH_SHELL_TARGET] = contributionId;
  return {
    status: 'applied',
    data: await runtime.updateWorkbenchLayout!({
      expectedRevision: revision,
      layer: {
        profileId,
        references: (currentLayer?.references as unknown[] | undefined) ?? [],
        replacementSelections,
        scope,
        scopeId,
        surface: hinted,
      },
    }),
  };
};

const workbenchExtensionsAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['list', 'enable', 'disable', 'select', 'clear', 'apply'],
  async describe() {
    const runtime = deps.extensionRuntime?.();
    if (!runtime) return { unavailable: 'extension runtime unavailable' };
    const state = await runtime.state().catch(() => null);
    return { summary: 'workbench extension catalog', data: state };
  },
  async invoke(_ctx, entry, verb, args) {
    const runtime = deps.extensionRuntime?.();
    if (!runtime) return unavailable('extension runtime unavailable');
    try {
      switch (verb) {
        case 'list':
          return { status: 'applied', data: await runtime.state() };
        case 'enable':
        case 'disable': {
          const extensionId = needString(args, 'extensionId');
          const revision = typeof args.expectedRevision === 'number'
            ? args.expectedRevision
            : Number(str(args, 'expectedRevision') ?? NaN);
          return {
            status: 'applied',
            data: await runtime.setEnabled(
              extensionId,
              verb === 'enable',
              Number.isFinite(revision) ? revision : 0,
            ),
          };
        }
        case 'select': {
          // extensions.workbench.profile → host workbench document profile
          // selection; extensions.workbench.shell → a surface-keyed layout
          // layer's shell replacement.
          if (entry.id === 'extensions.workbench.profile') {
            if (!runtime.selectWorkbenchProfile) return unavailable('workbench profile selection unavailable');
            const profileId = needString(args, 'profileId');
            const state = await runtime.state() as {
              workbench?: { document?: { revision?: number; profiles?: { id: string }[] } };
            };
            const revision = state.workbench?.document?.revision;
            if (typeof revision !== 'number') {
              return { status: 'unavailable', detail: 'workbench document has no readable revision' };
            }
            const known = state.workbench?.document?.profiles;
            if (Array.isArray(known) && !known.some((profile) => profile.id === profileId)) {
              return {
                status: 'failed',
                detail: `unknown workbench profile "${profileId}" — installed: ${known.map((profile) => profile.id).join(', ') || '(none)'}`,
              };
            }
            return {
              status: 'applied',
              data: await runtime.selectWorkbenchProfile({
                profileId,
                scope: 'user',
                scopeId: 'default',
                expectedRevision: revision,
              }),
            };
          }
          if (entry.id === 'extensions.workbench.shell') {
            if (!runtime.updateWorkbenchLayout) return unavailable('workbench layout update unavailable');
            const contributionId = str(args, 'contributionId');
            if (!contributionId) {
              return { status: 'failed', detail: 'select requires args.contributionId (shell contribution id from the catalog)' };
            }
            return selectWorkbenchShell(runtime, deps, contributionId, args);
          }
          return unavailable(`select is only supported on extensions.workbench.profile / extensions.workbench.shell`);
        }
        case 'clear': {
          if (entry.id !== 'extensions.workbench.shell') {
            return unavailable('clear is only supported on extensions.workbench.shell');
          }
          if (!runtime.updateWorkbenchLayout) return unavailable('workbench layout update unavailable');
          return selectWorkbenchShell(runtime, deps, null, args);
        }
        case 'apply': {
          if (!runtime.applyWorkbenchProfile) return unavailable('workbench profile apply unavailable');
          const profileId = needString(args, 'profileId');
          const catalogRevision = typeof args.expectedCatalogRevision === 'number'
            ? args.expectedCatalogRevision
            : Number(str(args, 'expectedCatalogRevision') ?? NaN);
          if (!Number.isFinite(catalogRevision)) {
            const state = await runtime.state() as { catalog?: { revision?: number } };
            const revision = state.catalog?.revision;
            if (typeof revision !== 'number') {
              return { status: 'failed', detail: 'apply requires args.expectedCatalogRevision — read the catalog first' };
            }
            return {
              status: 'applied',
              data: await runtime.applyWorkbenchProfile({ profileId, expectedCatalogRevision: revision }),
            };
          }
          return {
            status: 'applied',
            data: await runtime.applyWorkbenchProfile({ profileId, expectedCatalogRevision: catalogRevision }),
          };
        }
        default:
          return unavailable(`verb "${verb}" is not supported by the extension owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const languageSupportAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'prepare', 'cancel'],
  async describe(ctx) {
    const support = deps.languageSupport?.();
    if (!support) return { unavailable: 'language support service unavailable' };
    if (!ctx.caller.workspaceId) {
      return { summary: 'language support service (workspace-bound for status)' };
    }
    const status = await support.getStatus({ workspaceId: ctx.caller.workspaceId }).catch(() => null);
    return { summary: 'language support service', data: status };
  },
  async invoke(ctx, _entry, verb, args) {
    const support = deps.languageSupport?.();
    if (!support) return unavailable('language support service unavailable');
    if (!ctx.caller.workspaceId) return unavailable('language support requires a admitted project source');
    const workspaceId = ctx.caller.workspaceId;
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: await support.getStatus({ workspaceId }),
          };
        case 'prepare': {
          const languageId = needString(args, 'languageId');
          return {
            status: 'applied',
            data: await support.prepareServer({ workspaceId, languageId }),
          };
        }
        case 'cancel':
          return {
            status: 'applied',
            data: await support.cancelServerPreparation({
              workspaceId,
              languageId: needString(args, 'languageId'),
            }),
          };
        default:
          return unavailable(`verb "${verb}" is not supported by the language-support owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const tunnelAdapter = (deps: SettingsActionDeps): SettingsActionAdapter => ({
  verbs: ['status', 'start', 'stop'],
  async describe() {
    const tunnel = deps.tunnel?.();
    if (!tunnel) return { unavailable: 'tunnel service unavailable' };
    const url = tunnel.getPublicUrl();
    return {
      summary: url ? `active: ${url}` : 'inactive',
      data: { publicUrl: url, mode: tunnel.resolveActiveMode(), provider: tunnel.resolveActiveProvider() },
    };
  },
  async invoke(_ctx, _entry, verb, args) {
    const tunnel = deps.tunnel?.();
    if (!tunnel) return unavailable('tunnel service unavailable');
    try {
      switch (verb) {
        case 'status':
          return {
            status: 'applied',
            data: {
              publicUrl: tunnel.getPublicUrl(),
              mode: tunnel.resolveActiveMode(),
              provider: tunnel.resolveActiveProvider(),
              availability: await tunnel.checkAvailability(str(args, 'provider')),
            },
          };
        case 'start': {
          const input: Record<string, unknown> = {};
          if (str(args, 'provider')) input.provider = str(args, 'provider');
          if (str(args, 'mode')) input.mode = str(args, 'mode');
          return {
            status: 'applied',
            data: await tunnel.start(input),
          };
        }
        case 'stop':
          return { status: 'applied', data: await tunnel.stop() };
        default:
          return unavailable(`verb "${verb}" is not supported by the tunnel owner`);
      }
    } catch (error) {
      return wrapError(error);
    }
  },
});

const notificationsAdapter = (): SettingsActionAdapter => ({
  verbs: [],
  async describe() {
    return {
      summary: 'web push subscriptions are per-device and browser-granted',
      verbs: [],
      unavailable: 'push subscription belongs to each browser surface — an agent cannot subscribe another device',
    };
  },
  async invoke(_ctx, _entry, verb) {
    return unavailable(`verb "${verb}" is not supported — push subscription is per-device`);
  },
});

/* ── registry ───────────────────────────────────────────────────────────── */

export function createSettingsActionRegistry(deps: SettingsActionDeps) {
  const adapters = new Map<string, SettingsActionAdapter>([
    ['service:semantic-index', {
      verbs: ['read', 'write'],
      async describe() {
        const owner = deps.semanticIndex?.();
        if (!owner) return { unavailable: 'Index settings are unavailable' };
        const saved = await owner.read();
        return { data: { config: saved.config, revision: saved.revision, activeConfig: owner.active(),
          activeDirectory: owner.activeDirectory(), configuredDirectory: owner.configuredDirectory(saved.config) },
          ...(saved.error ? { unavailable: saved.error } : {}) };
      },
      async invoke(_ctx, _entry, verb, args) {
        const owner = deps.semanticIndex?.();
        if (!owner) return unavailable('Index settings are unavailable');
        try {
          if (verb === 'read') {
            const saved = await owner.read();
            return saved.error ? { status: 'failed', detail: saved.error, data: saved } : { status: 'applied', data: saved };
          }
          if (verb !== 'write') return unavailable(`Unsupported index action: ${verb}`);
          const saved = await owner.save(args.config, needString(args, 'revision'));
          return { status: 'applied', data: { ...saved, activeConfig: owner.active() } };
        } catch (error) { return wrapError(error); }
      },
    }],
    ['runtime:providers', providersAdapter(deps)],
    ['runtime:mcp', mcpAdapter(deps)],
    ['service:extension-packages', extensionPackagesAdapter(deps)],
    ['service:agents', agentsAdapter(deps)],
    ['service:git', gitAdapter(deps)],
    ['service:projects', projectsAdapter(deps)],
    ['service:remote-instances', remoteInstancesAdapter(deps)],
    ['service:extensions', workbenchExtensionsAdapter(deps)],
    ['runtime:language-support', languageSupportAdapter(deps)],
    ['service:tunnel', tunnelAdapter(deps)],
    ['service:notifications', notificationsAdapter()],
  ]);

  return {
    adapterFor(domain: string | undefined): SettingsActionAdapter | null {
      return domain ? adapters.get(domain) ?? null : null;
    },
  };
}

export type SettingsActionRegistry = ReturnType<typeof createSettingsActionRegistry>;
