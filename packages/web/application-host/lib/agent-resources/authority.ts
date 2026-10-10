import path from 'node:path';
import type { AgentResourceDiagnostic, AgentResourceInstruction, AgentResourceObservation, AgentResourceRequest as ResourceRequest,
  AgentResourceSkill, AgentResourceSnapshot } from '../kernel/protocol.generated.js';
import ignore from 'ignore';
import { isPathWithinRoot } from '../workspace/path-safety.js';
import { ancestorDirectories, CONTEXT_FILE_NAMES, parseSkill, prefixIgnorePattern } from './formats.js';
import { hasGlobPattern, isLocalPattern, isOverridePattern, packageDelta, parsePackageSkillManifest, parseResourceSettings, resourceEnabled,
  type ConfiguredPackage, type ResourceSettings } from './configuration.js';
import { contentVersion, referenceKey, relativeResourcePath, resourceFailure, type CapturedResource, type ResourceDirectoryResult,
  type ResourceFailure, type ResourceFileResult, type ResourceLocation, type ResourceReader, type ResourceReference, type ResourceResult } from './source-reader.js';

export interface ResourceDomain {
  reader: ResourceReader;
  /** Relative directory in this admitted domain. Display roots are never used for content access. */
  directory?: string;
  displayRoot?: string;
}
export interface InstalledResourcePackage extends ResourceDomain {
  /** Canonical package identity from the existing package owner, never guessed from an install timestamp. */
  identity: string;
  source: string;
  scope: 'user' | 'project';
}
export interface AdmittedAgentResourceScope {
  threadId: string;
  branchId: string;
  mode: 'agent' | 'bot';
  threadRole: string;
  projectId: string | null;
  sourceIdentity: string | null;
  projectTrusted: boolean;
  project?: ResourceDomain & { cwd: string; skillAncestorBoundary?: string };
  user?: ResourceDomain;
  /** Exact HOME/.agents domain, not HOME or an arbitrary filesystem reader. */
  userAgents?: ResourceDomain;
  /** Outer-to-inner capsules captured with the admitted source receipt. */
  ancestors?: (ResourceDomain & { appliesTo: string; includeSkills?: boolean })[];
  /** Existing Git/source admission may identify an ancestor shadowed by a linked worktree. */
  shadowedContextCanonicalIds?: string[];
  /** Raw configured path -> independently admitted resource. This is not path-based permission inference. */
  configuredPaths?: { scope: 'user' | 'project'; configuredPath: string; target: ResourceDomain; independentUserResource?: boolean }[];
  installedPackages?: InstalledResourcePackage[];
  skillsEnabled?: boolean;
  /** Capture only the requested extra chains/files for a new candidate, never the entire source tree. */
  instructionDirectories?: string[];
  supportingFiles?: { skillName: string; relativePath: string }[];
  dependencyDiagnostics?: ResourceFailure[];
}
export type ResourceDiagnostic = AgentResourceDiagnostic;
export type InstructionEntry = AgentResourceInstruction;
export type SkillDescriptor = AgentResourceSkill;
export type ResourceObservation = AgentResourceObservation;
/** Serializable generated candidate. The existing checkpoint owns publication and durability. */
export type PreparedAgentResources = AgentResourceSnapshot;
export interface AgentResourceBinding {
  snapshot: PreparedAgentResources;
  /** Temporary current-authorized handles for exact saved views. They are not persisted in the snapshot. */
  readers: readonly ResourceReader[];
}
export type AgentResourceRequest = ResourceRequest;
export type AgentResourceRead = ResourceResult<
  | { kind: 'skill' | 'skill-resource'; descriptor: SkillDescriptor; file: CapturedResource }
  | { kind: 'instruction-scope'; directory: string; instructions: (InstructionEntry & { content: string })[] }
