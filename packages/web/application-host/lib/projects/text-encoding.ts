import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectFolders, projectPathKey, type ProjectFolders } from '@varin/application-client';
import { createProjectIdFromPath } from './project-id.js';

/** Project-owned interpretation, not a filesystem capability. Exact files precede directory rules. */
export interface ProjectTextEncoding {
  defaultEncoding?: string;
  files?: Record<string, string>;
  /** Only explicit user choices advance this revision; receipt reconciliation does not. */
  choiceRevisions?: Record<string, number>;
}
export interface SourceTextEncoding extends ProjectTextEncoding { root?: string }
export const hasTextEncodingRules = (policy: SourceTextEncoding | undefined): boolean => Boolean(policy?.defaultEncoding || Object.keys(policy?.files ?? {}).length || Object.keys(policy?.choiceRevisions ?? {}).length);
interface EncodingProject extends ProjectFolders { id: string }

export function parseProjectTextEncoding(value: unknown): ProjectTextEncoding {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project textEncoding must be an object');
  const input = value as Record<string, unknown>;
  const encoding = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Text encoding must be a nonempty codec name');
    return value.trim(); // Rust resolves aliases and validates supported codecs when they are used.
  };
  const result: ProjectTextEncoding = {};
  if (input.defaultEncoding !== undefined) result.defaultEncoding = encoding(input.defaultEncoding);
  if (input.files !== undefined) {
    if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) throw new Error('Text encoding files must be an object');
    result.files = Object.fromEntries(Object.entries(input.files).map(([key, value]) => {
      if (!key || key.includes('\0')) throw new Error('Text encoding file path must be nonempty');
      return [key.replaceAll('\\', '/'), encoding(value)];
    }));
  }
  if (input.choiceRevisions !== undefined) {
    if (!input.choiceRevisions || typeof input.choiceRevisions !== 'object' || Array.isArray(input.choiceRevisions)) throw new Error('Text encoding choice revisions must be an object');
    result.choiceRevisions = Object.fromEntries(Object.entries(input.choiceRevisions).map(([key, revision]) => {
      if (!key || key.includes('\0') || !Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error('Invalid text encoding choice revision');
      return [key.replaceAll('\\', '/'), Number(revision)];
    }));
  }
  return result;
}

