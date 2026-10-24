import type { ManagedSourceReceiptRelease, ManagedSourceServiceCancelReceipt, SourceServiceOperation, SourceServiceResponse } from './managed-remote-types.js';
import { parseExtensionSourceSnapshot } from '../kernel/extension-source.js';
import { parseManagedExperimentInput } from './experiment-workspace.js';
import { parseScheduleReceipt } from '../kernel/managed-schedule-service.js';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const source = (value: unknown): boolean => record(value) && record(value.resource_owner) && text(value.workspace_id)
  && text(value.execution_workspace_id) && ['live_root', 'fixed_branch', 'materialized'].includes(String(value.mode));
const pin = (value: unknown): boolean => record(value) && text(value.pin_id) && text(value.root) && source(value.source);

export function decodeManagedSourceCancellation(input: { requestId: string; resourceEpoch: string }, value: unknown): ManagedSourceServiceCancelReceipt {
  if (!record(value) || value.requestId !== input.requestId || value.resourceEpoch !== input.resourceEpoch
    || !['drained', 'not_started', 'unknown'].includes(String(value.status))) {
    throw new Error('Managed source service cancellation is unconfirmed');
  }
  return value as unknown as ManagedSourceServiceCancelReceipt;
}

export function decodeManagedSourceReceiptRelease(input: { operationId: string; resourceEpoch: string }, value: unknown): ManagedSourceReceiptRelease {
  if (!record(value) || value.operationId !== input.operationId || value.resourceEpoch !== input.resourceEpoch
    || typeof value.released !== 'boolean' || !record(value.executionOwner) || value.executionOwner.kind !== 'external'
    || !text(value.executionOwner.identity) || !value.executionOwner.identity || value.executionOwner.epoch !== input.resourceEpoch) {
    throw new Error('Managed source receipt release is unconfirmed');
  }
  return value as unknown as ManagedSourceReceiptRelease;
}

/** One network-shape check for the closed Source service directory. The original
 * domain still verifies revisions, attribution, publication and effect facts. */
