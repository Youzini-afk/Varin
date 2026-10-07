/**
 * Agent-facing settings service (D-306 / Stage S).
 *
 * Serves the shared `SETTINGS_CATALOG` through the owning authorities:
 *  - `app`         → the Varin settings document via the serialized store
 *                    (CAS by content-hash revision, atomic multi-field writes).
 *  - `pi-settings` → Pi `settings.get`/`settings.update` on the workspace
 *                    worker (the same path the settings UI uses).
 *  - `client`      → one authenticated device Surface, which applies and
 *                    acknowledges its own local state.
 *  - `action`      → domain surfaces (extensions, providers, tunnel, …),
 *                    invoked through their existing owner APIs.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SETTINGS_CATALOG,
  getSettingsCatalogEntry,
  listSettingsCategories,
  querySettingsCatalog,
  type SettingsCatalogEntry,
  type SettingsFieldSpec,
} from '@varin/application-client';
import type {
  PiSettingsSnapshot,
  SettingsActionParams,
  SettingsActionResult,
  SettingsFieldResult,
  SettingsFieldValue,
  SettingsItemResult,
  SettingsReadParams,
  SettingsReadResult,
  SettingsSearchItem,
  SettingsSearchParams,
  SettingsSearchResult,
  SettingsUpdateItem,
  SettingsUpdateParams,
  SettingsUpdateResult,
} from '@varin/protocol';
import { mergeHarnessSettings } from '@varin/protocol';
import { HarnessServiceError } from './service-error.js';
import type { VarinSettingsDocument } from '@varin/settings-store';
import type {
  ActionInvocation,
  ActionStatus,
  SettingsActionCapabilities,
  SettingsActionRegistry,
} from './settings-actions.js';

export interface SettingsServiceCaller {
  workspaceId: string | null;
  sessionId: string;
}

export interface SettingsActionOperationStore {
  /** Exact entry-scoped lookup; operation ids are only meaningful for one entry/session. */
  get(caller: SettingsServiceCaller, entryId: string, operationId: string): Promise<{
    id: string;
    entryId: string;
    verb: string;
    state: NonNullable<SettingsActionResult['operation']>['state'];
    detail?: string;
    cancelVerb?: string;
    recordRevision?: number;
  } | null>;
  /** Host storage authority is available for a new async operation record. */
  available?(caller: SettingsServiceCaller): Promise<boolean>;
  put(caller: SettingsServiceCaller, operation: {
    id: string;
    entryId: string;
    verb: string;
    state: NonNullable<SettingsActionResult['operation']>['state'];
    detail?: string;
    cancelVerb?: string;
  }): Promise<void>;
}

export interface AppPersistOutcome {
  conflict: boolean;
  revision: string;
  document: VarinSettingsDocument;
}

export interface SettingsServiceDeps {
  readAppSettings(): Promise<VarinSettingsDocument>;
  /**
   * Serialized CAS write over the app settings document through the same
   * sanitize/merge/domain-effect pipeline as the UI writer. `changes` and
   * `removals` use top-level document keys; `expectedRevision` is checked
   * inside the store lock so concurrent UI writes are never overwritten.
   */
  persistAppSettings(
    changes: Record<string, unknown>,
    removals: readonly string[],
    expectedRevision: string | undefined,
  ): Promise<AppPersistOutcome>;
  /** Pi runtime settings authority for the caller's workspace. */
  requestPi(cwd: string, method: 'settings.get' | 'settings.update', params: unknown): Promise<PiSettingsSnapshot>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
  /** Best-effort dynamic option resolution; null = surface-resolved only. */
  resolveOptions?(
    source: string,
    caller: SettingsServiceCaller,
  ): Promise<{ value: string; label?: string }[] | null>;
  /** Domain-action adapters for `action` entries (Stage S). */
  actions?: SettingsActionRegistry;
  /** Durable owner operation references. Missing means async actions cannot be observed safely. */
  actionOperations?: SettingsActionOperationStore;
  /**
   * Targeted surface bridge for `client` entries. Absent = no live surface
   * channel — client entries report `unavailable` honestly.
   */
  clientSurfaces?: ClientSurfaceBridge;
  /** Fires once per successful write with the affected catalog ids. */
  onChanged?(change: {
    owner: 'app' | 'pi-settings' | 'client';
    ids: string[];
    scope: 'host' | 'global' | 'project' | 'client';
    revision: string;
  }): void;
}

/** A connected UI surface that owns device-local settings. */
export interface ClientSurfaceInfo {
  id: string;
  kind: 'desktop' | 'web' | 'mobile' | string;
}

export interface ClientSurfaceFieldResult {
  id: string;
  status: 'applied' | 'failed' | 'unavailable';
  error?: string;
  /** Current values after apply/read (surface-reported fact). */
  values?: Record<string, unknown>;
}