const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`);
const absolute = (value: string) => value.startsWith('/') || /^[a-z]:\//i.test(value);
const join = (root: string, relative: string) => path.posix.normalize(`${root.replace(/\/$/, '')}/${relative}`);

/** Canonical registration remains the namespace even when execution uses a materialized copy. */
export function textEncodingNamespace(canonicalRoot: string, projects: readonly EncodingProject[]) {
  const root = projectPathKey(canonicalRoot);
  const candidates = projects.flatMap(project => projectFolders(project).map(folder => ({ project, folder: projectPathKey(folder) })))
    .filter(candidate => within(candidate.folder, root)).sort((a, b) => b.folder.length - a.folder.length);
  const selected = candidates[0];
  return { projectId: selected?.project.id ?? createProjectIdFromPath(root), root,
    projectRoot: selected ? projectPathKey(selected.project.path) : root };
}

/** Project both choices and their revisions through exactly the same path namespace. */
function projectPaths<T>(values: Record<string, T>, namespace: { root: string; projectRoot: string }): Record<string, T> {
  const files: Record<string, T> = Object.create(null);
  const priorities = new Map<string, { depth: number; explicit: boolean }>();
  for (const [key, value] of Object.entries(values)) {
    const directory = key.endsWith('/');
    const target = projectPathKey(absolute(key) ? key : join(namespace.projectRoot, key));
    let relative: string | undefined;
    if (directory && within(target, namespace.root)) {
      relative = './';
    } else if (within(namespace.root, target)) {
      const selected = target.slice(namespace.root === '/' ? 1 : namespace.root.length + 1);
      if (selected) relative = selected + (directory ? '/' : '');
    }
    if (relative) {
      const previous = priorities.get(relative);
      // The closest ancestor wins. A remembered absolute file beats its same-path declaration.
      if (previous && (previous.depth > target.length || previous.depth === target.length && previous.explicit && !absolute(key))) continue;
      files[relative] = value;
      priorities.set(relative, { depth: target.length, explicit: absolute(key) });
    }
  }
  return files;
}

/** Resolve settings once into source-relative rules; never expose unrelated project folder paths. */
export function projectTextEncodingForSource(config: ProjectTextEncoding, namespace: { root: string; projectRoot: string }): SourceTextEncoding {
  const files = projectPaths(config.files ?? {}, namespace);
  const choiceRevisions = projectPaths(config.choiceRevisions ?? {}, namespace);
  return { root: namespace.root, ...(config.defaultEncoding ? { defaultEncoding: config.defaultEncoding } : {}),
    ...(Object.keys(files).length ? { files } : {}), ...(Object.keys(choiceRevisions).length ? { choiceRevisions } : {}) };
}

export function textEncodingForResource(policy: SourceTextEncoding, resourceId: string): { encoding?: string; defaultEncoding?: string } {
  const windows = /^[a-z]:/i.test(policy.root ?? '') || policy.root?.startsWith('//');
  let key = resourceId.replaceAll('\\', '/').replace(/^\.\//, '');
  if (absolute(key)) {
    const root = policy.root ? projectPathKey(policy.root) : undefined;
    const selected = projectPathKey(key);
    // A device file may be readable without belonging to this project's configuration namespace.
    if (!root || !within(root, selected)) return {};
    key = selected.slice(root === '/' ? 1 : root.length + 1);
  }
  const target = windows ? key.toLowerCase() : key;
  let selected: string | undefined;
  let specificity = -1;
  for (const [rule, encoding] of Object.entries(policy.files ?? {})) {
    const normalized = windows ? rule.toLowerCase() : rule;
    if (normalized === target) { selected = encoding; break; }
    if ((normalized === './' || normalized.endsWith('/') && target.startsWith(normalized)) && normalized.length > specificity) {
      selected = encoding; specificity = normalized.length;
    }
  }
  return { ...(selected ? { encoding: selected } : {}), ...(policy.defaultEncoding ? { defaultEncoding: policy.defaultEncoding } : {}) };
}

/** Explicit choices on an isolated native branch must not alter its original live project. */
export const sourceTextEncodingChoiceId = (workspaceId: string, branchId: string): string =>
  `source_${createHash('sha256').update(JSON.stringify([workspaceId, branchId])).digest('hex')}`;

/** A previously admitted physical source. The service cannot create or widen its grant. */
export interface TextEncodingSource {
  rootId: string;
  canonicalRoot: string;
  /** Owning identity may differ from a Documents native-view navigation identity. */
  workspaceId?: string;
  /** Source admission may bind a subtree of the registered original workspace. */
  sourcePath?: string;
  /** Immutable captured interpretation; physical conversion receipts only overlay this baseline. */
  frozenPolicy?: SourceTextEncoding;
  /** Existing configuration owner, keyed by the stable actual branch rather than mount path. */
  choiceId?: string;
  client: Pick<import('../kernel/kernel-client.js').KernelScopedClient, 'fileTextConversions' | 'fileRead'>;
}

export function createProjectTextEncodingService(options: {
  projects(): Promise<readonly EncodingProject[]>;
  canonicalRoot(workspaceId: string): Promise<string>;
  read(projectId: string): Promise<ProjectTextEncoding>;
  remember(projectId: string, filePath: string, encoding: string, minimumRevision?: number): Promise<void>;
  reconcile?(projectId: string, filePath: string, encoding: string, choiceRevision: number, matchesCurrent: () => Promise<boolean>): Promise<boolean>;
  /** Optional original Documents root, admitted by its existing owner for read-only inspection. */
  source?(workspaceId: string): Promise<TextEncodingSource | undefined>;
}) {
  const namespaceFor = async (workspaceId: string) => textEncodingNamespace(await options.canonicalRoot(workspaceId), await options.projects());
  const policyFor = async (workspaceId: string, source?: TextEncodingSource | null, signal?: AbortSignal, resourceId?: string): Promise<SourceTextEncoding> => {
    const admitted = source === null ? undefined : source ?? await options.source?.(workspaceId);
    const frozen = admitted?.frozenPolicy;
    const baseNamespace = frozen?.root ? textEncodingNamespace(frozen.root, await options.projects()) : await namespaceFor(workspaceId);
    let namespace = baseNamespace;
    if (admitted?.sourcePath) {
      const root = projectPathKey(join(namespace.root, admitted.sourcePath));
      if (!within(namespace.root, root)) throw new Error('Text encoding source is outside its project namespace');
      namespace = { ...namespace, root };
    }
    const readPolicy = async () => {
      if (frozen === undefined) return projectTextEncodingForSource(await options.read(namespace.projectId), namespace);
      const baseline = projectTextEncodingForSource(frozen, { root: namespace.root, projectRoot: frozen.root ?? baseNamespace.root });
      if (!admitted?.choiceId) return baseline;
      const choices = projectTextEncodingForSource(await options.read(admitted.choiceId), namespace);
      return { ...baseline,
        ...(choices.files ? { files: { ...baseline.files, ...choices.files } } : {}),
        ...(choices.choiceRevisions ? { choiceRevisions: { ...baseline.choiceRevisions, ...choices.choiceRevisions } } : {}) };
    };
    let policy = await readPolicy();
    if (!admitted) return policy;
    const queryWorkspace = admitted.workspaceId ?? workspaceId;
    let selectedPath = resourceId?.replaceAll('\\', '/').replace(/^\.\//, '');
    if (selectedPath !== undefined && absolute(selectedPath)) {
      const selected = projectPathKey(selectedPath);
      if (!within(namespace.root, selected)) return policy;
      selectedPath = selected.slice(namespace.root === '/' ? 1 : namespace.root.length + 1);
    }
    const canonicalRoot = projectPathKey(admitted.canonicalRoot);
    const original = frozen === undefined && canonicalRoot === namespace.root;
    const overlays = new Map<string, { encoding: string; choiceRevision: number }>();
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await admitted.client.fileTextConversions({ workspaceId: queryWorkspace, rootId: admitted.rootId,
        ...(selectedPath === undefined ? {} : { path: selectedPath }),
        ...(cursor === undefined ? {} : { cursor }) }, signal);
      for (const receipt of page.conversions) {
        signal?.throwIfAborted();
        // A root registration and a path are not permission to project an isolated copy into
        // the original project. Require its frozen namespace, and keep copies source-local.
        if (!receipt.policyRoot || projectPathKey(receipt.policyRoot) !== namespace.root
          || projectPathKey(receipt.canonicalRoot) !== canonicalRoot || !receipt.path
          || absolute(receipt.path) || receipt.path.includes('\\') || receipt.path.includes('\0')
          || receipt.path.split('/').some(part => !part || part === '.' || part === '..')
          || !Number.isSafeInteger(receipt.choiceRevision) || receipt.choiceRevision < 0
          || !receipt.sourceEncoding || !receipt.targetEncoding || receipt.sourceEncoding === receipt.targetEncoding) continue;
        const key = projectPathKey(join(namespace.root, receipt.path)).slice(namespace.root === '/' ? 1 : namespace.root.length + 1);
        if ((policy.choiceRevisions?.[key] ?? 0) !== receipt.choiceRevision) continue;
        const matchesCurrent = async () => {
          const current = await admitted.client.fileRead({ workspaceId: queryWorkspace, rootId: admitted.rootId,
            path: receipt.path, raw: true, offset: 0, length: 0 }, signal);
          return !current.missing && current.content?.hash === receipt.rawHash;
        };
        if (original) {
          // An already reconciled choice needs no additional file hashing or config write.
          if (policy.files?.[key] === receipt.targetEncoding) continue;
          await options.reconcile?.(namespace.projectId, projectPathKey(join(namespace.root, receipt.path)),
            receipt.targetEncoding, receipt.choiceRevision, matchesCurrent);
          policy = await readPolicy();
        } else if (await matchesCurrent()) {
          // Recheck after I/O so a concurrent manual reopen remains newer than this receipt.
          policy = await readPolicy();
          if ((policy.choiceRevisions?.[key] ?? 0) === receipt.choiceRevision) overlays.set(key, { encoding: receipt.targetEncoding, choiceRevision: receipt.choiceRevision });
        }
      }
      if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor === cursor)) throw new Error('Invalid text conversion cursor');
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    if (!overlays.size) return policy;
    policy = await readPolicy();
    const files: Record<string, string> = Object.assign(Object.create(null), policy.files);
    for (const [key, choice] of overlays) if ((policy.choiceRevisions?.[key] ?? 0) === choice.choiceRevision) files[key] = choice.encoding;
    return { ...policy, files };
  };
  return {
    policyFor,
    async resolve(resource: { workspaceId: string; resourceId: string }) { return textEncodingForResource(await policyFor(resource.workspaceId, undefined, undefined, resource.resourceId), resource.resourceId); },
    async remember(resource: { workspaceId: string; resourceId: string }, encoding: string) {
      const source = await options.source?.(resource.workspaceId);
      const frozen = source?.frozenPolicy;
      const baseNamespace = frozen?.root ? textEncodingNamespace(frozen.root, await options.projects()) : await namespaceFor(resource.workspaceId);
      const namespace = source?.sourcePath ? { ...baseNamespace, root: projectPathKey(join(baseNamespace.root, source.sourcePath)) } : baseNamespace;
      if (!within(baseNamespace.root, namespace.root)) throw new Error('Text encoding source is outside its project namespace');
      const filePath = projectPathKey(absolute(resource.resourceId.replaceAll('\\', '/')) ? resource.resourceId : join(namespace.root, resource.resourceId));
      if (filePath === namespace.root || !within(namespace.root, filePath)) throw new Error('Text encoding choice is outside its project source');
      if (frozen !== undefined && source?.choiceId) {
        const baseline = projectTextEncodingForSource(frozen, { root: namespace.root, projectRoot: frozen.root ?? baseNamespace.root });
        const relative = filePath.slice(namespace.root === '/' ? 1 : namespace.root.length + 1);
        await options.remember(source.choiceId, filePath, encoding, baseline.choiceRevisions?.[relative] ?? 0);
      } else await options.remember(namespace.projectId, filePath, encoding);
    },
  };
}
