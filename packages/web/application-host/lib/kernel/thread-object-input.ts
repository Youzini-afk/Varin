import path from 'node:path';
import type { ThreadIdentity, ThreadObjectReference, ThreadSource } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { resourceSource, resourceThreadSource } from './thread-context.js';

const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'reference-invalid' }); };
export function parseThreadObjectReferences(value: unknown, text: string): ThreadObjectReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fail('Object references must be an array');
  let previous = -1;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Invalid object reference');
    const { kind, start, end } = item;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || start < previous || text[start] !== '@') return fail('Object reference no longer matches the message');
    previous = end;
    if (kind === 'thread') {
      if (typeof item.threadId !== 'string' || !item.threadId || typeof item.branchId !== 'string' || !item.branchId
        || Object.keys(item).some(key => !['kind', 'threadId', 'branchId', 'start', 'end'].includes(key))) return fail('Invalid task reference');
      return { kind, start, end, threadId: item.threadId, branchId: item.branchId };
    }
    if (kind === 'directory') {
      if (typeof item.path !== 'string' || !item.path.trim() || item.path.includes('\0') || Object.keys(item).some(key => !['kind', 'path', 'start', 'end'].includes(key))) return fail('Invalid directory reference');
      return { kind, start, end, path: item.path };
    }
    return fail('Unknown object reference kind');
  });
}

export function createThreadObjectInputPreparer(owners: {
  runtime: Pick<AgentRuntimeClient, 'familyList' | 'thread' | 'launch'>;
  admitSource(source: ThreadSource, identity: ThreadIdentity, runId?: string, signal?: AbortSignal): Promise<void>;
}) {
  return async (input: ThreadIdentity & { text: string; references: ThreadObjectReference[]; source?: ThreadSource | null }, signal?: AbortSignal): Promise<string> => {
    input = { ...input, ...(input.source ? { source: structuredClone(input.source) } : {}) };
    const references = parseThreadObjectReferences(input.references, input.text) ?? [];
    if (!references.length) return input.text;
    const targets = references.filter((item): item is Extract<ThreadObjectReference, { kind: 'thread' }> => item.kind === 'thread');
    for (const threadId of new Set(targets.map(item => item.threadId))) {
      const pending = new Set(targets.filter(item => item.threadId === threadId).map(item => item.branchId));
      let cursor: string | undefined;
      const seen = new Set<string>();
      while (pending.size) {
        const page = await owners.runtime.familyList({ callerThreadId: input.threadId, includeSelf: true, scope: 'all', query: threadId, ...(cursor ? { cursor } : {}) }, signal);
        for (const member of page.members) if (member.threadId === threadId) for (const branch of member.branches) pending.delete(branch.branchId);
        if (!pending.size) break;
        if (!page.nextCursor || seen.has(page.nextCursor)) throw Object.assign(new Error('A referenced conversation is no longer available'), { code: 'reference-denied' });
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
    }
    let source = input.source;
    let runId: string | undefined;
    if (references.some(item => item.kind === 'directory')) {
      if (source === undefined) {
        const thread = await owners.runtime.thread(input.threadId, signal);
        const branch = thread?.branches.find(item => item.branch_id === input.branchId);
        runId = branch?.active_run_id ?? branch?.latest_run?.id;
        const launch = runId ? await owners.runtime.launch(runId, signal) : null;
        source = resourceThreadSource(launch?.selection.source ?? null) ?? undefined;
      }
      if (!source) throw Object.assign(new Error('A directory reference needs an admitted execution source'), { code: 'reference-unavailable' });
      await owners.admitSource(source, input, runId, signal);
    }
    const locators = references.map(reference => {
      if (reference.kind === 'thread') return { kind: reference.kind, label: input.text.slice(reference.start, reference.end), threadId: reference.threadId, branchId: reference.branchId };
      const directory = reference.path;
      // The picker only supplies current-source paths. References never grant access outside it.
      const root = source?.mode === 'live_root' ? source.liveRoot.canonicalRoot : undefined;
      const paths = root && /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
      if (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)) {
        if (paths === path.posix && path.win32.isAbsolute(directory) && !path.posix.isAbsolute(directory)) return fail('Directory reference uses a different source namespace');
        if (!root) return fail('An absolute directory reference needs its original live source');
        const relative = paths.relative(root, directory);
        if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return fail('The directory is outside this execution source');
      } else if (directory.split(/[\\/]/).some(part => part === '..')) return fail('Directory references cannot traverse outside the source');
      return { kind: reference.kind, label: input.text.slice(reference.start, reference.end), path: directory, source: resourceSource(source!) };
    });
    signal?.throwIfAborted();
    return `${input.text}\n\n[Selected object references. These locate existing objects; they do not change recipients or grant access.]\n${JSON.stringify(locators)}`;
  };
}
