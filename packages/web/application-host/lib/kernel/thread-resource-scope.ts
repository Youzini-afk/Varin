/** Host admission and original-source capture for instruction/skill resources.
 * WorkingState/Storage owns source bytes and receipts; this module owns no mutable catalog. */
import { randomUUID } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { InstalledAgentResourcePackage } from '@varin/pi-host/agent-resource-configuration';
import { canonicalBundleContains, createAgentResourceAuthority, type AdmittedAgentResourceScope, type PreparedAgentResources, type ResourceDomain } from '../agent-resources/authority.js';
import { isLocalPattern, parseResourceSettings } from '../agent-resources/configuration.js';
import { ancestorDirectories, CONTEXT_FILE_NAMES } from '../agent-resources/formats.js';
import { contentVersion, createAdmittedDirectoryReader, createCapsuleResourceReader, createDocumentResourceReader, createPinnedResourceReader,
  referenceKey, relativeResourcePath, resourceFailure, type ResourceDirectoryEntry, type ResourceDirectoryResult,
  type ResourceFailure, type ResourceFileResult, type ResourceReader } from '../agent-resources/source-reader.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { StableSourcePreparationOwners, SourceResourceCapturePlan } from '../harness/working-state/source-preparation.js';
import type { WorkspaceWorkingStateRootAccess, WorkingStateRootStore, WorkingStatePinnedRoot, WorkingOriginalSource } from '../harness/working-state/types.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';
import type { LiveSourceResolver } from './live-source.js';
import type { AgentResourceRequest, SourceResourceCapture, SourceResourceCapsule, SourceResourceTarget } from './protocol.generated.js';

export class ResourceScopeError extends Error {
  constructor(readonly failure: ResourceFailure) { super(failure.reason); this.name = 'ResourceScopeError'; }
}

interface ResourceContextScope { mode: 'agent' | 'bot'; threadRole: string; projectId: string | null }
export interface ResourceSourceReadInput {
  identity: ThreadIdentity;
  source: Exclude<ThreadSource, { mode: 'live_root' }>;
  paths: string[];
  runId?: string;
  signal?: AbortSignal;
}
export interface ResourceSourceReadView {
  store: Pick<WorkingStateRootStore, 'readPath' | 'listPaths' | 'readContent'>;
  pin: WorkingStatePinnedRoot;
  original: WorkingOriginalSource | null;
  admitSymlinkTarget?(finalPath: string): Promise<void>;
}
export interface ThreadResourceScopeOptions {
  runId?: string;
  request?: AgentResourceRequest;
  signal?: AbortSignal;
  instructionDirectories?: string[];
  supportingFiles?: { skillName: string; relativePath: string }[];
  /** Reads reauthorize and reopen exact declared handles; they do not prepare from current settings. */
  snapshot?: PreparedAgentResources;
}
export interface ThreadResourceScope {
  withScope<T>(identity: ThreadIdentity, source: ThreadSource | null, admitted: ResourceContextScope,
    consume: (binding: { admittedScope: AdmittedAgentResourceScope; readers: ResourceReader[] }) => Promise<T>, options?: ThreadResourceScopeOptions): Promise<T>;
  prepareSourceCapture: NonNullable<StableSourcePreparationOwners['prepareResources']>;
}
export interface ThreadResourceScopeOwners {
  agentDir: string;
  homeDir?: string;
  documents: Pick<DocumentAuthority, 'inspectWorkspace' | 'readSnapshot'>;
  workingStates: WorkspaceWorkingStateRootAccess;
  validateLiveSource: LiveSourceResolver;
  projectTrusted(root: string): boolean | Promise<boolean>;
  /** Existing Git owner resolves linked-worktree identity; no second Git parser. */
  resolvePrimaryWorktreeRoot?(directory: string): Promise<{ root: string }>;
  configuration(root?: string): Promise<{ packages: InstalledAgentResourcePackage[] }>;
  /** Existing Storage authority, readonly grant and exact branch/view. No physical root or effect methods. */
  withSourceRead?<T>(input: ResourceSourceReadInput, consume: (view: ResourceSourceReadView) => Promise<T>): Promise<T>;
}
const normalize = (value: string) => relativeResourcePath(value);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const domainId = (kind: string, root: string) => `${kind}:${contentVersion(root)}`;
const noCoverage = () => ({ kind: 'selected' as const, paths: [], subtrees: [] });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Validate the Host-owned payload after hydrating its original Storage blob. No coercion or fallback. */
export function parseSourceResourceCapture(value: unknown): SourceResourceCapture {
  const fail = (): never => { throw new Error('Working source resource capture is malformed'); };
  const record = (item: unknown): Record<string, unknown> => isRecord(item) ? item : fail();
  const text = (item: unknown): string => typeof item === 'string' ? item : fail();
  const relative = (item: unknown): string => { const value = text(item); if (normalize(value) !== value) fail(); return value; };
  const list = (item: unknown): unknown[] => Array.isArray(item) ? item : fail();
  const location = (item: unknown) => { const data = record(item); text(data.domainId); text(data.viewId); relative(data.path); return data; };
  const capsule = (item: unknown): void => {
    const data = record(item); text(data.domainId); text(data.viewId); text(data.displayRoot);
    for (const file of list(data.files)) {
      const body = record(file); const ref = location(body.reference); text(ref.canonicalId); text(ref.version); text(body.content);
      if (ref.domainId !== data.domainId || ref.viewId !== data.viewId) fail();
    }
    for (const directory of list(data.directories)) {
      const entry = record(directory); relative(entry.path); text(entry.version);
      if (entry.canonicalId !== undefined) text(entry.canonicalId);
      for (const child of list(entry.entries)) {
        const childEntry = record(child); const name = text(childEntry.name);
        if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') fail();
        if (!['file', 'directory', 'symlink', 'unsupported'].includes(text(childEntry.kind))) fail();
      }
    }
    for (const missing of list(data.missing)) relative(missing);
    for (const failure of list(data.failures)) {
      const item = location(failure); text(item.reason);
      if (!['missing', 'invalid', 'denied', 'unavailable', 'stale', 'cancelled'].includes(text(item.status))) fail();
      if (item.domainId !== data.domainId || item.viewId !== data.viewId) fail();
    }
  };
  const target = (item: unknown): void => {
    const data = record(item); relative(data.directory);
    if (data.kind === 'capsule') capsule(data.capsule); else if (data.kind !== 'source') fail();
  };
  const data = record(value); text(data.root); relative(data.cwd); relative(data.skillAncestorBoundary);
  const coverage = record(data.coverage);
  if (coverage.kind === 'selected') {
    for (const entry of [...list(coverage.paths), ...list(coverage.subtrees)]) relative(entry);
  } else if (coverage.kind !== 'complete') fail();
  for (const item of list(data.ancestors)) {
    const ancestor = record(item); capsule(ancestor.capsule); text(ancestor.appliesTo);
    if (typeof ancestor.includeSkills !== 'boolean') fail();
  }
  for (const item of list(data.configuredPaths)) { const entry = record(item); text(entry.configuredPath); target(entry.target); }
  for (const item of list(data.installedPackages)) { const entry = record(item); text(entry.identity); text(entry.source); target(entry.target); }
  for (const item of list(data.sourceLinks)) { const entry = record(item); relative(entry.path); target(entry.target); }
  if (!strings(data.shadowedContextCanonicalIds)) fail();
  return structuredClone(value) as SourceResourceCapture;
}