>;
class PreparationFailure extends Error {
  constructor(readonly failure: ResourceFailure) { super(failure.reason); }
}
const join = (...parts: string[]) => relativeResourcePath(path.posix.join(...parts));
const location = (reader: ResourceReader, target: string): ResourceLocation => ({ domainId: reader.domainId, viewId: reader.viewId, path: target });
const requireFile = (result: ResourceFileResult): CapturedResource => {
  if (result.status !== 'ready') throw new PreparationFailure(result);
  return { reference: result.reference, content: result.content };
};
const refLocation = (reference: ResourceReference): ResourceLocation => ({ domainId: reference.domainId, viewId: reference.viewId, path: reference.path });
const domainDirectory = (domain: ResourceDomain) => relativeResourcePath(domain.directory ?? '');
function absoluteDisplay(domain: ResourceDomain, file: string): string | undefined {
  return domain.displayRoot ? path.posix.join(domain.displayRoot.replaceAll('\\', '/'), file) : undefined;
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** One preparation owns its observations. There is no cross-thread mutable cache or global I/O queue. */
class Preparation {
  readonly captures = new Map<string, CapturedResource>();
  readonly observations = new Map<string, ResourceObservation>();
  readonly readers = new Map<string, ResourceReader>();
  readonly diagnostics: ResourceDiagnostic[] = [];
  readonly fileReads = new Map<string, ResourceFileResult>();
  constructor(readonly signal?: AbortSignal) {}
  register(reader: ResourceReader): void {
    const key = JSON.stringify([reader.domainId, reader.viewId]);
    const current = this.readers.get(key);
    if (current && current !== reader) throw new Error('A resource view must have one admitted reader');
    this.readers.set(key, reader);
  }
  async read(reader: ResourceReader, target: string): Promise<ResourceFileResult> {
    this.register(reader); this.signal?.throwIfAborted();
    const key = referenceKey(location(reader, target));
    const cached = this.fileReads.get(key); if (cached) return cached;
    const result = await reader.read(target, this.signal); this.signal?.throwIfAborted();
    this.fileReads.set(key, result);
    this.observations.set(key, { ...location(reader, target), status: result.status, ...(result.status === 'ready' ? { version: result.reference.version } : {}) });
    if (result.status === 'ready') this.captures.set(key, { reference: { ...result.reference }, content: result.content });
    return result;
  }
  async list(reader: ResourceReader, target: string): Promise<ResourceDirectoryResult> {
    this.register(reader); this.signal?.throwIfAborted();
    const result = await reader.list(target, this.signal); this.signal?.throwIfAborted();
    this.observations.set(`directory:${referenceKey(location(reader, target))}`, { ...location(reader, target), status: result.status,
      ...(result.status === 'ready' ? { version: result.reference.version } : {}) });
    return result;
  }
  diagnostic(result: ResourceFailure): void {
    this.diagnostics.push({ kind: result.status === 'invalid' ? 'invalid' : 'read', message: result.reason,
      location: { domainId: result.domainId, viewId: result.viewId, path: result.path }, status: result.status });
  }
  async context(domain: ResourceDomain, origin: InstructionEntry['origin'], appliesTo: string | null): Promise<InstructionEntry | null> {
    for (const name of CONTEXT_FILE_NAMES) {
      const result = await this.read(domain.reader, join(domainDirectory(domain), name));
      if (result.status === 'missing') continue;
      if (result.status === 'invalid') {
        const directory = await this.list(domain.reader, join(domainDirectory(domain), name));
        if (directory.status === 'ready') { this.diagnostic(result); continue; }
      }
      const file = requireFile(result);
      return { origin, kind: origin === 'user' ? 'user-config' : 'project-instruction', appliesTo, reference: file.reference };
    }
    return null;
  }
}

async function settings(preparation: Preparation, domain?: ResourceDomain): Promise<ResourceSettings> {
  if (!domain) return { skills: [], packages: [] };
  const target = join(domainDirectory(domain), 'settings.json');
  const result = await preparation.read(domain.reader, target);
  if (result.status === 'missing') return { skills: [], packages: [] };
  const file = requireFile(result);
  try { return parseResourceSettings(file.content); }
  catch { throw new PreparationFailure(resourceFailure(domain.reader, target, 'invalid', 'Resource settings are malformed')); }
}
async function systemSelection(preparation: Preparation, name: string, user: ResourceDomain | undefined, project: ResourceDomain | undefined): Promise<InstructionEntry | null> {
  for (const [origin, domain] of [['project', project], ['user', user]] as const) {
    if (!domain) continue;
    const result = await preparation.read(domain.reader, join(domainDirectory(domain), name));
    if (result.status === 'missing') continue;
    const file = requireFile(result);
    return { origin, kind: 'user-config', appliesTo: origin === 'project' ? relativeResourcePath(path.posix.dirname(domainDirectory(domain))) : null, reference: file.reference };
  }
  return null;
}

/** Only a resource root is walked. SKILL.md stops descent; .agents mode preserves the SDK entry rules. */
async function discover(preparation: Preparation, domain: ResourceDomain, target: string, mode: 'pi' | 'agents' = 'pi'): Promise<CapturedResource[]> {
  const result: CapturedResource[] = [];
  const visited = new Set<string>();
  const matcher = ignore();
  const root = target;
  const walk = async (directory: string): Promise<void> => {
    const listed = await preparation.list(domain.reader, directory);
    if (listed.status !== 'ready') { if (listed.status !== 'missing') preparation.diagnostic(listed); return; }
    if (visited.has(listed.reference.canonicalId)) return;
    visited.add(listed.reference.canonicalId);
    for (const name of ['.gitignore', '.ignore', '.fdignore']) {
      const file = await preparation.read(domain.reader, join(directory, name));
      if (file.status === 'missing') continue;
      if (file.status !== 'ready') { preparation.diagnostic(file); continue; }
      const prefix = path.posix.relative(root || '.', directory || '.');
      const rules = file.content.split(/\r?\n/).map(line => prefixIgnorePattern(line, prefix ? `${prefix}/` : '')).filter((line): line is string => line !== null);
      matcher.add(rules);
    }
    const declared = listed.entries.find(entry => entry.name === 'SKILL.md' && (entry.kind === 'file' || entry.kind === 'symlink'));
    if (declared && !matcher.ignores(path.posix.relative(root || '.', join(directory, declared.name)))) {
      const file = await preparation.read(domain.reader, join(directory, declared.name));
      if (file.status === 'ready') result.push({ reference: file.reference, content: file.content });
      else preparation.diagnostic(file);
      return;
    }
    for (const entry of listed.entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const target = join(directory, entry.name);
      const relative = path.posix.relative(root || '.', target);
      if (matcher.ignores(entry.kind === 'directory' ? `${relative}/` : relative)) continue;
      if (entry.kind === 'directory') await walk(target);
      else if (entry.kind === 'file' && entry.name.endsWith('.md') && (mode === 'pi' ? directory === root : directory !== root)) {
        const file = await preparation.read(domain.reader, target);
        if (file.status === 'ready') result.push({ reference: file.reference, content: file.content });
        else preparation.diagnostic(file);
      } else if (entry.kind === 'symlink') {
        const linked = await preparation.read(domain.reader, target);
        if (linked.status !== 'ready') preparation.diagnostic(linked);
      }
    }
  };
  const candidate = await preparation.read(domain.reader, target);
  if (candidate.status === 'ready') return [{ reference: candidate.reference, content: candidate.content }];
  if (candidate.status === 'missing') return [];
  if (candidate.status !== 'invalid') { preparation.diagnostic(candidate); return []; }
  await walk(target);
  return result;
}

function configuredTarget(scope: AdmittedAgentResourceScope, domain: ResourceDomain, origin: 'user' | 'project', configuredPath: string): ResourceDomain | ResourceFailure {
  const admitted = scope.configuredPaths?.find(entry => entry.scope === origin && entry.configuredPath === configuredPath);
  if (admitted) {
    if (origin === 'project' && scope.project?.reader.consistency === 'immutable' && admitted.target.reader.consistency !== 'immutable' && !admitted.independentUserResource) {
      return resourceFailure(domain.reader, configuredPath, 'unavailable', 'Fixed project external dependency was not captured');
    }
    return admitted.target;
  }
  try {
    const trimmed = configuredPath.trim();
    if (trimmed.startsWith('~') || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) throw new Error('external');
    return { ...domain, directory: join(domainDirectory(domain), trimmed) };
  } catch { return resourceFailure(domain.reader, configuredPath, 'denied', 'Configured path needs an explicitly admitted resource dependency'); }
}
async function expandManifestGlob(preparation: Preparation, domain: ResourceDomain, base: string, pattern: string): Promise<string[]> {
  const parts = pattern.split('/');
  const prefix = parts.slice(0, parts.findIndex(hasGlobPattern)).join('/');
  let start: string;
  try { start = join(base, prefix); }
  catch { preparation.diagnostic(resourceFailure(domain.reader, pattern, 'denied', 'Package glob leaves its admitted resource domain')); return []; }
  const matched: string[] = [];
  const visited = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    const result = await preparation.list(domain.reader, directory);
    if (result.status !== 'ready') { if (result.status !== 'missing') preparation.diagnostic(result); return; }
    if (visited.has(result.reference.canonicalId)) return;
    visited.add(result.reference.canonicalId);
    for (const entry of result.entries) {
      if (entry.name.startsWith('.')) continue;
      const target = join(directory, entry.name);
      const relative = path.posix.relative(base || '.', target);
      if (path.posix.matchesGlob(relative, pattern)) matched.push(target);
      if (entry.kind === 'directory') await walk(target);
    }
  };
  await walk(start);
  return matched.sort();
}
interface SkillCandidate { file: CapturedResource; domain: ResourceDomain; priority: number; origin: SkillDescriptor['origin']; requiresProjectTrust: boolean; enabled: boolean; packageIdentity?: string }
async function collectSkills(preparation: Preparation, scope: AdmittedAgentResourceScope, userSettings: ResourceSettings, projectSettings: ResourceSettings, projectConfig?: ResourceDomain): Promise<SkillDescriptor[]> {
  const candidates: SkillCandidate[] = [];
  const add = async (domain: ResourceDomain, target: string, origin: 'user' | 'project', priority: number, patterns: string[], filterBase: string, mode: 'pi' | 'agents' = 'pi', overridesOnly = true) => {
    for (const file of await discover(preparation, domain, target, mode)) {
      const absolute = absoluteDisplay(domain, file.reference.path);
      candidates.push({ file, domain, origin, requiresProjectTrust: origin === 'project', priority, enabled: resourceEnabled({ path: file.reference.path, base: filterBase, ...(absolute ? { absolute } : {}) }, patterns, { overridesOnly }) });
    }
  };
  for (const [origin, domain, config, priority] of [
    ['project', projectConfig, projectSettings, 0], ['user', scope.user, userSettings, 2],
  ] as const) {
    if (!domain) continue;
    for (const configuredPath of config.skills.filter(entry => !isLocalPattern(entry))) {
      const target = configuredTarget(scope, domain, origin, configuredPath);
      if ('status' in target) { preparation.diagnostic(target); continue; }
      await add(target, domainDirectory(target), origin, priority, config.skills.filter(isLocalPattern), target.reader === domain.reader ? domainDirectory(domain) : domainDirectory(target), 'pi', false);
    }
  }
  if (projectConfig && scope.project) {
    await add(projectConfig, join(domainDirectory(projectConfig), 'skills'), 'project', 1, projectSettings.skills, domainDirectory(projectConfig));
    const boundary = relativeResourcePath(scope.project.skillAncestorBoundary ?? '');
    const chain = ancestorDirectories(relativeResourcePath(scope.project.cwd)).reverse();
    if (!chain.includes(boundary)) throw new PreparationFailure(resourceFailure(scope.project.reader, boundary, 'invalid', 'Skill ancestor boundary is not an ancestor of admitted cwd'));
    for (const directory of chain) {
      const base = join(directory, '.agents');
      await add(scope.project, join(base, 'skills'), 'project', 1, projectSettings.skills, base, 'agents');
      if (directory === boundary) break;
    }
  }
  if (projectConfig) {
    // Source admission marks only ancestor directories inside the original nearest-Git-root skill chain.
    // Their capsules are already checked immutable above; ordering is cwd outward, after source-local roots.
    for (const ancestor of [...scope.ancestors ?? []].reverse()) {
      if (!ancestor.includeSkills) continue;
      const base = join(domainDirectory(ancestor), '.agents');
      await add(ancestor, join(base, 'skills'), 'project', 1, projectSettings.skills, base, 'agents');
    }
  }
  if (scope.user) await add(scope.user, join(domainDirectory(scope.user), 'skills'), 'user', 3, userSettings.skills, domainDirectory(scope.user));
  if (scope.userAgents) await add(scope.userAgents, join(domainDirectory(scope.userAgents), 'skills'), 'user', 3, userSettings.skills, domainDirectory(scope.userAgents), 'agents');

  // Project identity wins; an autoload:false project entry is an ordered delta over the user package.
  const packageChoices: { entry: ConfiguredPackage; scope: 'project' | 'user'; installed: InstalledResourcePackage }[] = [];
  const packageSeen = new Map<string, { entry: ConfiguredPackage; scope: 'project' | 'user' }>();
  for (const [origin, entries] of [['project', projectConfig ? projectSettings.packages : []], ['user', userSettings.packages]] as const) {
    for (const entry of entries) {
      const installed = scope.installedPackages?.find(item => item.source === entry.source && item.scope === origin);
      if (!installed) {
        const owner = origin === 'project' ? projectConfig : scope.user;
        if (owner) preparation.diagnostic(resourceFailure(owner.reader, entry.source, 'unavailable', 'Configured package is not admitted as an installed resource; no installation was attempted'));
        continue;
      }
      const seen = packageSeen.get(installed.identity);
      if (seen && !(origin === 'user' && seen.scope === 'project' && seen.entry.autoload === false)) continue;
      if (!seen) packageSeen.set(installed.identity, { entry, scope: origin });
      packageChoices.push({ entry, scope: origin, installed });
    }
  }
  for (const { entry, installed, scope: packageScope } of packageChoices) {
    const base = domainDirectory(installed);
    const manifestFile = await preparation.read(installed.reader, join(base, 'package.json'));
    let manifest: ReturnType<typeof parsePackageSkillManifest> = { hasManifest: false };
    if (manifestFile.status === 'ready') {
      try { manifest = parsePackageSkillManifest(manifestFile.content); }
      catch { preparation.diagnostic(resourceFailure(installed.reader, join(base, 'package.json'), 'invalid', 'Installed package manifest is malformed')); continue; }
    } else if (manifestFile.status !== 'missing') { preparation.diagnostic(manifestFile); continue; }
    const filtered = entry.structured === true;
    // Pi's unfiltered manifest owns all defaults; a manifest without skills opts out of convention discovery.
    const manifestEntries = manifest.skills;
    const roots = manifestEntries && manifestEntries.length > 0 ? manifestEntries.filter(value => !isOverridePattern(value))
      : filtered || !manifest.hasManifest || (manifestEntries !== undefined && manifestEntries.length > 0) ? ['skills'] : [];
    // collectDefaultResources respects an explicit empty manifest even for { source } settings.
    // Only an actual filter/delta uses collectManifestFiles and may override that default.
    if (manifestEntries?.length === 0 && entry.skills === undefined && entry.autoload !== false) continue;
    const files: CapturedResource[] = [];
    for (const root of roots) {
      if (hasGlobPattern(root)) {
        // Expand explicit visible paths, then apply the same file/root discovery as exact manifest entries.
        for (const target of await expandManifestGlob(preparation, installed, base, root)) {
          files.push(...await discover(preparation, installed, target));
        }
      } else {
        try { files.push(...await discover(preparation, installed, join(base, root))); }
        catch (error) { if (error instanceof PreparationFailure) throw error; preparation.diagnostic(resourceFailure(installed.reader, root, 'denied', 'Package resource leaves its admitted domain')); }
      }
    }
    for (const file of files) {
      const absolute = absoluteDisplay(installed, file.reference.path);
      const filterPath = { path: file.reference.path, base, ...(absolute ? { absolute } : {}) };
      if (manifestEntries && !resourceEnabled(filterPath, manifestEntries.filter(isOverridePattern))) continue;
      const delta = entry.autoload === false ? packageDelta(filterPath, entry.skills ?? []) : undefined;
      if (entry.autoload === false && delta === undefined) continue;
      candidates.push({ file, domain: installed, origin: 'package', requiresProjectTrust: packageScope === 'project', priority: 4, packageIdentity: installed.identity,
        enabled: entry.autoload === false ? delta! : entry.skills === undefined ? true : resourceEnabled(filterPath, entry.skills, { emptyDisables: true }) });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  const byCanonical = new Map<string, SkillCandidate>();
  const byName = new Map<string, SkillDescriptor>();
  for (const candidate of candidates) {
    const { file } = candidate;
    const previous = byCanonical.get(file.reference.canonicalId);
    if (previous) {
      preparation.diagnostics.push({ kind: 'duplicate', message: 'Canonical resource already selected at a higher or earlier priority', location: refLocation(file.reference), winner: previous.file.reference });
      continue;
    }
    byCanonical.set(file.reference.canonicalId, candidate);
    if (!candidate.enabled) {
      preparation.diagnostics.push({ kind: 'disabled', message: 'Skill resource disabled by its existing configuration filter', location: refLocation(file.reference) });
      continue;
    }
    let parsed: ReturnType<typeof parseSkill>;
    try { parsed = parseSkill(file.content, absoluteDisplay(candidate.domain, file.reference.path) ?? file.reference.path); }
    catch { preparation.diagnostics.push({ kind: 'invalid', message: 'Skill YAML frontmatter is malformed', location: refLocation(file.reference), status: 'invalid' }); continue; }
    for (const message of parsed.diagnostics) preparation.diagnostics.push({ kind: parsed.metadata ? 'warning' : 'invalid', message, location: refLocation(file.reference) });
    if (!parsed.metadata) continue;
    const winner = byName.get(parsed.metadata.name);
    if (winner) {
      preparation.diagnostics.push({ kind: 'collision', message: `Skill name ${parsed.metadata.name} is already selected at a higher or earlier priority`, location: refLocation(file.reference), winner: winner.reference });
      continue;
    }
    const basePath = relativeResourcePath(path.posix.dirname(file.reference.path));
    const bundle = await preparation.list(candidate.domain.reader, basePath);
    if (bundle.status !== 'ready') { preparation.diagnostic(bundle); continue; }
    byName.set(parsed.metadata.name, { ...parsed.metadata, id: `skill:${contentVersion(file.reference.canonicalId)}`,
      origin: candidate.origin, requiresProjectTrust: candidate.requiresProjectTrust, priority: candidate.priority, reference: file.reference, basePath, baseCanonicalId: bundle.reference.canonicalId,
      ...(candidate.packageIdentity ? { packageIdentity: candidate.packageIdentity } : {}) });
  }
  return [...byName.values()];
}

async function projectInstructions(preparation: Preparation, reader: ResourceReader, directory: string): Promise<InstructionEntry[]> {
  const entries: InstructionEntry[] = [];
  for (const current of ancestorDirectories(directory)) {
    const entry = await preparation.context({ reader, directory: current }, 'project', current);
    if (entry) entries.push(entry);
  }
  return entries;
}
function uniqueInstructions(entries: InstructionEntry[], shadowed: readonly string[] = []): InstructionEntry[] {
  const seen = new Set(shadowed);
  return entries.filter(entry => {
    if (seen.has(entry.reference.canonicalId)) return false;
    seen.add(entry.reference.canonicalId); return true;
  });
}
export function canonicalBundleContains(skill: SkillDescriptor, reference: ResourceReference): boolean {
  if (skill.baseCanonicalId.startsWith('file:') && reference.canonicalId.startsWith('file:')) {
    const root = skill.baseCanonicalId.slice(5);
    const target = reference.canonicalId.slice(5);
    const windows = /^[A-Za-z]:/.test(root) || root.startsWith('\\\\');
    return isPathWithinRoot(target, root, windows ? path.win32 : path.posix, { platform: windows ? 'win32' : 'posix' });
  }
  return reference.canonicalId.startsWith(`${skill.baseCanonicalId.replace(/\/$/, '')}/`);
}
function bindingFailure(snapshot: PreparedAgentResources, target: string, status: ResourceFailure['status'], reason: string): ResourceFailure {
  return { status, domainId: 'agent-resources', viewId: snapshot.id, path: target, reason };
}
function boundReader(binding: AgentResourceBinding, reference: ResourceLocation): ResourceReader | ResourceFailure {
  const declared = binding.snapshot.readers.find(reader => reader.domainId === reference.domainId && reader.viewId === reference.viewId);
  const reader = binding.readers.find(reader => reader.domainId === reference.domainId && reader.viewId === reference.viewId);
  if (!declared || !reader) return bindingFailure(binding.snapshot, reference.path, 'unavailable', 'Exact admitted resource view is not available');
  if (reader.consistency !== declared.consistency) return bindingFailure(binding.snapshot, reference.path, 'stale', 'Resource reader consistency changed');
  return reader;
}
async function boundFile(binding: AgentResourceBinding, reference: ResourceLocation, signal?: AbortSignal): Promise<ResourceFileResult> {
  if (signal?.aborted) return bindingFailure(binding.snapshot, reference.path, 'cancelled', 'Resource read was cancelled');
  const captured = binding.snapshot.capturedFiles.find(file => referenceKey(file.reference) === referenceKey(reference));
  if (captured) return { status: 'ready', reference: { ...captured.reference }, content: captured.content };
  const reader = boundReader(binding, reference); if ('status' in reader) return reader;
  if (reader.consistency !== 'immutable') return resourceFailure(reader, reference.path, 'unavailable', 'Resource dependency was not captured; prepare a new candidate for this path');
  const result = await reader.read(reference.path, signal);
  if (signal?.aborted) return resourceFailure(reader, reference.path, 'cancelled', 'Resource read was cancelled');
  return result;
}

/** Read-only prepare/read owner. It never publishes a generation, refreshes settings, or retains a pin. */
export function createAgentResourceAuthority() {
  return {
    async prepare(scope: AdmittedAgentResourceScope, signal?: AbortSignal): Promise<ResourceResult<{ snapshot: PreparedAgentResources }>> {
      const preparation = new Preparation(signal);
      try {
        signal?.throwIfAborted();
        const cwd = scope.project ? relativeResourcePath(scope.project.cwd) : '';
        const projectConfig = scope.project && scope.projectTrusted ? { ...scope.project, directory: join(cwd, '.pi') } : undefined;
        const userSettings = await settings(preparation, scope.user);
        const projectSettings = await settings(preparation, projectConfig);
        const system = await systemSelection(preparation, 'SYSTEM.md', scope.user, projectConfig);
        const appendSystem = await systemSelection(preparation, 'APPEND_SYSTEM.md', scope.user, projectConfig);
        const baseInstructions: InstructionEntry[] = [];
        if (scope.user) {
          const entry = await preparation.context(scope.user, 'user', null);
          if (entry) baseInstructions.push(entry);
        }
        for (const ancestor of scope.ancestors ?? []) {
          if (ancestor.reader.consistency !== 'immutable') throw new PreparationFailure(resourceFailure(ancestor.reader, domainDirectory(ancestor), 'unavailable', 'Ancestor dependency must be a captured immutable view'));
          const entry = await preparation.context(ancestor, 'ancestor', ancestor.appliesTo);
          if (entry) baseInstructions.push(entry);
        }
        for (const diagnostic of scope.dependencyDiagnostics ?? []) preparation.diagnostic(diagnostic);
        const initialProject = scope.project ? await projectInstructions(preparation, scope.project.reader, cwd) : [];
        const instructions = uniqueInstructions([...baseInstructions, ...initialProject], scope.shadowedContextCanonicalIds);
        const instructionScopes = [{ directory: cwd, instructions }];
        for (const rawDirectory of scope.instructionDirectories ?? []) {
          const directory = relativeResourcePath(rawDirectory);
          if (!scope.project || instructionScopes.some(item => item.directory === directory)) continue;
          instructionScopes.push({ directory, instructions: uniqueInstructions([...baseInstructions,
            ...await projectInstructions(preparation, scope.project.reader, directory)], scope.shadowedContextCanonicalIds) });
        }
        const skills = scope.skillsEnabled === false ? [] : await collectSkills(preparation, scope, userSettings, projectSettings, projectConfig);
        for (const request of scope.supportingFiles ?? []) {
          const skill = skills.find(skill => skill.name === request.skillName);
          if (!skill) throw new PreparationFailure({ status: 'missing', domainId: 'agent-resources', viewId: 'candidate', path: request.skillName, reason: 'Requested skill is not in this catalog' });
          const relative = relativeResourcePath(request.relativePath);
          const reader = [...preparation.readers.values()].find(reader => reader.domainId === skill.reference.domainId && reader.viewId === skill.reference.viewId)!;
          const file = requireFile(await preparation.read(reader, join(skill.basePath, relative)));
          if (!canonicalBundleContains(skill, file.reference)) throw new PreparationFailure(resourceFailure(reader, file.reference.path, 'denied', 'Resource link leaves its admitted skill bundle'));
        }
        const observations = [...preparation.observations.values()];
        const configurationDigest = contentVersion(JSON.stringify({ userSettings, projectSettings, projectTrusted: scope.projectTrusted,
          installed: scope.installedPackages?.map(pkg => [pkg.identity, pkg.source, pkg.scope, pkg.reader.domainId, pkg.reader.viewId]) ?? [],
          configurationSources: observations.filter(entry => /(?:^|\/)(settings|package)\.json$/.test(entry.path)),
          skillsEnabled: scope.skillsEnabled !== false }));
        const data: Omit<PreparedAgentResources, 'id'> = {
          scope: { threadId: scope.threadId, branchId: scope.branchId, mode: scope.mode, threadRole: scope.threadRole,
            projectId: scope.projectId, sourceIdentity: scope.sourceIdentity, cwd, projectRoot: scope.project?.displayRoot ?? null, projectTrusted: scope.projectTrusted },
          readers: [...preparation.readers.values()].map(reader => ({ domainId: reader.domainId, viewId: reader.viewId, consistency: reader.consistency })),
          project: scope.project ? { domainId: scope.project.reader.domainId, viewId: scope.project.reader.viewId, cwd } : null,
          configurationDigest, shadowedContextCanonicalIds: [...scope.shadowedContextCanonicalIds ?? []], system, appendSystem, instructions, instructionScopes, skills, diagnostics: preparation.diagnostics,
          capturedFiles: [...preparation.captures.values()], observations,
        };
        signal?.throwIfAborted();
        const id = `agent-resources:${contentVersion(JSON.stringify({ ...data, capturedFiles: data.capturedFiles.map(file => file.reference) }))}`;
        return { status: 'ready', snapshot: freezeData({ id, ...data }) };
      } catch (error) {
        if (signal?.aborted) return { status: 'cancelled', domainId: 'agent-resources', viewId: 'candidate', path: '', reason: 'Resource preparation was cancelled' };
        if (error instanceof PreparationFailure) return error.failure;
        throw error;
      }
    },
    async read(binding: AgentResourceBinding, request: AgentResourceRequest, signal?: AbortSignal): Promise<AgentResourceRead> {
      const { snapshot } = binding;
      if (signal?.aborted) return bindingFailure(snapshot, '', 'cancelled', 'Resource read was cancelled');
      if (request.kind === 'skill' || request.kind === 'skill-resource') {
        const descriptor = snapshot.skills.find(skill => skill.id === request.resourceId);
        if (!descriptor) return bindingFailure(snapshot, request.resourceId, 'missing', 'Skill is not selected in this catalog');
        let target = descriptor.reference.path;
        if (request.kind === 'skill-resource') {
          try { target = join(descriptor.basePath, relativeResourcePath(request.relativePath)); }
          catch { return bindingFailure(snapshot, request.relativePath, 'denied', 'Skill resource path leaves its admitted bundle'); }
        }
        const result = await boundFile(binding, { ...descriptor.reference, path: target }, signal);
        if (result.status !== 'ready') return result;
        if (request.kind === 'skill-resource' && !canonicalBundleContains(descriptor, result.reference)) return bindingFailure(snapshot, target, 'denied', 'Resource link leaves its admitted skill bundle');
        // Model input never selects a reader; SKILL.md reads also verify the selected version.
        if (request.kind === 'skill' && (result.reference.canonicalId !== descriptor.reference.canonicalId || result.reference.version !== descriptor.reference.version)) {
          return bindingFailure(snapshot, target, 'stale', 'Skill bytes no longer match the selected descriptor');
        }
        return { status: 'ready', kind: request.kind, descriptor, file: { reference: result.reference, content: result.content } };
      }
      let directory: string;
      try {
        const target = relativeResourcePath(request.targetPath);
        directory = request.targetType === 'directory' ? target : relativeResourcePath(path.posix.dirname(target));
      } catch { return bindingFailure(snapshot, request.targetPath, 'denied', 'Instruction target is outside the admitted source'); }
      let entries = snapshot.instructionScopes.find(scope => scope.directory === directory)?.instructions;
      const files = new Map(snapshot.capturedFiles.map(file => [referenceKey(file.reference), file.content]));
      if (!entries) {
        if (!snapshot.project) return bindingFailure(snapshot, directory, 'unavailable', 'No project resource scope is bound');
        const reader = boundReader(binding, { ...snapshot.project, path: directory }); if ('status' in reader) return reader;
        const preparation = new Preparation(signal);
        // Reuse every captured read/missing observation; capture-only handles cannot fetch new paths.
        const frozenReader: ResourceReader = { domainId: reader.domainId, viewId: reader.viewId, consistency: reader.consistency,
          list: reader.list.bind(reader),
          read: async (target, readSignal) => {
            const ref = location(reader, target);
            const observation = snapshot.observations.find(item => referenceKey(item) === referenceKey(ref));
            if (observation?.status === 'missing') return resourceFailure(reader, target, 'missing', 'Resource was absent in this snapshot');
            return boundFile(binding, ref, readSignal);
          },
        };
        try {
          entries = uniqueInstructions([...snapshot.instructions.filter(entry => entry.origin !== 'project'),
            ...await projectInstructions(preparation, frozenReader, directory)], snapshot.shadowedContextCanonicalIds);
          for (const file of preparation.captures.values()) files.set(referenceKey(file.reference), file.content);
        } catch (error) {
          if (signal?.aborted) return bindingFailure(snapshot, directory, 'cancelled', 'Resource read was cancelled');
          if (error instanceof PreparationFailure) return error.failure;
          throw error;
        }
      }
      const resolved: (InstructionEntry & { content: string })[] = [];
      for (const entry of entries) {
        const content = files.get(referenceKey(entry.reference));
        if (content === undefined) return bindingFailure(snapshot, entry.reference.path, 'unavailable', 'Captured instruction body is unavailable');
        resolved.push({ ...entry, content });
      }
      return { status: 'ready', kind: 'instruction-scope', directory, instructions: resolved };
    },
  };
}