export function decodeManagedSourceResponse<Operation extends SourceServiceOperation>(operation: Operation, value: unknown): SourceServiceResponse<Operation> {
  let valid = false;
  switch (operation.kind) {
    case 'schedule': return parseScheduleReceipt(value) as SourceServiceResponse<Operation>;
    case 'mcp': valid = record(value) && typeof value.executorStopped === 'boolean'
      && (value.ok === true && value.executorStopped === true && Object.hasOwn(value, 'value')
        || value.ok === false && record(value.error) && text(value.error.code) && typeof value.error.dispatched === 'boolean'
        && ['unknown', 'session_expired', 'rpc_response'].includes(String(value.error.settlement))
        && value.executorStopped === (!value.error.dispatched || value.error.settlement !== 'unknown')); break;
    case 'validate': valid = record(value) && strings(value.pathScopes); break;
    case 'read': valid = record(value) && ['ready', 'unavailable', 'stale', 'failed', 'forbidden'].includes(String(value.status))
      && (value.status !== 'ready' || text(value.content) && text(value.revision) && text(value.source)); break;
    case 'document_read': valid = record(value) && text(value.bytesBase64) && Number.isSafeInteger(value.byteLength)
      && Number(value.byteLength) >= 0 && text(value.sourceUrl) && text(value.title) && text(value.contentType); break;
    case 'binary_write': valid = record(value) && ['applied', 'conflict', 'unknown'].includes(String(value.status))
      && value.operationId === operation.invocation.operationId && text(value.path) && value.fileJournal === true
      && typeof value.executorStopped === 'boolean' && (value.status === 'unknown' || value.executorStopped === true); break;
    case 'experiment_admit': valid = record(value) && text(value.cwd); break;
    case 'experiment_capture': return parseManagedExperimentInput(value) as SourceServiceResponse<Operation>;
    case 'experiment_read':
      valid = record(value) && text(value.bytesBase64) && text(value.hash) && Number.isSafeInteger(value.byteLength)
        && Number(value.byteLength) >= 0 && value.offset === operation.offset
        && Number.isSafeInteger(value.nextOffset) && typeof value.eof === 'boolean'; break;
    case 'package_capture':
      if (record(value) && value.captureId === operation.captureId) {
        return { captureId: operation.captureId, snapshot: parseExtensionSourceSnapshot(value.snapshot) } as SourceServiceResponse<Operation>;
      }
      break;
    case 'package_read': valid = record(value) && text(value.bytesBase64) && text(value.hash) && Number.isSafeInteger(value.byteLength)
      && Number(value.byteLength) >= 0 && value.offset === operation.offset && Number.isSafeInteger(value.nextOffset) && typeof value.eof === 'boolean'; break;
    case 'routing_workspace': valid = text(value); break;
    case 'language': valid = record(value) && text(value.status) && Array.isArray(value.items) && record(value.omissions); break;
    case 'resources_prepare': valid = record(value) && text(value.id) && record(value.scope)
      && Array.isArray(value.readers) && Array.isArray(value.capturedFiles) && Array.isArray(value.skills); break;
    case 'resource_read': case 'resource_list': valid = record(value) && text(value.status)
      && (value.status !== 'ready' || record(value.reference) && (operation.kind === 'resource_list' ? Array.isArray(value.entries) : text(value.content))); break;
    case 'compute': valid = record(value) && text(value.status) && Array.isArray(value.records); break;
    case 'structure_recipe': valid = record(value) && (value.recipeId === null || text(value.recipeId)); break;
    case 'structure_units': valid = record(value) && text(value.status) && text(value.revision) && Array.isArray(value.units); break;
    case 'original_source': valid = value === null || record(value) && text(value.root) && record(value.provenance); break;
    case 'child_prepare': valid = record(value) && source(value.source) && pin(value.pin) && record(value.provenance); break;
    case 'child_refresh_capture': valid = record(value) && value.captured === true; break;
    case 'child_result_prepare': case 'child_result_read': valid = value === null || record(value)
      && text(value.publicationId) && text(value.candidateOperationId) && text(value.workspaceId) && text(value.branchId)
      && text(value.root) && text(value.baseRoot) && text(value.pinId) && text(value.basePinId) && typeof value.writeRevision === 'number'; break;
    case 'child_result_publish': case 'code_capture': valid = record(value) && text(value.branchId) && typeof value.resultRevision === 'number'
      && strings(value.changedPaths) && record(value.pathStates) && record(value.baseStates); break;
    case 'integration': case 'code_apply': valid = record(value) && text(value.status) && strings(value.changedFiles); break;
    case 'user_integration': valid = record(value) && ['none', 'confirmed', 'partial', 'unknown'].includes(String(value.effect))
      && typeof value.executorStopped === 'boolean' && record(value.state) && Array.isArray(value.state.operations)
      && value.state.operations.every(row => record(row) && text(row.operationId) && text(row.sourceRunId) && text(row.state)
        && strings(row.appliedPaths) && strings(row.conflictPaths) && strings(row.needsAttentionPaths)
        && ['none', 'confirmed', 'partial', 'unknown'].includes(String(row.effect)) && typeof row.executorStopped === 'boolean')
      && (value.state.problem === undefined || text(value.state.problem))
      && (operation.request.command.action !== 'preview' || value.state.problem !== undefined || record(value.state.preview)
        && value.state.preview.threadId === operation.request.binding.childThreadId
        && value.state.preview.resultRevision === operation.request.binding.result.resultRevision); break;
    case 'check_path': case 'language_release': case 'child_release': case 'child_unaccepted_release':
      if (value === null || value === undefined || record(value)) return undefined as SourceServiceResponse<Operation>;
      break;
    // These intentionally retain the original native/domain result shape. Its
    // existing consumer performs the full receipt validation.
    case 'native_resource': valid = value === null || record(value); break;
  }
  if (!valid) throw new Error(`Managed source ${operation.kind} response is unconfirmed`);
  return value as SourceServiceResponse<Operation>;
}
