import { parseProjectTextEncoding, sourceTextEncodingChoiceId } from '../projects/text-encoding.js';
import { parseSourceDraftProvenance } from '../harness/working-state/source-drafts.js';
import { parseSourceResourceCapture } from './thread-resource-scope.js';
import { isDocumentTextFormat } from '../documents/inspect.js';
import type { ChildSourceProvenance, KernelTextPolicy, LaunchSource } from './protocol.generated.js';
import type { KernelScopedClient, KernelClient } from './kernel-client.js';
import type { WorkingOriginalSource } from '../harness/working-state/types.js';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const parseSourceProvenance = (value: unknown): ChildSourceProvenance => {
  const source = asRecord(value);
  const textEncoding = source.textEncoding === undefined ? undefined : (() => {
    const parsed = parseProjectTextEncoding(source.textEncoding);
    const policy = asRecord(source.textEncoding);
    if (policy.root !== undefined && typeof policy.root !== 'string') throw new Error('Working source text encoding root is malformed');
    return { ...parsed, ...(typeof policy.root === 'string' ? { root: policy.root } : {}) };
  })();
  const resources = source.resources === undefined ? undefined : parseSourceResourceCapture(source.resources);
  if (source.captureIdentity !== undefined && (typeof source.captureIdentity !== "string" || !/^[0-9a-f]{64}$/.test(source.captureIdentity))) {
    throw new Error("Working source capture identity is malformed");
  }
  const drafts = source.drafts === undefined ? undefined : parseSourceDraftProvenance(source.drafts);
  if (drafts && source.contentMode !== "fixed-draft-baseline") throw new Error("Working source draft mode is inconsistent");
  if (source.consistency === "fixed-root" && typeof source.root === "string" && source.root) {
    let selection:Extract<ChildSourceProvenance,{consistency:'fixed-root'}>['selection'];
    if(source.selection!==undefined){
      const raw=asRecord(source.selection);
      if(Object.keys(raw).some(key=>!['captureIdentity','contentMode','captureScopes','omittedDraftPaths','drafts'].includes(key))
        ||typeof raw.captureIdentity!=='string'||!/^[0-9a-f]{64}$/.test(raw.captureIdentity)
        ||!['saved-files','fixed-draft-baseline'].includes(String(raw.contentMode))
        ||!Array.isArray(raw.captureScopes)||!raw.captureScopes.every(item=>typeof item==='string')
        ||!Array.isArray(raw.omittedDraftPaths)||!raw.omittedDraftPaths.every(item=>typeof item==='string'))throw new Error('Workspace snapshot selection is malformed');
      const drafts=raw.drafts===undefined?undefined:parseSourceDraftProvenance(raw.drafts);
      if(drafts&&raw.contentMode!=='fixed-draft-baseline')throw new Error('Workspace draft snapshot mode is inconsistent');
      selection={captureIdentity:raw.captureIdentity,contentMode:raw.contentMode as 'saved-files'|'fixed-draft-baseline',captureScopes:raw.captureScopes as string[],omittedDraftPaths:raw.omittedDraftPaths as string[],...(drafts?{drafts}:{})};
    }
    return { consistency: source.consistency, root: source.root, ...(selection?{selection}:{}),...(resources ? { resources } : {}), ...(textEncoding ? { textEncoding } : {}) };
  }
  if (source.consistency === 'refreshed-root' && typeof source.root === 'string' && source.root
    && typeof source.previousRoot === 'string' && typeof source.incomingRoot === 'string'
    && typeof asRecord(source.incoming).run_id === 'string' && asRecord(source.incoming).source
    && Array.isArray(source.conflicts) && source.conflicts.every((p): p is string => typeof p === 'string')) {
    return { consistency: 'refreshed-root', root: source.root, previousRoot: source.previousRoot,
      incomingRoot: source.incomingRoot, incoming: source.incoming as Extract<ChildSourceProvenance, { consistency: 'refreshed-root' }>['incoming'],
      conflicts: source.conflicts, ...(resources ? { resources } : {}), ...(textEncoding ? { textEncoding } : {}) };
  }
  if ((source.consistency === "stable-capture" || source.consistency === "git-base-with-overlay")
    && (source.contentMode === "saved-files" || source.contentMode === "fixed-draft-baseline")
    && Array.isArray(source.captureScopes) && source.captureScopes.every((item): item is string => typeof item === "string")
    && Array.isArray(source.omittedDraftPaths) && source.omittedDraftPaths.every((item): item is string => typeof item === "string")) {
    return { consistency: source.consistency, contentMode: source.contentMode,
      captureScopes: [...source.captureScopes], omittedDraftPaths: [...source.omittedDraftPaths],
      ...(source.captureIdentity === undefined ? {} : { captureIdentity: source.captureIdentity as string }),
      ...(drafts ? { drafts } : {}), ...(resources ? { resources } : {}), ...(textEncoding ? { textEncoding } : {}) };
  }
  throw new Error("Working source provenance body is malformed");
};


/** Captured editor bytes use each draft's chosen codec, not the older disk rule. */
export function originalSourceTextEncoding(provenance: ChildSourceProvenance | undefined): KernelTextPolicy {
  const policy = provenance?.textEncoding ?? {};
  const drafts = provenance?.consistency === 'fixed-root' ? provenance.selection?.drafts
    : provenance && 'drafts' in provenance ? provenance.drafts : undefined;
  if (!drafts?.resources.length) return policy;
  const files: Record<string, string> = Object.assign(Object.create(null), policy.files);
  const seen = new Set<string>();
  for (const resource of drafts.resources) {
    if (seen.has(resource.resourceId)) throw new Error('Source draft paths are ambiguous');
    seen.add(resource.resourceId);
    files[resource.resourceId] = resource.encoding;
  }
  return { ...policy, files };
}