function capsuleReader(capsule: SourceResourceCapsule): ResourceReader {
  const reader = createCapsuleResourceReader(capsule);
  return { ...reader,
    async read(target, signal) {
      const result = await reader.read(target, signal);
      return result.status === 'unavailable' ? capsule.failures.find(item => item.path === target) ?? result : result;
    },
    async list(target, signal) {
      const result = await reader.list(target, signal);
      return result.status === 'unavailable' ? capsule.failures.find(item => item.path === target) ?? result : result;
    },
  };
}
/** Resource-only Host admission may follow an actually requested instruction/skill alias.
 * The resulting handle remains capture-only; this creates no model file or process grant. */
async function resourceAssetReader(root: string, id: string, viewId: string): Promise<ResourceReader> {
  const base = await createAdmittedDirectoryReader({ root, domainId: id, viewId });
  const target = async (relative: string): Promise<{ reader: ResourceReader; path: string } | undefined> => {
    const canonical = await canonicalizePathIdentity(path.join(root, normalize(relative)), { allowMissing: true });
    if (isPathWithinRoot(canonical, root)) return undefined;
    let directory = canonical; let file = '';
    try { if (!(await stat(canonical)).isDirectory()) { directory = path.dirname(canonical); file = path.basename(canonical); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { reader: await createAdmittedDirectoryReader({ root: directory, domainId: id, viewId }), path: file };
  };
  const reader: ResourceReader = { ...base,
    async read(relative, signal) {
      const result = await base.read(relative, signal);
      if (result.status !== 'denied') return result;
      const alias = await target(relative); return alias ? remap(reader, relative, await alias.reader.read(alias.path, signal)) : result;
    },
    async list(relative, signal) {
      let result = await base.list(relative, signal);
      if (result.status === 'denied') { const alias = await target(relative); if (alias) result = remap(reader, relative, await alias.reader.list(alias.path, signal)); }
      if (result.status !== 'ready') return result;
      const entries: ResourceDirectoryEntry[] = [];
      for (const entry of result.entries) {
        if (entry.kind !== 'symlink') { entries.push(entry); continue; }
        try { const info = await stat(path.join(root, relative, entry.name));
          entries.push({ ...entry, kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported' }); }
        catch (error) { if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; entries.push(entry); }
      }
      return { ...result, entries, reference: { ...result.reference, version: contentVersion(JSON.stringify(entries)) } };
    },
  };
  return reader;
}

function targetDomain(target: SourceResourceTarget, source: ResourceReader, root: string): ResourceDomain {
  return target.kind === 'source' ? { reader: source, directory: target.directory, displayRoot: root }
    : { reader: capsuleReader(target.capsule), directory: target.directory, displayRoot: target.capsule.displayRoot };
}
function remap<T extends ResourceFileResult | ResourceDirectoryResult>(reader: ResourceReader, target: string, result: T): T {
  return (result.status === 'ready' ? { ...result, reference: { ...result.reference, domainId: reader.domainId, viewId: reader.viewId, path: target } }
    : { ...result, domainId: reader.domainId, viewId: reader.viewId, path: target }) as T;
}
function withSourceLinks(base: ResourceReader, capture: SourceResourceCapture): ResourceReader {
  const mapped = capture.sourceLinks.map(link => ({ ...link, domain: targetDomain(link.target, base, capture.root) }));
  const locate = (value: string) => mapped.filter(link => value === link.path || value.startsWith(`${link.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const reader: ResourceReader = { ...base,
    async read(target, signal) {
      const normalized = normalize(target); const link = locate(normalized);
      if (!link) return base.read(normalized, signal);
      const relative = normalize(path.posix.join(link.domain.directory ?? '', normalized.slice(link.path.length).replace(/^\//, '')));
      return remap(reader, normalized, await link.domain.reader.read(relative, signal));
    },
    async list(target, signal) {
      const normalized = normalize(target); const link = locate(normalized);
      if (!link) return base.list(normalized, signal);
      const relative = normalize(path.posix.join(link.domain.directory ?? '', normalized.slice(link.path.length).replace(/^\//, '')));
      return remap(reader, normalized, await link.domain.reader.list(relative, signal));
    },
  };
  return reader;
}

/** A temporary recorder owns exactly the observed capsule, never a persistent filesystem index. */
function recordReader(base: ResourceReader, displayRoot: string) {
  const files = new Map<string, SourceResourceCapsule['files'][number]>();
  const directories = new Map<string, SourceResourceCapsule['directories'][number]>();
  const missing = new Set<string>();
  const failures = new Map<string, ResourceFailure>();
  const reads = new Map<string, ResourceFileResult>();
  const lists = new Map<string, ResourceDirectoryResult>();
  const observe = (target: string, result: ResourceFileResult | ResourceDirectoryResult) => {
    if (result.status === 'missing') missing.add(target);
    else if (result.status !== 'ready' && result.status !== 'invalid') failures.set(target, result);
    else if (result.status === 'invalid') failures.set(target, result);
    else { missing.delete(target); failures.delete(target); }
  };
  const reader: ResourceReader = { ...base,
    async read(target, signal) {
      const relative = normalize(target); const result = await base.read(relative, signal); observe(relative, result); reads.set(relative, result);
      if (result.status === 'ready') files.set(relative, { reference: result.reference, content: result.content });
      return result;
    },
    async list(target, signal) {
      const relative = normalize(target); const result = await base.list(relative, signal); observe(relative, result); lists.set(relative, result);
      if (result.status === 'ready') directories.set(relative, { path: relative, entries: result.entries,
        version: result.reference.version, canonicalId: result.reference.canonicalId });
      return result;
    },
  };
  return { reader, reads, lists,
    exclude(target: string, failure: ResourceFailure) { files.delete(target); directories.delete(target); failures.set(target, failure); },
    capsule: (): SourceResourceCapsule => ({ domainId: base.domainId, viewId: base.viewId, displayRoot,
      files: [...files.values()], directories: [...directories.values()], missing: [...missing], failures: [...failures.values()] }),
    async validate(signal?: AbortSignal) {
      for (const [target, previous] of reads) {
        const current = await base.read(target, signal);
        if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Source resource changed during capture');
      }
      for (const [target, previous] of lists) {
        const current = await base.list(target, signal);
        if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Source resource directory changed during capture');
      }
    },
  };
}

/** Listing stays on the existing native inventory/capture owner, not a second workspace scanner. */
async function listSourceDirectory(store: WorkingStateRootStore, root: string, reader: Pick<ResourceReader, 'domainId' | 'viewId'>,
  relative: string, signal?: AbortSignal): Promise<ResourceDirectoryResult> {
  const paths = await store.listCaptureScopePaths(root, [relative || '.'], signal);
  const prefix = relative ? `${relative}/` : '';
  const children = new Set<string>();
  for (const entry of paths) {
    if (!entry.startsWith(prefix) || entry === relative) continue;
    children.add(`${prefix}${entry.slice(prefix.length).split('/')[0]!}`);
  }
  const targets = sorted([...children, ...(relative ? [relative] : [])]);
  const states = await store.captureDirectory(root, targets, { store: false, ...(signal ? { signal } : {}) });
  if (relative && states[relative]?.kind !== 'directory') return resourceFailure(reader, relative,
    !states[relative] || states[relative].kind === 'missing' ? 'missing' : 'invalid', 'Resource is not a captured directory');
  const entries: ResourceDirectoryEntry[] = [];
  for (const target of sorted(children)) {
    const state = states[target]; if (!state || state.kind === 'missing') continue;
    let kind: ResourceDirectoryEntry['kind'] = state.kind === 'regular-file' ? 'file' : state.kind;
    if (kind === 'symlink') {
      try { const info = await stat(path.join(root, target)); kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error; }
    }
    entries.push({ name: path.posix.basename(target), kind });
  }
  return { status: 'ready', reference: { ...reader, path: relative, canonicalId: `document:${reader.domainId.slice('workspace:'.length)}/${relative}`, version: contentVersion(JSON.stringify(entries)) }, entries };
}

function domainReaders(scope: AdmittedAgentResourceScope): ResourceReader[] {
  const domains = [scope.project, scope.user, scope.userAgents, ...scope.ancestors ?? [],
    ...scope.configuredPaths?.map(item => item.target) ?? [], ...scope.installedPackages ?? []];
  return [...new Map(domains.filter((item): item is ResourceDomain => Boolean(item)).map(item => [referenceKey({ ...item.reader, path: '' }), item.reader])).values()];
}
function capturedSettings(file: Extract<ResourceFileResult, { status: 'ready' }>) {
  try { return parseResourceSettings(file.content); }
  catch { throw new ResourceScopeError(resourceFailure(file.reference, file.reference.path, 'invalid', 'Resource settings are malformed')); }
}
const configuredAbsolute = (raw: string, base: string, home: string) => raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\')
  ? path.resolve(home, raw.slice(2)) : path.resolve(base, raw);

export function createThreadResourceScope(owners: ThreadResourceScopeOwners): ThreadResourceScope {
  const home = path.resolve(owners.homeDir ?? process.env.HOME ?? os.homedir());
  const agentDir = path.resolve(owners.agentDir);
  const authority = createAgentResourceAuthority();

  const freshDomain = async (root: string, kind: string, snapshot?: PreparedAgentResources): Promise<ResourceDomain> => {
    const canonical = await canonicalizePathIdentity(root, { allowMissing: true });
    const id = domainId(kind, root);
    const previous = snapshot?.readers.find(reader => reader.domainId === id);
    return { reader: await resourceAssetReader(canonical, id, previous?.viewId ?? `resource-capture:${randomUUID()}`), displayRoot: canonical };
  };
  const addUser = async (scope: AdmittedAgentResourceScope, options: ThreadResourceScopeOptions) => {
    scope.user = await freshDomain(agentDir, 'agent-dir', options.snapshot);
    scope.userAgents = await freshDomain(path.join(home, '.agents'), 'home-agents', options.snapshot);
    if (options.snapshot) return;
    const settings = await scope.user.reader.read('settings.json', options.signal);
    if (settings.status === 'ready') {
      for (const configuredPath of capturedSettings(settings).skills.filter(value => !isLocalPattern(value))) {
        const absolute = configuredAbsolute(configuredPath, agentDir, home);
        if (isPathWithinRoot(absolute, agentDir) && !path.isAbsolute(configuredPath) && !configuredPath.startsWith('~')) continue;
        const canonical = await canonicalizePathIdentity(absolute, { allowMissing: true });
        let directory = ''; let root = canonical;
        try { if (!(await stat(canonical)).isDirectory()) { directory = path.basename(canonical); root = path.dirname(canonical); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const target = await freshDomain(root, 'configured-user'); target.directory = directory;
        (scope.configuredPaths ??= []).push({ scope: 'user', configuredPath, target, independentUserResource: true });
      }
    }
    const configuration = await owners.configuration();
    for (const pkg of configuration.packages.filter(item => item.scope === 'user')) {
      (scope.installedPackages ??= []).push({ ...await freshDomain(pkg.installedPath, 'user-package'), identity: pkg.identity, source: pkg.source, scope: 'user' });
    }
  };

  const prepareSourceCapture: ThreadResourceScope['prepareSourceCapture'] = async input => {
    const { store, directory: root, workspaceId, signal } = input;
    const trusted = await owners.projectTrusted(root);
    const captures = new Map<string, ReturnType<typeof recordReader>>();
    const scopes = new Set<string>();
    const sourcePaths = new Set<string>();
    const sourceLinks = new Map<string, { target: SourceResourceTarget; root: string; directory: string; reader: ResourceReader }>();
    const projectId = `workspace:${workspaceId}`;
    const sourceView = `source-capture:${randomUUID()}`;
    const captureDomain = async (absolute: string): Promise<{ target: SourceResourceTarget; reader: ResourceReader; directory: string; root: string }> => {
      const canonical = await canonicalizePathIdentity(absolute, { allowMissing: true });
      let directory = ''; let domainRoot = canonical;
      try { if (!(await stat(canonical)).isDirectory()) { directory = path.basename(canonical); domainRoot = path.dirname(canonical); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (isPathWithinRoot(canonical, root)) {
        const relative = normalize(path.relative(root, canonical)); scopes.add(relative); sourcePaths.add(relative);
        return { target: { kind: 'source', directory: relative }, reader: source, directory: relative, root };
      }
      let captured = captures.get(domainRoot);
      if (!captured) {
        captured = recordReader(await resourceAssetReader(domainRoot, domainId('source-dependency', domainRoot), `source-capsule:${randomUUID()}`), domainRoot);
        captures.set(domainRoot, captured);
      }
      return { target: { kind: 'capsule', capsule: captured.capsule(), directory }, reader: captured.reader, directory, root: domainRoot };
    };
    const external = async (relative: string) => {
      const mapped = [...sourceLinks].filter(([alias]) => relative === alias || relative.startsWith(`${alias}/`)).sort(([a], [b]) => b.length - a.length)[0];
      const resolved = await canonicalizePathIdentity(path.join(root, relative), { allowMissing: true });
      if (mapped && isPathWithinRoot(resolved, mapped[1].root)) return { ...mapped[1], path: normalize(path.posix.join(mapped[1].directory, relative.slice(mapped[0].length).replace(/^\//, ''))) };
      if (!mapped && isPathWithinRoot(resolved, root)) {
        // Same-source aliases must also capture a Git-ignored target, never read it later from disk.
        if (path.resolve(root, relative) !== resolved) {
          const target = normalize(path.relative(root, resolved)); scopes.add(target); sourcePaths.add(target);
        }
        return undefined;
      }
      const parts = relative.split('/'); let alias = relative;
      for (let length = mapped ? mapped[0].split('/').length + 1 : 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join('/');
        const actual = await canonicalizePathIdentity(path.join(root, prefix), { allowMissing: true });
        if (!isPathWithinRoot(actual, mapped?.[1].root ?? root)) { alias = prefix; break; }
      }
      const admitted = await captureDomain(await canonicalizePathIdentity(path.join(root, alias), { allowMissing: true }));
      sourceLinks.set(alias, admitted);
      return { ...admitted, path: normalize(path.posix.join(admitted.directory, relative.slice(alias.length).replace(/^\//, ''))) };
    };
    const base = createDocumentResourceReader({ domainId: projectId, viewId: sourceView, workspaceId: input.captureWorkspaceId,
      documents: owners.documents, list: (relative, signal) => listSourceDirectory(store, root, { domainId: projectId, viewId: sourceView }, relative, signal) });
    const source: ResourceReader = { ...base,
      async read(relative, signal) {
        relative = normalize(relative); sourcePaths.add(relative);
        try { const link = await external(relative); return link ? remap(source, relative, await link.reader.read(link.path, signal)) : base.read(relative, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') return resourceFailure(source, relative, 'invalid', 'Resource symlink cycle'); throw error; }
      },
      async list(relative, signal) {
        relative = normalize(relative);
        try { const link = await external(relative); if (link) return remap(source, relative, await link.reader.list(link.path, signal));
          scopes.add(relative); return base.list(relative, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') return resourceFailure(source, relative, 'invalid', 'Resource symlink cycle'); throw error; }
      },
    };
    const observed = recordReader(source, root);
    const scope: AdmittedAgentResourceScope = { threadId: input.branchId, branchId: input.branchId, mode: 'agent', threadRole: 'source', projectId: null,
      sourceIdentity: sourceView, projectTrusted: trusted, project: { reader: observed.reader, cwd: '', skillAncestorBoundary: '', displayRoot: root },
      ancestors: [], configuredPaths: [], installedPackages: [] };
    const capture: SourceResourceCapture = { root, cwd: '', skillAncestorBoundary: '', coverage: noCoverage(), ancestors: [], configuredPaths: [], installedPackages: [], sourceLinks: [], shadowedContextCanonicalIds: [] };
    let nearestGit: string | undefined;
    for (let current = root; ; current = path.dirname(current)) {
      try { await lstat(path.join(current, '.git')); nearestGit = current; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (path.dirname(current) === current) break;
    }
    const ancestorRoots: string[] = [];
    for (let current = path.dirname(root); current !== root; current = path.dirname(current)) {
      ancestorRoots.unshift(current); if (path.dirname(current) === current) break;
    }
    for (const ancestor of ancestorRoots) {
      const includeSkills = trusted && nearestGit !== undefined && isPathWithinRoot(ancestor, nearestGit) && isPathWithinRoot(root, ancestor);
      const admitted = await captureDomain(ancestor);
      if (admitted.target.kind !== 'capsule') throw new Error('External ancestor must use its original capsule');
      // Only exact context candidates and admitted nearest-Git-chain skills are ever visited.
      for (const candidate of CONTEXT_FILE_NAMES) {
        const observed = await admitted.reader.read(candidate, signal);
        if (observed.status === 'invalid') await admitted.reader.list(candidate, signal);
      }
      if (includeSkills) {
        const skills = await authority.prepare({ threadId: input.branchId, branchId: input.branchId, mode: 'agent', threadRole: 'source', projectId: null,
          sourceIdentity: sourceView, projectTrusted: false, userAgents: { reader: admitted.reader, directory: '.agents', displayRoot: ancestor } }, signal);
        if (skills.status !== 'ready') throw new ResourceScopeError(skills);
      }
      const capsule = captures.get(ancestor)!.capsule();
      scope.ancestors!.push({ reader: capsuleReader(capsule), displayRoot: ancestor, appliesTo: '', includeSkills });
      capture.ancestors.push({ capsule, appliesTo: '', includeSkills });
    }
    if (nearestGit && owners.resolvePrimaryWorktreeRoot && (await lstat(path.join(nearestGit, '.git'))).isFile()) {
      const primary = await canonicalizePathIdentity((await owners.resolvePrimaryWorktreeRoot(nearestGit)).root, { allowMissing: true });
      if (primary !== nearestGit && isPathWithinRoot(nearestGit, primary)) {
        const worktree = nearestGit === root ? observed.reader : captures.get(nearestGit)?.reader;
        const primaryReader = captures.get(primary)?.reader;
        if (worktree && primaryReader) {
          // Pi shadows only the primary file with the selected worktree alias's basename.
          for (const name of CONTEXT_FILE_NAMES) {
            const selected = await worktree.read(name, signal);
            if (selected.status !== 'ready') continue;
            const shadowed = await primaryReader.read(name, signal);
            if (shadowed.status === 'ready') capture.shadowedContextCanonicalIds.push(shadowed.reference.canonicalId);
            break;
          }
        }
      }
    }
    scope.shadowedContextCanonicalIds = capture.shadowedContextCanonicalIds;
    if (trusted) {
      const config = await observed.reader.read('.pi/settings.json', signal);
      if (config.status === 'ready') {
        for (const configuredPath of capturedSettings(config).skills.filter(value => !isLocalPattern(value))) {
          const admitted = await captureDomain(configuredAbsolute(configuredPath, path.join(root, '.pi'), home));
          scope.configuredPaths!.push({ scope: 'project', configuredPath, target: { reader: admitted.reader, directory: admitted.directory, displayRoot: admitted.root } });
          capture.configuredPaths.push({ configuredPath, target: admitted.target });
        }
      }
      const configuration = await owners.configuration(root);
      for (const pkg of configuration.packages.filter(item => item.scope === 'project')) {
        const admitted = await captureDomain(pkg.installedPath);
        scope.installedPackages!.push({ reader: admitted.reader, directory: admitted.directory, displayRoot: admitted.root, identity: pkg.identity, source: pkg.source, scope: 'project' });
        capture.installedPackages.push({ identity: pkg.identity, source: pkg.source, target: admitted.target });
      }
    }
    const prepared = await authority.prepare(scope, signal);
    if (prepared.status !== 'ready') throw new ResourceScopeError(prepared);
    // Whole source-local resource roots go into the existing source tree, including support files.
    // External capsules remain exact observations; capture support only within selected SKILL.md bundles.
    const visited = new Set<string>();
    const withinBundle = (reader: ResourceReader, skill: PreparedAgentResources['skills'][number], reference: Extract<ResourceFileResult, { status: 'ready' }>['reference']) => {
      if (reference.canonicalId === skill.baseCanonicalId || canonicalBundleContains(skill, reference)) return true;
      [...captures.values()].find(capture => capture.reader.domainId === reader.domainId)?.exclude(reference.path,
        resourceFailure(reader, reference.path, 'denied', 'Resource link leaves its admitted skill bundle'));
      return false;
    };
    const supportTree = async (reader: ResourceReader, directory: string, skill: PreparedAgentResources['skills'][number]): Promise<void> => {
      const listing = await reader.list(directory, signal);
      if (listing.status !== 'ready' || !withinBundle(reader, skill, listing.reference) || visited.has(listing.reference.canonicalId)) return;
      visited.add(listing.reference.canonicalId);
      for (const entry of listing.entries) {
        if (entry.name === '.git' || entry.name === '.varin') continue;
        const file = normalize(path.posix.join(directory, entry.name));
        if (entry.kind === 'directory') await supportTree(reader, file, skill);
        else { const captured = await reader.read(file, signal); if (captured.status === 'ready') withinBundle(reader, skill, captured.reference); }
      }
    };
    for (const skill of prepared.snapshot.skills) {
      if (path.posix.basename(skill.reference.path) !== 'SKILL.md') continue;
      const reader = domainReaders(scope).find(item => item.domainId === skill.reference.domainId && item.viewId === skill.reference.viewId);
      if (reader && reader.domainId !== projectId) await supportTree([...captures.values()].find(capture => capture.reader.domainId === reader.domainId)?.reader ?? reader, skill.basePath, skill);
      else if (reader) { const link = await external(skill.basePath); if (link) await supportTree(link.reader, link.path, skill); }
    }
    // The capsule object is materialized only after discovery so it contains its final observations.
    const completeTarget = (target: SourceResourceTarget): SourceResourceTarget => target.kind === 'source' ? target
      : { ...target, capsule: captures.get(target.capsule.displayRoot)!.capsule() };
    capture.ancestors = capture.ancestors.map(entry => ({ ...entry, capsule: captures.get(entry.capsule.displayRoot)!.capsule() }));
    capture.configuredPaths = capture.configuredPaths.map(entry => ({ ...entry, target: completeTarget(entry.target) }));
    capture.installedPackages = capture.installedPackages.map(entry => ({ ...entry, target: completeTarget(entry.target) }));
    capture.sourceLinks = [...sourceLinks].map(([path, entry]) => ({ path, target: completeTarget(entry.target) }));
    const plan: SourceResourceCapturePlan = { resources: capture, captureScopes: sorted([...scopes].map(scope => scope || '.')), observedPaths: sorted([...sourcePaths].filter(file => file && !capture.sourceLinks.some(link => file.startsWith(`${link.path}/`)))),
      async validate(states, signal) {
        for (const [file, observation] of observed.reads) {
          if (capture.sourceLinks.some(link => file === link.path || file.startsWith(`${link.path}/`))) continue;
          const actualPath = normalize(path.relative(root, await canonicalizePathIdentity(path.join(root, file), { allowMissing: true })));
          const state = states[actualPath];
          if (observation.status === 'ready' && (state?.kind !== 'regular-file' || state.objectHash !== `sha256-${contentVersion(observation.content)}`)) throw new Error('Source resource bytes changed during capture');
          if (observation.status === 'missing' && state && state.kind !== 'missing') throw new Error('Source resource absence changed during capture');
        }
        await observed.validate(signal);
        for (const captured of captures.values()) await captured.validate(signal);
        if (trusted && !await owners.projectTrusted(root)) throw new ResourceScopeError(resourceFailure(source, '', 'denied', 'Project resource trust was revoked during capture'));
      },
    };
    return plan;
  };


  const readSnapshotScope: ThreadResourceScope['withScope'] = async (identity, source, admitted, consume, options = {}) => {
    const snapshot = options.snapshot!;
    const signal = options.signal;
    const request = options.request;
    const selected = request && request.kind !== 'instruction-scope' ? snapshot.skills.find(skill => skill.id === request.resourceId) : undefined;
    const authorize = async () => {
      signal?.throwIfAborted();
      if (selected?.requiresProjectTrust) {
        if (!snapshot.scope.projectRoot) throw new ResourceScopeError(resourceFailure({ domainId: 'agent-resources', viewId: snapshot.id }, '', 'invalid', 'Resource trust has no original configuration root'));
        if (!await owners.projectTrusted(snapshot.scope.projectRoot)) throw new ResourceScopeError(resourceFailure({ domainId: 'agent-resources', viewId: snapshot.id }, '', 'denied', 'Project resource trust was revoked'));
      }
    };
    await authorize();
    const requestPaths = (): string[] => {
      const request = options.request;
      if (!request) return [];
      if (request.kind === 'instruction-scope') {
        const target = normalize(request.targetPath);
        const directory = request.targetType === 'directory' ? target : normalize(path.posix.dirname(target));
        return ancestorDirectories(directory).flatMap(directory => CONTEXT_FILE_NAMES.map(name => normalize(path.posix.join(directory, name))));
      }
      const selected = snapshot.skills.find(skill => skill.id === request.resourceId);
      if (!selected) return [];
      const canonicalPrefix = `resource:${selected.reference.domainId}/`;
      return sorted([request.kind === 'skill' ? selected.reference.path : selected.basePath,
        ...(selected.baseCanonicalId.startsWith(canonicalPrefix) ? [normalize(selected.baseCanonicalId.slice(canonicalPrefix.length))] : [])]);
    };
    const readers = snapshot.readers.map(declared => {
      const unavailable = (target: string) => resourceFailure(declared, target, 'unavailable', 'Resource dependency was not captured in an available original view');
      const access = async <T extends ResourceFileResult | ResourceDirectoryResult>(target: string, action: (reader: ResourceReader) => Promise<T>): Promise<T> => {
        signal?.throwIfAborted();
        if (declared.consistency !== 'immutable' || !source || source.mode === 'live_root' || !owners.withSourceRead) return unavailable(target) as T;
        try {
          const paths = requestPaths();
          if (!paths.length) return unavailable(target) as T;
          return await owners.withSourceRead({ identity, source, paths, ...(options.runId ? { runId: options.runId } : {}), ...(signal ? { signal } : {}) }, async ({ store, pin, original, admitSymlinkTarget }) => {
            const capture = original?.provenance.resources;
            const base = createPinnedResourceReader({ domainId: `workspace:${source.workspaceId}`, store, pin, coverage: capture?.coverage ?? noCoverage(),
              ...(request?.kind === 'instruction-scope' && admitSymlinkTarget ? { admitSymlinkTarget } : {}) });
            const project = capture ? withSourceLinks(base, capture) : base;
            const scope: AdmittedAgentResourceScope = { ...admitted, threadId: identity.threadId, branchId: identity.branchId,
              sourceIdentity: snapshot.scope.sourceIdentity, projectTrusted: snapshot.scope.projectTrusted,
              project: { reader: project, cwd: snapshot.scope.cwd, ...(snapshot.scope.projectRoot ? { displayRoot: snapshot.scope.projectRoot } : {}) } };
            if (snapshot.project && (project.domainId !== snapshot.project.domainId || project.viewId !== snapshot.project.viewId)) {
              return resourceFailure(declared, target, 'stale', 'Source pin differs from the bound resource view') as T;
            }
            if (capture) applyCapture(scope, project, capture);
            const reader = domainReaders(scope).find(reader => reader.domainId === declared.domainId && reader.viewId === declared.viewId);
            return reader ? action(reader) : unavailable(target) as T;
          });
        } catch (error) {
          if (error instanceof ResourceScopeError) return error.failure as T;
          if (signal?.aborted) return resourceFailure(declared, target, 'cancelled', 'Resource read was cancelled') as T;
          const code = (error as { code?: string })?.code;
          return resourceFailure(declared, target, code === 'kernel-grant-stale' ? 'stale' : ['unauthorized', 'forbidden', 'EACCES', 'EPERM'].includes(code ?? '') ? 'denied' : 'unavailable', 'Original resource dependency is unavailable') as T;
        }
      };
      return { ...declared, read: (target: string) => access(target, reader => reader.read(target, signal)),
        list: (target: string) => access(target, reader => reader.list(target, signal)) } satisfies ResourceReader;
    });
    const scope: AdmittedAgentResourceScope = { ...admitted, threadId: identity.threadId, branchId: identity.branchId,
      sourceIdentity: snapshot.scope.sourceIdentity, projectTrusted: snapshot.scope.projectTrusted };
    const result = await consume({ admittedScope: scope, readers });
    await authorize();
    return result;
  };

  const withScopeImpl: ThreadResourceScope['withScope'] = async (identity, source, admitted, consume, options = {}) => {
    const signal = options.signal; signal?.throwIfAborted();
    const scope: AdmittedAgentResourceScope = { ...admitted, threadId: identity.threadId, branchId: identity.branchId, sourceIdentity: null, projectTrusted: false,
      ...(options.instructionDirectories ? { instructionDirectories: options.instructionDirectories } : {}),
      ...(options.supportingFiles ? { supportingFiles: options.supportingFiles } : {}) };
    const finish = async () => {
      await addUser(scope, options); signal?.throwIfAborted();
      const result = await consume({ admittedScope: scope, readers: domainReaders(scope) });
      signal?.throwIfAborted();
      if (source?.mode === 'live_root') await owners.validateLiveSource(source, signal);
      if (scope.projectTrusted && scope.project?.displayRoot && !await owners.projectTrusted(scope.project.displayRoot)) {
        throw new ResourceScopeError(resourceFailure({ domainId: 'agent-resources', viewId: options.snapshot?.id ?? 'admission' }, '', 'denied', 'Project resource trust was revoked'));
      }
      return result;
    };
    if (!source) return finish();
    if (source.mode === 'live_root') {
      await owners.validateLiveSource(source, signal);
      scope.projectTrusted = await owners.projectTrusted(source.liveRoot.canonicalRoot);
      return owners.workingStates.withBranchStore(source.workspaceId, 'resource-live-scope', async store => {
        const root = source.liveRoot.canonicalRoot;
        const id = `workspace:${source.workspaceId}`;
        const previous = options.snapshot?.readers.find(reader => reader.domainId === id);
        const viewId = previous?.viewId ?? `live-resource:${source.liveRoot.rootId}:${randomUUID()}`;
        const reader = createDocumentResourceReader({ domainId: id, viewId, workspaceId: source.workspaceId, documents: owners.documents,
          list: (relative, signal) => listSourceDirectory(store, root, { domainId: id, viewId }, relative, signal) });
        scope.sourceIdentity = `workspace:${source.workspaceId}:live:${source.liveRoot.rootId}`;
        scope.project = { reader, cwd: '', skillAncestorBoundary: '', displayRoot: root };
        if (!options.snapshot) {
          // Capturing this candidate's external dependencies does not mutate the live source or a prior snapshot.
          const captured = await prepareSourceCapture({ store, directory: root, workspaceId: source.workspaceId, captureWorkspaceId: source.workspaceId,
            branchId: identity.branchId, ...(signal ? { signal } : {}) });
          scope.project.reader = withSourceLinks(reader, captured.resources);
          applyCapture(scope, scope.project.reader, captured.resources);
        }
        return finish();
      }, 'shared', { threadId: identity.threadId });
    }
    return owners.workingStates.withBranchStore(source.workspaceId, 'resource-fixed-scope', async store => {
      const pin = await store.pinBranch(source.branchId, { revision: source.revision, ...(signal ? { signal } : {}) });
      try {
        const original = await store.readOriginalSource(source.branchId, signal ? { signal } : {});
        const capture = original?.provenance.resources;
        const root = capture?.root ?? (await owners.documents.inspectWorkspace(source.workspaceId, signal ? { signal } : {})).root;
        scope.projectTrusted = await owners.projectTrusted(root);
        scope.sourceIdentity = `workspace:${source.workspaceId}:${source.branchId}@${source.revision}:${pin.root}`;
        const base = createPinnedResourceReader({ domainId: `workspace:${source.workspaceId}`, store, pin, coverage: capture?.coverage ?? noCoverage() });
        const reader = capture ? withSourceLinks(base, capture) : base;
        scope.project = { reader, cwd: capture?.cwd ?? '', skillAncestorBoundary: capture?.skillAncestorBoundary ?? '', displayRoot: root };
        if (capture) applyCapture(scope, reader, capture);
        return await finish();
      } finally { await pin.release(); }
    }, 'shared', { threadId: identity.threadId });
  };
  const withScope: ThreadResourceScope['withScope'] = async (identity, source, admitted, consume, options = {}) => {
    try { return await (options.snapshot ? readSnapshotScope : withScopeImpl)(identity, source, admitted, consume, options); }
    catch (error) {
      if (error instanceof ResourceScopeError) throw error;
      const status = options.signal?.aborted || (error as Error)?.name === 'AbortError' ? 'cancelled'
        : ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '') ? 'denied' : 'unavailable';
      throw new ResourceScopeError(resourceFailure({ domainId: 'agent-resources', viewId: options.snapshot?.id ?? 'admission' }, '', status,
        status === 'cancelled' ? 'Resource admission was cancelled' : status === 'denied' ? 'Resource owner denied admission' : 'The admitted resource view is unavailable'));
    }
  };
  return { withScope, prepareSourceCapture };
}

function applyCapture(scope: AdmittedAgentResourceScope, reader: ResourceReader, capture: SourceResourceCapture, captureOnly = false): void {
  const capsuleReaders = new Map<string, ResourceReader>();
  const admittedReader = (reader: ResourceReader): ResourceReader => {
    const key = referenceKey({ ...reader, path: '' });
    let current = capsuleReaders.get(key);
    if (!current) { current = captureOnly ? { ...reader, consistency: 'capture-only' as const } : reader; capsuleReaders.set(key, current); }
    return current;
  };
  const admittedDomain = (target: SourceResourceTarget): ResourceDomain => {
    const domain = targetDomain(target, reader, capture.root); return { ...domain, reader: admittedReader(domain.reader) };
  };
  scope.shadowedContextCanonicalIds = capture.shadowedContextCanonicalIds;
  scope.ancestors = capture.ancestors.map(entry => ({ reader: admittedReader(capsuleReader(entry.capsule)), displayRoot: entry.capsule.displayRoot,
    appliesTo: entry.appliesTo, includeSkills: entry.includeSkills }));
  scope.configuredPaths = capture.configuredPaths.map(entry => ({ scope: 'project', configuredPath: entry.configuredPath, target: admittedDomain(entry.target) }));
  scope.installedPackages = capture.installedPackages.map(entry => ({ scope: 'project', identity: entry.identity, source: entry.source, ...admittedDomain(entry.target) }));
}