export interface ClientSurfaceBridge {
  /** Connected surfaces whose stream was Host-validated against one caller session. */
  listForSession(sessionId: string): ClientSurfaceInfo[];
  /**
   * Read or apply client-owned fields on one surface. The bridge resolves the
   * target: the Surface bound to the caller's authenticated session. Several
   * bound candidates = `ambiguous`; none = `unavailable`.
   */
  request(op: {
    type: 'read' | 'apply';
    entries: { id: string; values?: Record<string, unknown>; reset?: string[] }[];
  }, target: { sessionId: string }): Promise<{
    surface: ClientSurfaceInfo;
    results: ClientSurfaceFieldResult[];
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deterministic content-hash revision over the app settings document. */
export const settingsDocumentRevision = (document: VarinSettingsDocument): string =>
  createHash('sha256').update(JSON.stringify(sortDeep(document))).digest('hex').slice(0, 32);

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
};

const getPath = (document: Record<string, unknown>, path: string): unknown => {
  const segments = path.split('.');
  let cursor: unknown = document;
  for (const segment of segments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const setPath = (document: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isRecord(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
};

const deletePath = (document: Record<string, unknown>, path: string): void => {
  setPath(document, path, undefined);
};

const entryFields = (entry: SettingsCatalogEntry): readonly SettingsFieldSpec[] =>
  entry.fields ?? (entry.field ? [entry.field] : []);

const toSearchItem = (entry: SettingsCatalogEntry): SettingsSearchItem => ({
  id: entry.id,
  category: entry.category,
  owner: entry.owner,
  titleKey: entry.ui.titleKey,
  paths: entryFields(entry).map((field) => field.path),
  writable: entry.owner === 'app' || entry.owner === 'pi-settings',
  ...(entry.apply ? { apply: entry.apply } : {}),
  page: entry.ui.page,
  ...(entry.ui.keywords ? { keywords: [...entry.ui.keywords] } : {}),
  ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
});

const validateFieldValue = (field: SettingsFieldSpec, value: unknown): string | null => {
  if (value === null || value === undefined) {
    return field.nullable ? null : 'value is not nullable; use reset to clear';
  }
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
      if (field.integer && !Number.isInteger(value)) return 'expected an integer';
      if (field.min !== undefined && value < field.min) return `must be >= ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be <= ${field.max}`;
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string') return 'expected a string';
      return field.options?.some((option) => option.value === value)
        ? null
        : `expected one of: ${(field.options ?? []).map((option) => option.value).join(', ')}`;
    }
    case 'string':
      if (typeof value !== 'string') return 'expected a string';
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return null;
    case 'string-list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? null
        : 'expected an array of strings';
    case 'json':
      return value === undefined ? 'expected a JSON value' : null;
    case 'secret':
      return 'credential fields are status-only and cannot be written through this service';
    default:
      return null;
  }
};

interface OwnerWrite {
  entry: SettingsCatalogEntry;
  set: Record<string, unknown>;
  reset: string[];
  expectedRevision?: string | undefined;
}

/** Reject every item participating in a conflicting duplicate path before an owner write. */
const rejectConflictingDuplicatePaths = <T extends OwnerWrite>(writes: T[]): {
  accepted: T[];
  rejected: SettingsItemResult[];
} => {
  const mutations = new Map<string, { write: T; kind: 'set' | 'reset'; value?: unknown }[]>();
  for (const write of writes) {
    for (const [path, value] of Object.entries(write.set)) {
      mutations.set(path, [...(mutations.get(path) ?? []), { write, kind: 'set', value }]);
    }
    for (const path of new Set(write.reset)) {
      mutations.set(path, [...(mutations.get(path) ?? []), { write, kind: 'reset' }]);
    }
  }
  const conflicts = new Map<T, Set<string>>();
  for (const [path, entries] of mutations) {
    if (entries.length < 2) continue;
    const first = entries[0]!;
    const differs = entries.some((entry) => (
      entry.kind !== first.kind || (entry.kind === 'set' && !isDeepStrictEqual(entry.value, first.value))
    ));
    if (!differs) continue;
    for (const entry of entries) {
      const paths = conflicts.get(entry.write) ?? new Set<string>();
      paths.add(path);
      conflicts.set(entry.write, paths);
    }
  }
  return {
    accepted: writes.filter((write) => !conflicts.has(write)),
    rejected: writes.filter((write) => conflicts.has(write)).map((write) => {
      const paths = [...conflicts.get(write)!];
      return {
        id: write.entry.id,
        status: 'failed',
        error: `conflicting duplicate path(s) in owner batch: ${paths.join(', ')}`,
        fields: paths.map((path) => ({
          path,
          status: 'failed',
          error: 'the same owner path has incompatible set/reset values in this compound update',
        })),
      };
    }),
  };
};

export interface SettingsService {
  search(caller: SettingsServiceCaller, params: SettingsSearchParams): Promise<SettingsSearchResult>;
  read(caller: SettingsServiceCaller, params: SettingsReadParams): Promise<SettingsReadResult>;
  update(caller: SettingsServiceCaller, params: SettingsUpdateParams): Promise<SettingsUpdateResult>;
  /** Invoke a domain action on an `action` entry (D-309). */
  action(caller: SettingsServiceCaller, params: SettingsActionParams): Promise<SettingsActionResult>;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const search = async (
    caller: SettingsServiceCaller,
    params: SettingsSearchParams,
  ): Promise<SettingsSearchResult> => {
    const matches = querySettingsCatalog({
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.category !== undefined ? { category: params.category as never } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.id !== undefined ? { id: params.id } : {}),
    });
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const terms = [...new Set((params.query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
    const relatedScores = new Map<SettingsCatalogEntry, number>();
    if (!matches.length && !params.id && terms.length > 1) {
      for (const term of terms) {
        for (const entry of querySettingsCatalog({ query: term, ...(params.category ? { category: params.category as never } : {}), ...(params.owner ? { owner: params.owner } : {}) })) {
          relatedScores.set(entry, (relatedScores.get(entry) ?? 0) + 1);
        }
      }
    }
    const related = [...relatedScores].sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id))
      .slice(0, limit).map(([entry]) => toSearchItem(entry));
    const categories = new Map<string, number>();
    for (const entry of matches.length ? matches : querySettingsCatalog(params.owner ? { owner: params.owner } : {})) {
      categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    }
    const page = matches.slice(offset, offset + limit);
    const summaries = await summarizeSearchItems(caller, page);
    return {
      items: page.map((entry, index) => {
        const item = toSearchItem(entry);
        const summary = summaries[index];
        return summary ? { ...item, summary } : item;
      }),
      total: matches.length,
      ...(related.length ? { related } : {}),
      categories: [...categories.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  };

  /**
   * Progressive disclosure for search (S-B): simple entries carry the live
   * facts needed to decide a write — effective value/source for single-field
   * app+pi rows, declared verbs for action rows, connected-surface count for
   * client rows. Owner documents are fetched once per search, never per item.
   */
  const summarizeSearchItems = async (
    caller: SettingsServiceCaller,
    entries: readonly SettingsCatalogEntry[],
  ): Promise<(SettingsSearchItem['summary'] | undefined)[]> => {
    let appDocument: VarinSettingsDocument | null = null;
    let piSnapshot: PiSettingsSnapshot | null = null;
    const needApp = entries.some((entry) => entry.owner === 'app');
    const needPi = entries.some((entry) => entry.owner === 'pi-settings');
    if (needApp) appDocument = await deps.readAppSettings().catch(() => null);
    if (needPi && caller.workspaceId) {
      const root = await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null);
      if (root) piSnapshot = await deps.requestPi(root, 'settings.get', {}).catch(() => null);
    }
    const surfaceCount = deps.clientSurfaces?.listForSession(caller.sessionId).length ?? 0;
    const actionRoot = caller.workspaceId
      ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null)
      : null;
    const actionStatus = new Map<string, Promise<ActionStatus>>();
    return Promise.all(entries.map(async (entry) => {
      const fields = entryFields(entry);
      const single = fields.length === 1 ? fields[0]! : null;
      if (entry.owner === 'action') {
        const domain = entry.actionRef?.domain;
        const adapter = deps.actions?.adapterFor(domain) ?? null;
        if (!domain || !adapter) return { verbs: [] };
        let statusPromise = actionStatus.get(domain);
        if (!statusPromise) {
          statusPromise = adapter.describe({ caller, workspaceRoot: actionRoot }, entry)
            .catch((error: unknown): ActionStatus => ({
              unavailable: error instanceof Error ? error.message : String(error),
            }));
          actionStatus.set(domain, statusPromise);
        }
        const status = await statusPromise;
        if (status.unavailable) return { verbs: [] };
        const declared = entry.actionRef?.verbs ?? [];
        const supported = status.verbs ?? adapter.verbs;
        return { verbs: declared.filter((verb) => supported.includes(verb) && adapter.verbs.includes(verb)) };
      }
      if (entry.owner === 'client') {
        return { surfaces: surfaceCount };
      }
      if (!single) return undefined;
      const summary: NonNullable<SettingsSearchItem['summary']> = {
        fieldKind: single.kind,
        ...(single.options ? { options: single.options.map((o) => ({ value: o.value, ...(o.labelKey ? { label: o.labelKey } : {}) })) } : {}),
      };
      if (entry.owner === 'app' && appDocument) {
        const saved = getPath(appDocument, single.path);
        if (single.kind === 'secret') {
          summary.isSet = saved !== undefined && saved !== null && saved !== '';
          summary.source = summary.isSet ? 'user' : 'none';
        } else {
          summary.value = saved !== undefined ? saved : single.default;
          summary.source = saved !== undefined ? 'user' : single.default !== undefined ? 'default' : 'none';
        }
        return summary;
      }
      if (entry.owner === 'pi-settings' && piSnapshot) {
        const projectValue = single.scope === 'user' || !piSnapshot.projectTrusted
          ? undefined
          : getPath(piSnapshot.project, single.path);
        const globalValue = getPath(piSnapshot.global, single.path);
        const effective = projectValue ?? globalValue ?? single.default;
        if (single.kind === 'secret') {
          summary.isSet = effective !== undefined && effective !== null && effective !== '';
          summary.source = projectValue !== undefined ? 'project' : globalValue !== undefined ? 'user' : 'none';
        } else {
          summary.value = effective;
          summary.source = projectValue !== undefined ? 'project'
            : globalValue !== undefined ? 'user'
            : single.default !== undefined ? 'default' : 'none';
        }
        return summary;
      }
      // Owner unreachable — kind/options still help the caller shape a read.
      return summary;
    }));
  };

  const requireEntry = (id: string): SettingsCatalogEntry => {
    const entry = getSettingsCatalogEntry(id);
    if (!entry) {
      throw new HarnessServiceError('not-found', `unknown settings id "${id}" — search first for stable ids`);
    }
    return entry;
  };

  const resolveOptions = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
  ): Promise<{ value: string; label?: string }[] | undefined> => {
    const sources = new Set(
      fields.flatMap((field) => (field.optionsSource ? [field.optionsSource] : [])),
    );
    if (sources.size === 0 || !deps.resolveOptions) return undefined;
    const options: { value: string; label?: string }[] = [];
    for (const source of sources) {
      const resolved = await deps.resolveOptions(source, caller).catch(() => null);
      if (resolved) options.push(...resolved);
    }
    return options.length > 0 ? options : undefined;
  };

  const readApp = async (
    entry: SettingsCatalogEntry,
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    const document = await deps.readAppSettings();
    const fields = entryFields(entry);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const saved = getPath(document, field.path);
      if (field.kind === 'secret') {
        return { path: field.path, kind: field.kind, isSet: saved !== undefined && saved !== null && saved !== '' };
      }
      return { path: field.path, kind: field.kind, saved, isSet: saved !== undefined };
    });
    const effectiveFields = fields.filter((field) => field.kind !== 'secret');
    const effective = effectiveFields.length === 1
      ? (() => {
          const field = effectiveFields[0]!;
          const saved = getPath(document, field.path);
          return {
            value: saved !== undefined ? saved : field.default,
            source: (saved !== undefined ? 'user' : field.default !== undefined ? 'default' : 'none') as 'user' | 'default' | 'none',
          };
        })()
      : undefined;
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      revision: settingsDocumentRevision(document),
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const relatedIds = (entry: SettingsCatalogEntry): string[] =>
    SETTINGS_CATALOG
      .filter((candidate) => candidate.id !== entry.id && candidate.ui.page === entry.ui.page)
      .map((candidate) => candidate.id)
      .slice(0, 12);