/** Shared reader for the original committed source receipt and immutable provenance object. */
export async function readOriginalSource(client: Pick<KernelScopedClient, 'getOperation' | 'getBlob'>,
  workspaceId: string, branchId: string, signal?: AbortSignal): Promise<WorkingOriginalSource | null> {
    // Captured physical sources and forked immutable sources are both current
    // production creation paths, with distinct original-operation identities.
    const operation = await client.getOperation(`branch-fork:${branchId}`, signal)
      ?? await client.getOperation(`branch-create:${branchId}`, signal);
    if (operation === null) {
      return null;
    }
    if ((operation.kind !== "branch.create" && operation.kind !== "branch.fork") || operation.state !== "committed") {
      throw new Error("Working source preparation is not committed");
    }
    const receipt = asRecord(operation.result);
    if (receipt.branchId !== branchId || receipt.workspaceId !== workspaceId
      || typeof receipt.root !== "string" || !receipt.root || receipt.writeRevision !== 0 || receipt.headRevision !== 0) {
      throw new Error("Working source preparation receipt has inconsistent provenance");
    }
    if (receipt.sourceProvenance === undefined) return null;
    const reference = asRecord(receipt.sourceProvenance);
    if (receipt.branchId !== branchId || receipt.workspaceId !== workspaceId
      || typeof receipt.root !== "string" || !receipt.root || receipt.writeRevision !== 0 || receipt.headRevision !== 0
      || typeof reference.objectHash !== "string" || !reference.objectHash
      || reference.recordId !== `working-source:${branchId}` || reference.slot !== "source-provenance") {
      throw new Error("Working source preparation receipt has inconsistent provenance");
    }
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const slice = await client.getBlob(reference.objectHash, { recordId: reference.recordId, slot: reference.slot },
        { offset, length: 256 * 1024, ...(signal ? { signal } : {}) });
      chunks.push(Buffer.from(slice.bytesBase64, "base64"));
      if (slice.eof) break;
      if (slice.nextOffset <= offset) throw new Error("Working source provenance cursor did not advance");
      offset = slice.nextOffset;
    }
    const provenance = parseSourceProvenance(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if ('root' in provenance && provenance.root !== receipt.root) {
      throw new Error("Working source provenance differs from its prepared branch");
    }
    return { root: receipt.root, provenance };
}

/** Encoding projection follows the selected branch authority, never another Run's private records. */
export async function readFixedSourceTextEncoding(client: Pick<KernelScopedClient, 'readBranch'>,
  workspaceId: string, branchId: string, revision: number, signal?: AbortSignal,
  selectedRoot?: string): Promise<KernelTextPolicy> {
  const selected = await client.readBranch({ branchId, revision, includeEntries: false }, signal);
  if (selected.workspaceId !== workspaceId || selected.branchId !== branchId || selected.revision !== revision || selected.view !== 'revision'
    || (selectedRoot !== undefined && selected.root !== selectedRoot)) throw new Error('Source text policy differs from the selected branch revision');
  return selected.textEncoding ?? {};
}

/** Native result publication has already checked every format against this exact result root. */
export function overlayResultTextEncoding(policy: KernelTextPolicy, value: unknown): KernelTextPolicy {
  if (value === undefined) return policy;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source result text formats are malformed');
  const files: Record<string, string> = Object.assign(Object.create(null), policy.files);
  for (const [file, item] of Object.entries(value)) {
    if (!file || file.includes('\\') || file.includes('\0') || /^[a-z]:/i.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Source result text format path is malformed');
    const format = asRecord(item);
    if (format.child !== undefined) {
      if (!isDocumentTextFormat(format.child)) throw new Error('Source result text format is malformed');
      files[file] = format.child.encoding;
    }
  }
  return { ...policy, ...(Object.keys(files).length ? { files } : {}) };
}

/** Source admission and query fallback use one frozen-source rule, on the original actor. */
export async function resolveSourceTextPolicy(kernel: Pick<KernelClient, 'textEncodingPolicy'>, client: KernelScopedClient,
  source: Pick<LaunchSource, 'mode' | 'workspace_id' | 'branch_id' | 'revision' | 'native_scope'>,
  physical: { rootId: string; canonicalRoot: string } | null, signal?: AbortSignal, selectedRoot?: string): Promise<KernelTextPolicy> {
  let frozen: KernelTextPolicy | undefined;
  if (source.mode === 'fixed_branch' || source.mode === 'materialized') {
    if (!source.branch_id || source.revision === null) throw new Error('Fixed text source is incomplete');
    frozen = await readFixedSourceTextEncoding(client, source.workspace_id, source.branch_id, source.revision, signal, selectedRoot);
  } else if (source.mode === 'native_workspace') {
    if (!source.branch_id) throw new Error('Native text source is incomplete');
    const captured = await client.readBranch({ branchId: source.branch_id, revision: 0, includeEntries: false }, signal);
    if (captured.workspaceId !== source.workspace_id || captured.branchId !== source.branch_id || captured.revision !== 0 || captured.view !== 'revision') throw new Error('Native text policy differs from its original branch');
    frozen = captured.textEncoding;
  }
  if (frozen !== undefined && !physical) return frozen;
  const policy = await kernel.textEncodingPolicy?.(source.workspace_id,
    physical ? { ...physical, client, ...(frozen === undefined ? {} : { frozenPolicy: frozen }),
      ...(source.mode === 'native_workspace' ? { ...(frozen === undefined ? {} : { choiceId: sourceTextEncodingChoiceId(source.workspace_id, source.branch_id!) }),
        ...(source.native_scope ? { sourcePath: source.native_scope } : {}) } : {}) } : null, signal);
  return policy ?? frozen ?? {};
}
