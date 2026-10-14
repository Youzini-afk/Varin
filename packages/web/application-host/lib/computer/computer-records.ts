/** Internal Computer runtime records. Desktop settings and user files are separate assets. */
import { parseComputerActor, parseComputerExecutionRef, parseComputerWorkRef, type ComputerActor, type ComputerDesktop, type ComputerWorkAssociation } from '@varin/protocol';
import { HarnessServiceError } from '../harness/service-error.js';
import { ComputerError } from './computer-error.js';

export interface ComputerPhysicalControl {
  owner: { hostId: string; controlEpoch: string; inputOwnerId: string };
  holder: { kind: 'assignment'; assignmentId: string; actor: ComputerActor; origin?: string }
    | { kind: 'human'; holderId: string };
  since: string;
}
export interface ComputerInterrupted { id: string; actor: ComputerActor; at: string; holderId?: string; returned?: true; notice?: { label: string; releaseConfirmed: boolean } }
export interface PendingComputerControlEvent {
  id: string;
  kind: 'takeover' | 'cancel' | 'handback';
  desktopId: string;
  label: string;
  at: string;
  actor: ComputerActor;
  releaseConfirmed: boolean;
  /** A separate exact Stop command. The original fact above stays immutable. */
  cancelPending?: true;
}
export interface PendingComputerControlCancellation {
  id: string;
  actor: ComputerActor;
  desktopId: string;
  pendingEventIds: string[];
}
export interface ComputerRuntimeRecord {
  usage?: NonNullable<ComputerDesktop['usage']>;
  work?: ComputerWorkAssociation[];
  interrupted?: ComputerInterrupted;
  controlEvents: PendingComputerControlEvent[];
  controlCancellations: PendingComputerControlCancellation[];
  physicalControl?: ComputerPhysicalControl;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const invalid = (): never => { throw new ComputerError('computer-runtime-record-invalid', 'Desktop control metadata is malformed; input remains fenced'); };

export function decodeComputerRuntime(body: Record<string, unknown>): ComputerRuntimeRecord {
  const nonempty = (value: unknown) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
  if (body.runtimeVersion !== 5 && ['usage', 'work', 'interrupted', 'handbackEvents', 'controlEvents', 'controlCancellations', 'physicalControl'].some(key => nonempty(body[key]))) {
    throw new ComputerError('computer-runtime-format-unsupported', 'This desktop has an obsolete internal work/control record; stop its original physical session before resetting its runtime metadata');
  }
  if (body.runtimeVersion !== undefined && body.runtimeVersion !== 5) return invalid();
  try {
    const result: ComputerRuntimeRecord = { controlEvents: [], controlCancellations: [] };
    if (body.usage != null) {
      if (!object(body.usage) || !id(body.usage.at)) return invalid();
      result.usage = { execution: parseComputerExecutionRef(body.usage.execution), at: body.usage.at };
    }
    if (body.work != null) {
      if (!Array.isArray(body.work)) return invalid();
      result.work = body.work.map((entry): ComputerWorkAssociation => {
        if (!object(entry) || !id(entry.at)) return invalid();
        const work = parseComputerWorkRef(entry.work);
        if ('registry' in entry) return invalid();
        return { work, at: entry.at };
      });
    }
    if (body.interrupted != null) {
      const value = body.interrupted;
      if (!object(value) || !id(value.id) || !id(value.at) || value.holderId !== undefined && !id(value.holderId) || value.returned !== undefined && value.returned !== true) return invalid();
      if (value.notice !== undefined && (!object(value.notice) || !id(value.notice.label) || typeof value.notice.releaseConfirmed !== 'boolean')) return invalid();
      result.interrupted = { id: value.id, actor: parseComputerActor(value.actor), at: value.at, ...(value.returned ? { returned: true } : {}), ...(value.notice ? { notice: value.notice as NonNullable<ComputerInterrupted['notice']> } : {}), ...(value.holderId === undefined ? {} : { holderId: value.holderId }) };
    }
    if (body.controlEvents != null) {
      if (!Array.isArray(body.controlEvents)) return invalid();
      result.controlEvents = body.controlEvents.map((entry): PendingComputerControlEvent => {
        if (!object(entry) || !id(entry.id) || !id(entry.desktopId) || !id(entry.label) || !id(entry.at) || !['takeover', 'cancel', 'handback'].includes(String(entry.kind))
          || typeof entry.releaseConfirmed !== 'boolean' || entry.cancelPending !== undefined && (entry.cancelPending !== true || entry.kind !== 'handback')) return invalid();
        return { id: entry.id, kind: entry.kind as PendingComputerControlEvent['kind'], desktopId: entry.desktopId, label: entry.label,
          at: entry.at, actor: parseComputerActor(entry.actor), releaseConfirmed: entry.releaseConfirmed, ...(entry.cancelPending ? { cancelPending: true } : {}) };
      });
    }
    if (body.controlCancellations != null) {
      if (!Array.isArray(body.controlCancellations)) return invalid();
      result.controlCancellations = body.controlCancellations.map((entry): PendingComputerControlCancellation => {
        if (!object(entry) || !id(entry.id) || !id(entry.desktopId) || !Array.isArray(entry.pendingEventIds) || !entry.pendingEventIds.every(id)) return invalid();
        return { id: entry.id, actor: parseComputerActor(entry.actor), desktopId: entry.desktopId, pendingEventIds: entry.pendingEventIds };
      });
    }
    if (body.physicalControl != null) {
      const value = body.physicalControl;
      if (!object(value) || !object(value.owner) || !id(value.owner.hostId) || !id(value.owner.controlEpoch)
        || !id(value.owner.inputOwnerId) || !id(value.since) || !object(value.holder)) return invalid();
      const holder = value.holder;
      let parsed: ComputerPhysicalControl['holder'];
      if (holder.kind === 'assignment' && id(holder.assignmentId) && (holder.origin === undefined || id(holder.origin))) {
        parsed = { kind: 'assignment', assignmentId: holder.assignmentId, actor: parseComputerActor(holder.actor), ...(holder.origin === undefined ? {} : { origin: holder.origin }) };
      } else if (holder.kind === 'human' && id(holder.holderId)) parsed = { kind: 'human', holderId: holder.holderId };
      else return invalid();
      result.physicalControl = { owner: { hostId: value.owner.hostId, controlEpoch: value.owner.controlEpoch, inputOwnerId: value.owner.inputOwnerId }, holder: parsed, since: value.since };
    }
    return result;
  } catch (error) { if (error instanceof HarnessServiceError) throw error; return invalid(); }
}
