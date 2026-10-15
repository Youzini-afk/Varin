import { VarinExtensionContractError } from './contract-error.js';
import { parseVarinHostServiceComposition, type VarinHostServiceComposition } from './service-composition.js';
import type { VarinExtensionCapabilityGrant, VarinExtensionSurfaceReadiness } from './types.js';

export type VarinExtensionRestartHandoffStatus = 'pending-restart' | 'preparing' | 'waiting-surface' | 'applied'
  | 'failed' | 'restore-pending-restart' | 'restored';

/** Durable intent and result in the original Catalog, independent of process-local actual state. */
export interface VarinExtensionRestartHandoff {
  id: string;
  candidateIntegrity: string;
  selectedIntegrity: string;
  selectedVersion: string;
  desiredRevision: number;
  capabilityGrants: VarinExtensionCapabilityGrant[];
  composition: VarinHostServiceComposition;
  surfaceEntrypoints: string[];
  requestedProcessId: string;
  executionProcessId?: string;
  restoreRequestedProcessId?: string;
  status: VarinExtensionRestartHandoffStatus;
  requestedAt: string;
  updatedAt: string;
  failure?: { code: string; message: string };
  surfaceReadiness?: VarinExtensionSurfaceReadiness;
}

export interface VarinExtensionRestartHandoffRequest {
  extensionId: string;
  candidateIntegrity: string;
  expectedRevision: number;
  /** Caller-generated identity makes response-loss recovery read the original attempt. */
  handoffId: string;
}

export interface VarinExtensionRestartRecoveryRequest {
  extensionId: string;
  handoffId: string;
  expectedRevision: number;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (message: string): never => { throw new VarinExtensionContractError('Invalid extension restart handoff', [message]); };
const text = (v: unknown, label: string): string => typeof v === 'string' && v.trim() ? v : fail(`${label} must be nonempty`);
const revision = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : fail('Invalid revision');
const hash = (v: unknown): string => typeof v === 'string' && /^sha256-[a-f0-9]{64}$/.test(v) ? v : fail('Invalid artifact integrity');
const date = (v: unknown): string => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : fail('Invalid timestamp');

export function parseVarinExtensionRestartRecoveryRequest(value: unknown): VarinExtensionRestartRecoveryRequest {
  if (!object(value)) return fail('Request must be an object');
  return { extensionId: text(value.extensionId, 'extensionId'), handoffId: text(value.handoffId, 'handoffId'), expectedRevision: revision(value.expectedRevision) };
}

export function parseVarinExtensionRestartHandoffRequest(value: unknown): VarinExtensionRestartHandoffRequest {
  const request = parseVarinExtensionRestartRecoveryRequest(value);
  return { ...request, candidateIntegrity: hash((value as Record<string, unknown>).candidateIntegrity) };
}

export function parseVarinExtensionRestartHandoffs(value: unknown): VarinExtensionRestartHandoff[] {
  if (!Array.isArray(value)) return fail('Handoffs must be an array');
  const records = value.map((raw): VarinExtensionRestartHandoff => {
    if (!object(raw) || !['pending-restart', 'preparing', 'waiting-surface', 'applied', 'failed', 'restore-pending-restart', 'restored'].includes(String(raw.status))) return fail('Invalid state');
    if (!Array.isArray(raw.surfaceEntrypoints) || !Array.isArray(raw.capabilityGrants)) return fail('Invalid group or review');
    const surfaceEntrypoints = raw.surfaceEntrypoints.map(v => text(v, 'Surface entrypoint'));
    if (new Set(surfaceEntrypoints).size !== surfaceEntrypoints.length) return fail('Duplicate Surface member');
    const capabilityGrants = raw.capabilityGrants.map((g): VarinExtensionCapabilityGrant => {
      if (!object(g) || !['host', 'surface'].includes(String(g.realm)) || typeof g.granted !== 'boolean') return fail('Invalid capability review');
      return { capability: text(g.capability, 'capability'), realm: g.realm as 'host' | 'surface', granted: g.granted,
        manifestVersion: text(g.manifestVersion, 'manifestVersion'), updatedAt: date(g.updatedAt) };
    });
    const result: VarinExtensionRestartHandoff = {
      id: text(raw.id, 'id'), candidateIntegrity: hash(raw.candidateIntegrity), selectedIntegrity: hash(raw.selectedIntegrity),
      selectedVersion: text(raw.selectedVersion, 'selectedVersion'), desiredRevision: revision(raw.desiredRevision),
      capabilityGrants, composition: parseVarinHostServiceComposition(raw.composition), surfaceEntrypoints,
      requestedProcessId: text(raw.requestedProcessId, 'requestedProcessId'), status: raw.status as VarinExtensionRestartHandoffStatus,
      requestedAt: date(raw.requestedAt), updatedAt: date(raw.updatedAt),
      ...(raw.executionProcessId === undefined ? {} : { executionProcessId: text(raw.executionProcessId, 'executionProcessId') }),
      ...(raw.restoreRequestedProcessId === undefined ? {} : { restoreRequestedProcessId: text(raw.restoreRequestedProcessId, 'restoreRequestedProcessId') }),
    };
    if (raw.failure !== undefined) {
      if (!object(raw.failure)) return fail('Invalid failure');
      result.failure = { code: text(raw.failure.code, 'failure code'), message: text(raw.failure.message, 'failure message') };
    }
    if (raw.surfaceReadiness !== undefined) {
      const receipt = raw.surfaceReadiness;
      if (!object(receipt) || !object(receipt.hostPreparation) || !Array.isArray(receipt.members)
        || !['web', 'desktop', 'mobile'].includes(String(receipt.surface))) return fail('Invalid Surface receipt');
      result.surfaceReadiness = { ...(receipt.preparedConsumerCount === undefined ? {} : { preparedConsumerCount: revision(receipt.preparedConsumerCount) }), realmId: text(receipt.realmId, 'realmId'), surface: receipt.surface as VarinExtensionSurfaceReadiness['surface'],
        hostPreparation: { id: text(receipt.hostPreparation.id, 'preparation ID'), hostId: text(receipt.hostPreparation.hostId, 'hostId'),
          desiredRevision: revision(receipt.hostPreparation.desiredRevision), generation: revision(receipt.hostPreparation.generation) },
        members: receipt.members.map(member => {
          if (!object(member)) return fail('Invalid Surface member');
          return { entrypointId: text(member.entrypointId, 'entrypointId'), generation: revision(member.generation) };
        }) };
    }
    if (['preparing', 'waiting-surface', 'applied'].includes(result.status) && !result.executionProcessId) return fail('Execution identity missing');
    if (result.status === 'restore-pending-restart' && !result.restoreRequestedProcessId) return fail('Recovery identity missing');
    if (result.status === 'failed' && !result.failure) return fail('Failure result missing');
    return result;
  });
  if (new Set(records.map(record => record.id)).size !== records.length) return fail('Duplicate handoff identity');
  if (records.filter(record => !['applied', 'failed', 'restored'].includes(record.status)).length > 1) return fail('Multiple pending handoffs');
  return records;
}

export interface VarinExtensionRestartCommit {
  id: string;
  processId: string;
  surfaceReadiness?: VarinExtensionSurfaceReadiness;
}
