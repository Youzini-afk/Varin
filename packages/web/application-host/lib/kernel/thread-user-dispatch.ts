/** User handoff coordinates existing owners. Catalog retains the original command,
 * relation and receipt; this adapter never creates a detached conversation. */
import type { ThreadDispatchCatalog, ThreadDispatchInput, ThreadDispatchReceipt, ThreadIdentity } from '@varin/application-client';
import { isWorkFocusId, parseAttachmentSelections } from '@varin/protocol';
import type { ModelsService } from '../models/service.js';
import { readDelegationModelCatalog } from '../models/delegation-catalog.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ThreadAttachmentOwner } from './thread-attachments.js';
import type { UserChildDispatchCommand } from './protocol.generated.js';
import { ThreadPreAdmissionError } from './thread-adapter.js';
import { KernelRequestError } from './kernel-error.js';

const invalid = (message: string): never => { throw new ThreadPreAdmissionError(Object.assign(new Error(message), { code: 'handoff-invalid' })); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function parseThreadDispatchInput(value: unknown): ThreadDispatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Handoff input must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['runtime', 'threadId', 'branchId', 'key', 'runId', 'expectedHead', 'text', 'name', 'model', 'thinking', 'projectId', 'workMode', 'workFocus', 'background', 'attachments'].includes(key))
    || input.runtime !== 'agent' || !['threadId', 'branchId', 'key', 'runId', 'text', 'model'].every(key => nonempty(input[key]))
    || !(input.expectedHead === null || nonempty(input.expectedHead)) || !(input.projectId === null || nonempty(input.projectId))
    || !['shared', 'read_only', 'isolated_write'].includes(String(input.workMode))
    || input.workFocus !== undefined && !isWorkFocusId(input.workFocus)
    || input.name !== undefined && !nonempty(input.name) || input.thinking !== undefined && !nonempty(input.thinking)) return invalid('Select a native Thread, model, source and handoff instructions');
  if (input.background !== undefined && (!Array.isArray(input.background) || input.background.some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const reference = value as Record<string, unknown>;
    return Object.keys(reference).some(key => !['threadId', 'branchId', 'headId', 'itemIds'].includes(key))
      || !['threadId', 'branchId', 'headId'].every(key => nonempty(reference[key])) || !Array.isArray(reference.itemIds)
      || !reference.itemIds.length || reference.itemIds.some(value => !nonempty(value)) || new Set(reference.itemIds).size !== reference.itemIds.length;
  }))) return invalid('Select exact history items and their original history position');
  try { parseAttachmentSelections(input.attachments); } catch (error) { throw new ThreadPreAdmissionError(error, 'handoff-preparation-failed'); }
  return input as unknown as ThreadDispatchInput;
}
function command(input: ThreadDispatchInput): UserChildDispatchCommand {
  return { key: input.key, threadId: input.threadId, branchId: input.branchId, runId: input.runId, expectedHead: input.expectedHead,
    input: { task: input.text, model: input.model, thinking: input.thinking ?? 'default', workMode: input.workMode,
      ...(input.workFocus === undefined ? {} : { workFocus: input.workFocus }),
      ...(input.name === undefined ? {} : { name: input.name }), ...(input.projectId === null ? {} : { projectId: input.projectId }),
      ...(input.background?.length ? { background: input.background } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}) } };
}
const receipt = (value: import('./protocol.generated.js').UserChildDispatchReceipt): ThreadDispatchReceipt => {
  if (value.actor.kind !== 'user') throw new Error('Handoff receipt has an unexpected author');
  return { ...value, actor: { kind: 'user' } };
};
export function createThreadUserDispatch(owners: { runtime: AgentRuntimeClient; models: ModelsService; attachments: ThreadAttachmentOwner; ensureOrganization?: (signal?: AbortSignal) => Promise<void> }) {
  // Transient scheduling only. Catalog remains the identity/receipt owner. A failed
  // repeat must not announce "not started" while an earlier request can still commit.
  const pending = new Map<string, Promise<void>>();
  return {
    async catalog(identity: ThreadIdentity, signal?: AbortSignal): Promise<ThreadDispatchCatalog> {
      const thread = await owners.runtime.thread(identity.threadId, signal);
      const branch = thread.branches.find(branch => branch.branch_id === identity.branchId);
      if (identity.runtime !== 'agent' || thread.deleted_at_ms != null || !branch) return invalid('The handoff conversation is unavailable');
      if (!branch.active_run_id && !branch.latest_run) return { runId: null, headId: branch.head, models: [], projects: [], unavailable: 'Start a conversation before handing off a new task.' };
      const [native, models] = await Promise.all([
        owners.runtime.userChildDispatchCatalog({ threadId: identity.threadId, branchId: identity.branchId }, signal),
        readDelegationModelCatalog(owners.models, { enabled: false }),
      ]);
      signal?.throwIfAborted();
      return { runId: native.runId, headId: native.headId, projects: native.projects.map(({ id, name, path }) => ({ id, name, path })),
        models: models.candidates.map(({ id, name, channelName, thinkingLevels, defaultThinkingLevel }) => ({ id, name, channelName, thinkingLevels, defaultThinkingLevel })) };
    },
    async dispatch(raw: ThreadDispatchInput, signal?: AbortSignal): Promise<ThreadDispatchReceipt> {
      const input = parseThreadDispatchInput(raw), selected = command(input);
      const identity = JSON.stringify([input.threadId, input.branchId, input.key]);
      const previous = pending.get(identity);
      let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; });
      pending.set(identity, current);
      await previous;
      try {
      // Receipt lookup itself is not an admission attempt. An unavailable lookup
      // cannot prove that the original command was never accepted.
      const old = await owners.runtime.userChildDispatchReceipt(selected, signal);
      if (old) return receipt(old);
      let preparedAttachments: Awaited<ReturnType<ThreadAttachmentOwner['prepare']>> = [];
      const operationId = `user-dispatch:${Buffer.byteLength(input.branchId, 'utf8')}:${input.branchId}:${input.key}`;
      const targetThreadId = `thread:child:${operationId}`;
      let dispatched = false;
      try {
        if (input.projectId !== null) await owners.ensureOrganization?.(signal);
        const catalog = await readDelegationModelCatalog(owners.models, { enabled: false }, input.model);
        const model = catalog.candidates.find(model => model.id === input.model);
        if (!model || input.thinking !== undefined && input.thinking !== 'default' && !model.thinkingLevels.includes(input.thinking as never)) return invalid('The selected handoff model or thinking option is no longer available');
        // The owner fixes exact file versions. No history or file is selected implicitly.
        const selections = parseAttachmentSelections(input.attachments) ?? [];
        if (selections.length) preparedAttachments = await owners.attachments.prepare(input, selections, operationId, targetThreadId, signal);
        const preparedAttachmentMedia = [];
        for (const attachment of preparedAttachments) if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType)) {
          if (!model.input.includes('image')) return invalid('The selected handoff model does not support the selected image attachments');
          const original = await owners.attachments.read(input, attachment.ref, signal);
          const chunks: Uint8Array[] = [];
          for await (const chunk of original.stream) chunks.push(chunk);
          preparedAttachmentMedia.push({ media_type: attachment.mimeType, data_base64: Buffer.concat(chunks).toString('base64') });
        }
        signal?.throwIfAborted();
        dispatched = true;
        return receipt(await owners.runtime.acceptUserChildDispatch({ ...selected, preparedAttachments, preparedAttachmentMedia }, signal));
      } catch (error) {
        let definitelyRejected = !dispatched || error instanceof KernelRequestError && error.settlement === 'not_dispatched';
        if (dispatched && error instanceof KernelRequestError && error.settlement === 'response') {
          // A completed native request can be reconciled. A disconnected request may still
          // commit later, so null from an opportunistic read must not authorize another key.
          const committed = await owners.runtime.userChildDispatchReceipt(selected).catch(() => undefined);
          if (committed) return receipt(committed);
          definitelyRejected = committed === null;
        }
        if (definitelyRejected && preparedAttachments.length) {
          await owners.attachments.releaseUnpublished(input, operationId, targetThreadId, preparedAttachments.map(value => value.ref)).catch(() => undefined);
        }
        if (definitelyRejected && !(error instanceof ThreadPreAdmissionError)) throw new ThreadPreAdmissionError(error, 'handoff-preparation-failed');
        throw error;
      }
      } finally {
        release();
        if (pending.get(identity) === current) pending.delete(identity);
      }
    },
  };
}