  const optionBlock = async (
    caller: SettingsServiceCaller,
    fields: readonly SettingsFieldSpec[],
    detail: boolean,
  ): Promise<Pick<SettingsReadResult, 'options'>> => {
    if (!detail) return {};
    const options = await resolveOptions(caller, fields);
    return options ? { options } : {};
  };

  const readPi = async (
    entry: SettingsCatalogEntry,
    scope: 'global' | 'project' | 'effective',
    detail: boolean,
    caller: SettingsServiceCaller,
  ): Promise<SettingsReadResult> => {
    if (!caller.workspaceId) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: 'pi-settings require a workspace-bound session',
      };
    }
    const root = await deps.resolveWorkspaceRoot(caller.workspaceId);
    if (!root) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: `cannot resolve workspace root for ${caller.workspaceId}`,
      };
    }
    let snapshot: PiSettingsSnapshot;
    try {
      snapshot = await deps.requestPi(root, 'settings.get', {});
    } catch (error) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const fields = entryFields(entry);
    const trustedProject = snapshot.projectTrusted ? snapshot.project : {};
    const pickScope = (path: string, layer: 'global' | 'project') =>
      getPath(layer === 'global' ? snapshot.global : trustedProject, path);
    const values: SettingsFieldValue[] = fields.map((field) => {
      const layer = scope === 'effective' ? undefined : scope;
      const saved = layer ? pickScope(field.path, layer) : undefined;
      const projectIsSet = field.scope !== 'user' && pickScope(field.path, 'project') !== undefined;
      return layer
        ? { path: field.path, kind: field.kind, saved, isSet: saved !== undefined }
        : {
            path: field.path,
            kind: field.kind,
            saved: pickScope(field.path, 'global'),
            isSet: pickScope(field.path, 'global') !== undefined || projectIsSet,
          };
    });
    // Effective value: project override beats global for project-writable
    // fields; harness.* resolves through the owner's merge so user-only fields
    // behave exactly like the running product.
    const merged = mergeHarnessSettings(
      isRecord(snapshot.global.harness) ? snapshot.global.harness as never : {},
      isRecord(trustedProject.harness) ? trustedProject.harness as never : {},
    ) as unknown as Record<string, unknown>;
    const effectiveOf = (path: string): { value: unknown; source: 'user' | 'project' | 'default' | 'none' } => {
      const userOwned = fields.find((field) => field.path === path)?.scope === 'user';
      const project = userOwned ? undefined : pickScope(path, 'project');
      if (project !== undefined) return { value: project, source: 'project' };
      const global = pickScope(path, 'global');
      if (global !== undefined) return { value: global, source: 'user' };
      if (path.startsWith('harness.')) {
        const mergedValue = getPath(merged, path.slice('harness.'.length));
        if (mergedValue !== undefined) return { value: mergedValue, source: 'default' };
      }
      return { value: undefined, source: 'none' };
    };
    const fields0 = fields[0];
    const effective = fields.length === 1 && fields0
      ? effectiveOf(fields0.path)
      : undefined;
    const deniedProject = scope === 'project' && !snapshot.projectTrusted;
    return {
      state: deniedProject ? 'denied' : 'ok',
      entry: toSearchItem(entry),
      fields: values,
      ...(effective ? { effective } : {}),
      revisions: {
        global: snapshot.globalRevision,
        ...(snapshot.projectTrusted ? { project: snapshot.projectRevision } : {}),
      },
      ...(deniedProject ? { reason: 'project settings file is not trusted' } : {}),
      ...(detail ? { related: relatedIds(entry) } : {}),
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      ...(await optionBlock(caller, fields, detail)),
    };
  };

  const read = async (
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    const entry = requireEntry(params.id);
    const detail = params.detail === true;
    switch (entry.owner) {
      case 'app':
        if (params.scope === 'global' || params.scope === 'project') {
          throw new HarnessServiceError(
            'denied',
            `"${entry.id}" is host-owned; global/project scope is only valid for pi-settings entries`,
          );
        }
        return readApp(entry, detail, caller);
      case 'pi-settings':
        return readPi(entry, params.scope ?? 'effective', detail, caller);
      case 'client':
        return readClient(entry, caller, params);
      case 'action':
      default:
        return readAction(entry, caller, detail);
    }
  };

  /**
   * `client` entries live on the connected surface. A read asks the surface
   * for its own current values — when no single surface is addressable the
   * result stays honestly `unavailable`/`denied` instead of guessing.
   */
  const readClient = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsReadParams,
  ): Promise<SettingsReadResult> => {
    if (params.surface) {
      return {
        state: 'denied',
        entry: toSearchItem(entry),
        reason: 'surface selection is Host-resolved from the caller session; model supplied surface ids are not accepted',
      };
    }
    const bridge = deps.clientSurfaces;
    if (!bridge) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: 'device-local preference owned by the connected surface — no surface channel is registered on this host',
      };
    }
    let response;
    try {
      response = await bridge.request({
        type: 'read',
        entries: [{ id: entry.id }],
      }, { sessionId: caller.sessionId });
    } catch (error) {
      const code = error instanceof HarnessServiceError ? error.harnessCode : undefined;
      return {
        state: code === 'ambiguous' ? 'denied' : 'unavailable',
        entry: toSearchItem(entry),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const result = response.results.find((item) => item.id === entry.id);
    if (!result || result.status === 'unavailable') {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        reason: result?.error ?? `surface ${response.surface.id} does not own ${entry.id}`,
      };
    }
    if (result.status === 'failed') {
      return {
        state: 'malformed',
        entry: toSearchItem(entry),
        reason: result.error ?? 'surface failed to read the value',
      };
    }
    const values = result.values ?? {};
    const paths = Object.keys(values);
    return {
      state: 'ok',
      entry: toSearchItem(entry),
      fields: paths.map((path) => ({ path, kind: 'json', saved: values[path], isSet: values[path] !== undefined })),
      ...(paths.length === 1
        ? { effective: { value: values[paths[0]!], source: 'user' as const } }
        : {}),
      revision: `surface:${response.surface.id}`,
    };
  };

  /**
   * `action` entries describe a live domain surface. The adapter reports the
   * owner's real state and the verbs it can execute right now; without an
   * adapter the entry keeps its static pointer (still honest — not claimed).
   */
  const readAction = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    detail: boolean,
  ): Promise<SettingsReadResult> => {
    const adapter = deps.actions?.adapterFor(entry.actionRef?.domain) ?? null;
    const staticBlock = entry.actionRef
      ? {
          domain: entry.actionRef.domain,
          verbs: [] as string[],
          ...(entry.actionRef.note ? { note: entry.actionRef.note } : {}),
        }
      : undefined;
    if (!adapter) {
      return {
        state: 'action',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: staticBlock } : {}),
        reason: 'no owner adapter is wired for this domain on this host',
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    const status: ActionStatus = await adapter.describe(
      { caller, workspaceRoot: caller.workspaceId ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null) : null },
      entry,
    ).catch((error: unknown): ActionStatus => ({
      unavailable: error instanceof Error ? error.message : String(error),
    }));
    const liveVerbs = (entry.actionRef?.verbs ?? []).filter((verb) => adapter.verbs.includes(verb));
    if (status.unavailable) {
      return {
        state: 'unavailable',
        entry: toSearchItem(entry),
        ...(staticBlock ? { action: { ...staticBlock, verbs: [], status: status.unavailable } } : {}),
        reason: status.unavailable,
        ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
      };
    }
    return {
      state: 'action',
      entry: toSearchItem(entry),
      action: {
        domain: entry.actionRef?.domain ?? 'unknown',
        verbs: status.verbs ? status.verbs.filter((verb) => liveVerbs.includes(verb)) : liveVerbs,
        ...(entry.actionRef?.note ? { note: entry.actionRef.note } : {}),
        ...(status.summary ? { status: status.summary } : {}),
        ...(detail && status.data !== undefined ? { data: status.data } : {}),
      },
      ...(detail && entry.helpRef ? { help: entry.helpRef } : {}),
    };
  };

  const invokeAction = async (
    caller: SettingsServiceCaller,
    params: SettingsActionParams,
  ): Promise<SettingsActionResult> => {
    const entry = requireEntry(params.id);
    if (entry.owner !== 'action' || !entry.actionRef) {
      throw new HarnessServiceError('denied', `"${entry.id}" is not a domain action entry (owner=${entry.owner})`);
    }
    const adapter = deps.actions?.adapterFor(entry.actionRef.domain) ?? null;
    if (!adapter) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `no owner adapter is wired for ${entry.actionRef.domain}`,
      };
    }
    const args = params.args ?? {};
    const requestedOperationId = params.operationId
      ?? (typeof args.operationId === 'string' && args.operationId.trim() ? args.operationId.trim() : undefined);
    const workspaceRoot = caller.workspaceId
      ? await deps.resolveWorkspaceRoot(caller.workspaceId).catch(() => null)
      : null;
    const actionContext = { caller, workspaceRoot };
    const operationResult = (
      record: NonNullable<Awaited<ReturnType<NonNullable<SettingsActionOperationStore['get']>>>>,
    ): SettingsActionResult => ({
      status: record.state === 'running' ? 'pending' : record.state === 'unavailable' ? 'unavailable' : record.state === 'succeeded' ? 'applied' : 'failed',
      entry: toSearchItem(entry),
      verb: params.verb,
      ...(record.detail ? { detail: record.detail } : {}),
      operation: {
        id: record.id,
        state: record.state,
        ...(record.cancelVerb ? { cancelVerb: record.cancelVerb } : {}),
        ...(record.detail ? { detail: record.detail } : {}),
      },
    });
    const makeOperation = (
      id: string,
      state: NonNullable<ActionInvocation['operation']>['state'],
      detail?: string,
      cancelVerb?: string,
    ): NonNullable<ActionInvocation['operation']> => ({
      id,
      state,
      ...(detail ? { detail } : {}),
      ...(cancelVerb ? { cancelVerb } : {}),
    });
    const persistOperation = async (
      operation: NonNullable<ActionInvocation['operation']>,
      detail?: string,
      ownerVerb = params.verb,
    ): Promise<boolean> => {
      if (!deps.actionOperations || !caller.workspaceId) return false;
      try {
        await deps.actionOperations.put(caller, {
          id: operation.id,
          entryId: entry.id,
          verb: ownerVerb,
          state: operation.state,
          ...(detail ?? operation.detail ? { detail: detail ?? operation.detail } : {}),
          ...(operation.cancelVerb ? { cancelVerb: operation.cancelVerb } : {}),
        });
        return true;
      } catch {
        return false;
      }
    };
    if (requestedOperationId && (params.verb === 'status' || params.verb === 'cancel')) {
      const stored = await deps.actionOperations?.get(caller, entry.id, requestedOperationId).catch(() => null);
      if (!stored) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: `settings operation ${requestedOperationId} has no durable record for this session`,
        };
      }
      if (stored.entryId !== entry.id) {
        return { status: 'denied', entry: toSearchItem(entry), verb: params.verb, detail: 'operation does not belong to this settings entry' };
      }
      if (params.verb === 'status') {
        if (stored.state !== 'running') return operationResult(stored);
        if (!adapter.getOperation) {
          const detail = 'owner has no durable operation status API; completion cannot be inferred after this boundary';
          const unavailable = makeOperation(
            stored.id,
            'unavailable',
            detail,
          );
          await persistOperation(unavailable, detail, stored.verb);
          return {
            status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
            detail, operation: unavailable,
          };
        }
        const observed = await adapter.getOperation(actionContext, entry, stored.id, args).catch((error: unknown): ActionInvocation => ({
          status: 'unavailable',
          detail: error instanceof Error ? error.message : String(error),
          operation: { id: stored.id, state: 'unavailable' },
        }));
        const operation = observed.operation && observed.operation.id === stored.id
          ? observed.operation
          : observed.status === 'pending'
            ? makeOperation(stored.id, 'running', observed.detail, stored.cancelVerb)
            : makeOperation(stored.id, observed.status === 'applied' ? 'succeeded' : observed.status === 'unavailable' ? 'unavailable' : 'failed', observed.detail, stored.cancelVerb);
        if (!await persistOperation(operation, observed.detail, stored.verb)) {
          return {
            status: 'unavailable',
            entry: toSearchItem(entry),
            verb: params.verb,
            detail: 'owner state was observed, but Host could not commit the durable operation revision; query the same operation again',
            operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
          };
        }
        return {
          status: observed.status,
          entry: toSearchItem(entry),
          verb: params.verb,
          ...(observed.detail ? { detail: observed.detail } : {}),
          ...(observed.data !== undefined ? { data: observed.data } : {}),
          operation,
        };
      }
      if (stored.state !== 'running') return operationResult(stored);
      if (!stored.cancelVerb) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner does not expose a cancellation identity for this operation',
          operation: makeOperation(stored.id, stored.state, stored.detail),
        };
      }
      if (!adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner does not expose a cancellation API for this operation',
          operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
        };
      }
      const cancelled = await adapter.cancelOperation(actionContext, entry, stored.id, args).catch((error: unknown): ActionInvocation => ({
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
        operation: { id: stored.id, state: 'unavailable' },
      }));
      const cancellation = cancelled.operation && cancelled.operation.id === stored.id
        ? cancelled.operation
        : makeOperation(stored.id, cancelled.status === 'applied' ? 'cancelled' : cancelled.status === 'unavailable' ? 'unavailable' : 'running', cancelled.detail, stored.cancelVerb);
      if (!await persistOperation(cancellation, cancelled.detail, stored.verb)) {
        return {
          status: 'unavailable',
          entry: toSearchItem(entry),
          verb: params.verb,
          detail: 'owner cancellation returned, but Host could not commit the durable operation revision; query the same operation again',
          operation: makeOperation(stored.id, stored.state, stored.detail, stored.cancelVerb),
        };
      }
      return {
        status: cancelled.status,
        entry: toSearchItem(entry),
        verb: params.verb,
        ...(cancelled.detail ? { detail: cancelled.detail } : {}),
        ...(cancelled.data !== undefined ? { data: cancelled.data } : {}),
        operation: cancellation,
      };
    }
    const declared = entry.actionRef.verbs ?? [];
    if (declared.length > 0 && !declared.includes(params.verb) && params.verb !== 'status') {
      return {
        status: 'denied',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `verb "${params.verb}" is not declared on ${entry.id} — declared: ${declared.join(', ') || '(none)'}`,
      };
    }
    if (!adapter.verbs.includes(params.verb)) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `verb "${params.verb}" is not implemented by the ${entry.actionRef.domain} owner`,
      };
    }
    const capabilities: SettingsActionCapabilities = await (adapter.capabilities
      ? adapter.capabilities(actionContext, entry, params.verb, args)
      : { execution: 'sync' });
    const needsDurableOperation = capabilities.execution === 'async'
      || Boolean(capabilities.operation?.query);
    if (needsDurableOperation) {
      const operationStore = deps.actionOperations;
      const unavailableDetail = !caller.workspaceId
        ? 'asynchronous owner actions require a workspace-bound session'
        : !operationStore
          ? 'asynchronous owner actions require durable Host operation storage'
          : !capabilities.operation?.query
            ? 'owner marked this action asynchronous without a queryable operation identity'
            : !adapter.getOperation
              ? 'owner marked this action queryable but exposes no operation status API'
              : null;
      if (unavailableDetail) {
        return { status: 'unavailable', entry: toSearchItem(entry), verb: params.verb, detail: unavailableDetail };
      }
      if (capabilities.operation?.cancel && !adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner advertised cancellation but exposes no cancellation API',
        };
      }
      if (operationStore?.available && !await operationStore.available(caller).catch(() => false)) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'Host cannot durably record this owner operation for the workspace/session',
        };
      }
      if (!operationStore?.available) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'Host operation storage cannot prove durable availability before invoke',
        };
      }
    }
    const outcome: ActionInvocation = await adapter.invoke(
      actionContext,
      entry,
      params.verb,
      args,
    ).catch((error: unknown): ActionInvocation => ({
      status: 'failed' as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (outcome.status === 'pending' && !outcome.operation) {
      return {
        status: 'unavailable',
        entry: toSearchItem(entry),
        verb: params.verb,
        detail: `${outcome.detail ?? 'owner started an asynchronous action'}; owner returned no stable status/cancel operation identity`,
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    }
    if (outcome.operation) {
      const operationId = typeof outcome.operation.id === 'string' ? outcome.operation.id.trim() : '';
      if (!operationId) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned an operation without a stable identity',
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        };
      }
      if (outcome.operation.state === 'running' && !adapter.getOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned a running operation without a real status API',
          operation: { ...outcome.operation, id: operationId, state: 'unavailable' },
        };
      }
      if (outcome.operation.cancelVerb && !adapter.cancelOperation) {
        return {
          status: 'unavailable', entry: toSearchItem(entry), verb: params.verb,
          detail: 'owner returned a cancellation identity without a real cancellation API',
          operation: { ...outcome.operation, id: operationId, state: 'unavailable' },
        };
      }
      if (!outcome.operation.id || !(await persistOperation(outcome.operation, outcome.detail))) {
        return {
          status: 'unavailable',
          entry: toSearchItem(entry),
          verb: params.verb,
          detail: 'owner returned an operation identity but Host could not durably record it for this workspace/session',
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
        };
      }
    }
    return {
      status: outcome.status,
      entry: toSearchItem(entry),
      verb: params.verb,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.operation ? { operation: outcome.operation } : {}),
    };
  };

  /** One validated write spec — a single catalog entry plus its fields. */
  interface AppWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
    expectedRevision?: string | undefined;
  }

  /**
   * Commit one or more app-owner write specs in a single CAS transaction.
   * Per-item field validation decides membership; once at least one valid
   * field exists the merged change lands atomically — an item with zero valid
   * fields fails on its own without blocking the others.
   */
  const updateAppBatch = async (
    caller: SettingsServiceCaller,
    writes: AppWrite[],
    expectedRevision?: string,
  ): Promise<{
    items: SettingsItemResult[];
    revision?: string;
    effective?: Record<string, unknown>;
    document?: VarinSettingsDocument;
  }> => {
    const duplicateCheck = rejectConflictingDuplicatePaths(writes);
    writes = duplicateCheck.accepted;
    const itemResults: SettingsItemResult[] = [...duplicateCheck.rejected];
    const validSets: [string, unknown][] = [];
    const validResets: string[] = [];
    const validEntryIds: string[] = [];
    const allFields: SettingsFieldSpec[] = [];
    const current = await deps.readAppSettings();
    const currentRevision = settingsDocumentRevision(current);
    for (const write of writes) {
      const guard = write.expectedRevision ?? expectedRevision;
      if (guard !== undefined && guard !== currentRevision) {
        itemResults.push({
          id: write.entry.id,
          status: 'failed',
          error: `revision conflict — re-read and retry (current ${currentRevision})`,
          fields: [...Object.keys(write.set), ...write.reset].map((path) => ({
            path, status: 'failed', error: `revision conflict — re-read and retry (current ${currentRevision})`,
          })),
        });
        continue;
      }
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSets: [string, unknown][] = [];
      const itemResets: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be written through this service' });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSets.push([path, value]);
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential fields cannot be reset through this service' });
          continue;
        }
        itemResets.push(path);
      }
      if (itemSets.length === 0 && itemResets.length === 0) {
        itemResults.push({
          id: write.entry.id,
          status: 'failed',
          fields: fieldResults,
          error: 'no valid fields to write',
        });
        continue;
      }
      validSets.push(...itemSets);
      validResets.push(...itemResets);
      validEntryIds.push(write.entry.id);
      allFields.push(...entryFields(write.entry));
      itemResults.push({
        id: write.entry.id,
        status: fieldResults.length > 0 ? 'partial' : 'applied',
        fields: [
          ...itemSets.map(([path]): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResets.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (validSets.length === 0 && validResets.length === 0) {
      return { items: itemResults, revision: currentRevision };
    }
    // Nested paths collapse into their top-level key — the persist pipeline
    // merges whole top-level objects, so a partial nested write must
    // read-modify-write its root inside the CAS revision.
    const changes: Record<string, unknown> = {};
    const removals: string[] = [];
    const nestedRoots = new Map<string, Record<string, unknown>>();
    for (const [path, value] of validSets) {
      if (!path.includes('.')) {
        changes[path] = value;
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    for (const path of validResets) {
      if (!path.includes('.')) {
        removals.push(path);
        continue;
      }
      const rootKey = path.split('.')[0]!;
      const rootObject = nestedRoots.get(rootKey)
        ?? (isRecord(getPath(current, rootKey)) ? structuredClone(getPath(current, rootKey) as Record<string, unknown>) : {});
      nestedRoots.set(rootKey, rootObject);
      deletePath(rootObject, path.slice(rootKey.length + 1));
    }
    for (const [rootKey, rootObject] of nestedRoots) {
      changes[rootKey] = rootObject;
    }
    // Always CAS on the document we just merged against: without an explicit
    // expectedRevision a concurrent UI write between read and transact would
    // otherwise be silently clobbered.
    const outcome = await deps.persistAppSettings(
      changes,
      removals,
      currentRevision,
    );
    if (outcome.conflict) {
      for (const item of itemResults) {
        if (item.status !== 'applied' && item.status !== 'partial') continue;
        item.status = 'failed';
        item.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
        for (const field of item.fields ?? []) {
          if (field.status === 'applied') {
            field.status = 'failed';
            field.error = `revision conflict — re-read and retry (current ${outcome.revision})`;
          }
        }
      }
      return { items: itemResults, revision: outcome.revision };
    }
    const effective: Record<string, unknown> = {};
    for (const field of allFields) {
      if (field.kind === 'secret') continue;
      const value = getPath(outcome.document, field.path);
      effective[field.path] = value !== undefined ? value : field.default;
    }
    deps.onChanged?.({
      owner: 'app',
      ids: validEntryIds,
      scope: 'host',
      revision: outcome.revision,
    });
    for (const item of itemResults) {
      if (item.status === 'applied' || item.status === 'partial') item.revision = outcome.revision;
    }
    void caller;
    return { items: itemResults, revision: outcome.revision, effective, document: outcome.document };
  };

  const updateApp = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.surface) {
      throw new HarnessServiceError('denied', 'surface selection is Host-resolved from the caller session; model supplied surface ids are not accepted');
    }
    if (params.scope !== undefined) {
      throw new HarnessServiceError(
        'denied',
        `"${entry.id}" is host-owned; global/project scope is only valid for pi-settings entries`,
      );
    }
    const { items, revision, effective } = await updateAppBatch(
      caller,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [], expectedRevision: params.expectedRevision }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied' ? 'applied' : item.status === 'partial' ? 'partial' : 'failed',
      entry: toSearchItem(entry),
      scope: 'host',
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'immediate',
      ...(effective ? { effective } : {}),
    };
  };

  interface PiWrite {
    entry: SettingsCatalogEntry;
    set: Record<string, unknown>;
    reset: string[];
    expectedRevision?: string | undefined;
  }

  /**
   * Commit one or more pi-owner write specs at one scope in a single
   * `settings.update` call — the Pi authority's revision CAS covers the merged
   * top-level keys atomically.
   */
  const updatePiBatch = async (
    caller: SettingsServiceCaller,
    scope: 'global' | 'project',
    writes: PiWrite[],
    expectedRevision?: string,
  ): Promise<{ items: SettingsItemResult[]; revision?: string; effective?: Record<string, unknown> }> => {
    if (!caller.workspaceId) {
      throw new HarnessServiceError('unavailable', 'pi-settings updates require a workspace-bound session');
    }
    const root = await deps.resolveWorkspaceRoot(caller.workspaceId);
    if (!root) {
      throw new HarnessServiceError('unavailable', `cannot resolve workspace root for ${caller.workspaceId}`);
    }
    const duplicateCheck = rejectConflictingDuplicatePaths(writes);
    writes = duplicateCheck.accepted;
    const itemResults: SettingsItemResult[] = [...duplicateCheck.rejected];
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    const validEntryIds: string[] = [];
    let snapshot = await deps.requestPi(root, 'settings.get', {});
    const currentRevision = scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision;
    for (const write of writes) {
      const guard = write.expectedRevision ?? expectedRevision;
      if (guard !== undefined && guard !== currentRevision) {
        itemResults.push({
          id: write.entry.id,
          status: 'failed',
          error: `revision conflict — re-read and retry (current ${currentRevision})`,
          fields: [...Object.keys(write.set), ...write.reset].map((path) => ({
            path, status: 'failed', error: `revision conflict — re-read and retry (current ${currentRevision})`,
          })),
        });
        continue;
      }
      const byPath = new Map(entryFields(write.entry).map((field) => [field.path, field]));
      const fieldResults: SettingsFieldResult[] = [];
      const itemSetPaths: string[] = [];
      const itemResetPaths: string[] = [];
      for (const [path, value] of Object.entries(write.set)) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by Pi auth, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be written at project scope` });
          continue;
        }
        const problem = validateFieldValue(field, value);
        if (problem) {
          fieldResults.push({ path, status: 'failed', error: problem });
          continue;
        }
        itemSetPaths.push(path);
        set[path] = value;
      }
      for (const path of write.reset) {
        const field = byPath.get(path);
        if (!field) {
          fieldResults.push({ path, status: 'failed', error: `field "${path}" is not part of ${write.entry.id}` });
          continue;
        }
        if (field.kind === 'secret') {
          fieldResults.push({ path, status: 'failed', error: 'credential references are managed by Pi auth, not this service' });
          continue;
        }
        if (scope === 'project' && field.scope === 'user') {
          fieldResults.push({ path, status: 'failed', error: `"${path}" is user-owned and cannot be reset at project scope` });
          continue;
        }
        itemResetPaths.push(path);
        remove.push(path);
      }
      if (itemSetPaths.length === 0 && itemResetPaths.length === 0) {
        itemResults.push({
          id: write.entry.id, status: 'failed', fields: fieldResults, error: 'no valid fields to write',
        });
        continue;
      }
      validEntryIds.push(write.entry.id);
      itemResults.push({
        id: write.entry.id,
        status: fieldResults.length > 0 ? 'partial' : 'applied',
        fields: [
          ...itemSetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...itemResetPaths.map((path): SettingsFieldResult => ({ path, status: 'applied' })),
          ...fieldResults,
        ],
      });
    }
    if (Object.keys(set).length === 0 && remove.length === 0) {
      return { items: itemResults, revision: currentRevision };
    }
    // CAS: the pi authority pins the revision of the target scope file.
    // settings.update applies top-level keys only — nested paths
    // (harness.shell, …) are grouped into a read-modify-write of their root
    // object inside the same CAS revision.
    const layer = scope === 'project' ? snapshot.project : snapshot.global;
    const rootSets = new Map<string, Record<string, unknown>>();
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      setPath(rootObject, path.slice(rootKey.length + 1), value);
    }
    const nestedResets = new Map<string, string[]>();
    for (const path of remove) {
      if (!path.includes('.')) continue;
      const rootKey = path.split('.')[0]!;
      const currentRoot = getPath(layer, rootKey);
      const rootObject = rootSets.get(rootKey)
        ?? (isRecord(currentRoot) ? structuredClone(currentRoot) : {});
      rootSets.set(rootKey, rootObject);
      nestedResets.set(rootKey, [...(nestedResets.get(rootKey) ?? []), path.slice(rootKey.length + 1)]);
    }
    const topLevelSet: Record<string, unknown> = {};
    const topLevelRemove: string[] = [];
    for (const [path, value] of Object.entries(set)) {
      if (!path.includes('.')) topLevelSet[path] = value;
    }
    for (const path of remove) {
      if (!path.includes('.')) topLevelRemove.push(path);
    }
    for (const [rootKey, rootObject] of rootSets) {
      for (const sub of nestedResets.get(rootKey) ?? []) {
        deletePath(rootObject, sub);
      }
      topLevelSet[rootKey] = rootObject;
    }
    const updated = await deps.requestPi(root, 'settings.update', {
      scope,
      expectedRevision: currentRevision,
      set: topLevelSet,
      remove: topLevelRemove,
    }).catch((error: unknown) => {
      throw new HarnessServiceError('failed', error instanceof Error ? error.message : String(error));
    });
    snapshot = updated;
    const revision = scope === 'project' ? snapshot.projectRevision : snapshot.globalRevision;
    const effective: Record<string, unknown> = {};
    for (const path of [...Object.keys(set), ...remove]) {
      const nextLayer = scope === 'project' ? snapshot.project : snapshot.global;
      effective[path] = getPath(nextLayer, path);
    }
    deps.onChanged?.({
      owner: 'pi-settings',
      ids: validEntryIds,
      scope,
      revision,
    });
    for (const item of itemResults) {
      if (item.status === 'applied' || item.status === 'partial') item.revision = revision;
    }
    return { items: itemResults, revision, effective };
  };

  const updatePi = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const scope = params.scope ?? 'global';
    const { items, revision, effective } = await updatePiBatch(
      caller,
      scope,
      [{ entry, set: params.set ?? {}, reset: params.reset ?? [], expectedRevision: params.expectedRevision }],
      params.expectedRevision,
    );
    const item = items[0]!;
    const fields = item.fields ?? [];
    return {
      status: item.status === 'applied' ? 'applied' : item.status === 'partial' ? 'partial' : 'failed',
      entry: toSearchItem(entry),
      scope,
      fields,
      ...(revision ? { revision } : {}),
      appliedAt: entry.apply ?? 'next-run',
      ...(effective ? { effective } : {}),
    };
  };

  /**
   * `client` entries apply on the connected surface through the targeted
   * bridge — the surface's own store writes the value and reports the fact.
   */
  const updateClient = async (
    entry: SettingsCatalogEntry,
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams | SettingsUpdateItem,
  ): Promise<SettingsUpdateResult> => {
    const bridge = deps.clientSurfaces;
    if (!bridge) {
      throw new HarnessServiceError(
        'unavailable',
        `"${entry.id}" is device-local and no surface channel is registered on this host`,
      );
    }
    const byPath = new Map(entryFields(entry).map((field) => [field.path, field]));
    const values: Record<string, unknown> = {};
    const resets: string[] = [];
    const validation: SettingsFieldResult[] = [];
    for (const [path, value] of Object.entries(params.set ?? {})) {
      const field = byPath.get(path);
      const error = !field ? `field "${path}" is not part of ${entry.id}` : validateFieldValue(field, value);
      if (error) validation.push({ path, status: 'failed', error });
      else values[path] = value;
    }
    for (const path of params.reset ?? []) {
      const field = byPath.get(path);
      if (!field) validation.push({ path, status: 'failed', error: `field "${path}" is not part of ${entry.id}` });
      else if (Object.prototype.hasOwnProperty.call(values, path)) {
        validation.push({ path, status: 'failed', error: 'a field cannot be set and reset in the same update' });
        delete values[path];
      } else resets.push(path);
    }
    if (Object.keys(values).length === 0 && resets.length === 0) {
      return {
        status: 'failed', entry: toSearchItem(entry), scope: 'client', fields: validation,
        appliedAt: entry.apply ?? 'immediate',
      };
    }
    let response;
    try {
      response = await bridge.request({
        type: 'apply',
        entries: [{
          id: entry.id,
          values,
          ...(resets.length > 0 ? { reset: resets } : {}),
        }],
      }, { sessionId: caller.sessionId });
    } catch (error) {
      const code = error instanceof HarnessServiceError ? error.harnessCode : undefined;
      throw new HarnessServiceError(
        code === 'ambiguous' ? 'denied' : 'unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = response.results.find((item) => item.id === entry.id);
    const status = result?.status ?? 'unavailable';
    if (status === 'applied') {
      deps.onChanged?.({
        owner: 'client',
        ids: [entry.id],
        scope: 'client',
        revision: `surface:${response.surface.id}`,
      });
    }
    const appliedFields = [...Object.keys(values), ...resets].map((path): SettingsFieldResult => ({
      path,
      status: status === 'applied' ? 'applied' : 'failed',
      ...(result?.error ? { error: result.error } : {}),
    }));
    return {
      status: status === 'applied' ? (validation.length > 0 ? 'partial' : 'applied') : 'failed',
      entry: toSearchItem(entry),
      scope: 'client',
      fields: [...appliedFields, ...validation],
      appliedAt: entry.apply ?? 'immediate',
      surface: {
        id: response.surface.id,
        kind: response.surface.kind,
        results: (result ? [{ path: entry.id, status, ...(result.error ? { error: result.error } : {}) }] : []),
      },
      revision: `surface:${response.surface.id}`,
    };
  };

  /**
   * Compound update: validate every item, then execute per owner group.
   * Same-owner app items land in one CAS write; pi-settings merge per scope;
   * client items go to the resolved surface in one request; action entries
   * are reported as needing `settings.action`. Per-item results keep partial
   * success visible — no fake global transaction is implied.
   */
  const updateCompound = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    const items = params.items ?? [];
    const itemResults: SettingsItemResult[] = [];
    const appWrites: AppWrite[] = [];
    const piByScope = new Map<'global' | 'project', PiWrite[]>();
    const clientEntries: { entry: SettingsCatalogEntry; params: SettingsUpdateItem }[] = [];

    for (const item of items) {
      const entry = getSettingsCatalogEntry(item.id);
      if (!entry) {
        itemResults.push({ id: item.id, status: 'failed', error: `unknown settings id "${item.id}"` });
        continue;
      }
      switch (entry.owner) {
        case 'app':
          appWrites.push({ entry, set: item.set ?? {}, reset: item.reset ?? [], expectedRevision: item.expectedRevision });
          break;
        case 'pi-settings': {
          const scope = item.scope ?? 'global';
          const list = piByScope.get(scope) ?? [];
          list.push({ entry, set: item.set ?? {}, reset: item.reset ?? [], expectedRevision: item.expectedRevision });
          piByScope.set(scope, list);
          break;
        }
        case 'client': {
          if (item.surface || params.surface) {
            itemResults.push({ id: item.id, status: 'failed', error: 'surface selection is Host-resolved from the caller session; model supplied surface ids are not accepted' });
            break;
          }
          clientEntries.push({ entry, params: item });
          break;
        }
        case 'action':
        default:
          itemResults.push({
            id: item.id,
            status: 'failed',
            error: `"${item.id}" is a domain action — invoke it through settings.action`,
          });
      }
    }

    if (appWrites.length > 0) {
      const batch = await updateAppBatch(
        caller,
        appWrites,
      );
      itemResults.push(...batch.items);
    }
    for (const [scope, writes] of piByScope) {
      const batch = await updatePiBatch(caller, scope, writes);
      itemResults.push(...batch.items);
    }
    for (const clientEntry of clientEntries) {
      try {
        const result = await updateClient(clientEntry.entry, caller, clientEntry.params);
        itemResults.push({
          id: clientEntry.entry.id,
          status: result.status === 'applied' ? 'applied' : result.status === 'partial' ? 'partial' : 'failed',
          fields: result.fields,
          ...(result.revision ? { revision: result.revision } : {}),
        });
      } catch (error) {
        itemResults.push({
          id: clientEntry.entry.id,
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const firstKnown = getSettingsCatalogEntry(items[0]?.id ?? params.id)
      ?? items.map((item) => getSettingsCatalogEntry(item.id)).find((entry) => entry !== undefined);
    if (!firstKnown && itemResults.length === 0) {
      throw new HarnessServiceError('not-found', 'compound update had no known settings ids');
    }
    const failed = itemResults.filter((item) => item.status === 'failed' || item.status === 'unavailable');
    const partial = itemResults.filter((item) => item.status === 'partial');
    return {
      status: itemResults.length === 0
        ? 'failed'
        : failed.length === itemResults.length
          ? 'failed'
          : failed.length > 0 || partial.length > 0 ? 'partial' : 'applied',
      entry: firstKnown
        ? toSearchItem(firstKnown)
        : { id: items[0]?.id ?? params.id, category: '', owner: 'app', titleKey: '', paths: [], writable: false, page: '' },
      scope: 'host',
      fields: [],
      appliedAt: 'immediate',
      items: itemResults,
    };
  };

  const update = async (
    caller: SettingsServiceCaller,
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> => {
    if (params.items && params.items.length > 0) {
      return updateCompound(caller, params);
    }
    const entry = requireEntry(params.id);
    switch (entry.owner) {
      case 'app':
        return updateApp(entry, caller, params);
      case 'pi-settings':
        return updatePi(entry, caller, params);
      case 'client':
        return updateClient(entry, caller, params);
      case 'action':
      default:
        throw new HarnessServiceError(
          'denied',
          `"${entry.id}" is a domain action (${entry.actionRef?.domain ?? 'unknown'}) — invoke it through settings.action`,
        );
    }
  };

  return { search, read, update, action: invokeAction };
}

export { listSettingsCategories };
