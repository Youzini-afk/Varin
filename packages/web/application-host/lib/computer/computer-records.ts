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
export interface ComputerInterrupted { id: string; actor: ComputerActor; holderId?: string }
export interface PendingComputerHandback { id: string; desktopId: string; label: string; at: string; actor: ComputerActor }
export interface ComputerRuntimeRecord {
  usage?: NonNullable<ComputerDesktop['usage']>;
  work?: ComputerWorkAssociation[];
  interrupted?: ComputerInterrupted;
  handbackEvents: PendingComputerHandback[];
  physicalControl?: ComputerPhysicalControl;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const invalid = (): never => { throw new ComputerError('computer-runtime-record-invalid', 'Desktop control metadata is malformed; input remains fenced'); };

export function decodeComputerRuntime(body: Record<string, unknown>): ComputerRuntimeRecord {
  const nonempty = (value: unknown) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
  if (body.runtimeVersion !== 3 && ['usage', 'work', 'interrupted', 'handbackEvents', 'physicalControl'].some(key => nonempty(body[key]))) {
    throw new ComputerError('computer-runtime-format-unsupported', 'This desktop has an obsolete internal work/control record; stop its original physical session before resetting its runtime metadata');
  }
  if (body.runtimeVersion !== undefined && body.runtimeVersion !== 3) return invalid();
  try {
    const result: ComputerRuntimeRecord = { handbackEvents: [] };
    if (body.usage != null) {
      if (!object(body.usage) || !id(body.usage.at)) return invalid();
      result.usage = { execution: parseComputerExecutionRef(body.usage.execution), at: body.usage.at };
    }
    if (body.work != null) {
      if (!Array.isArray(body.work)) return invalid();
      result.work = body.work.map((entry): ComputerWorkAssociation => {
        if (!object(entry) || !id(entry.at)) return invalid();
        const work = parseComputerWorkRef(entry.work);
        if (work.runtime === 'agent') {
          if (entry.registry !== null) return invalid();
          return { work, registry: null, at: entry.at };
        }
        if (!object(entry.registry) || !id(entry.registry.scopeId) || !id(entry.registry.threadId)) return invalid();
        return { work, registry: { scopeId: entry.registry.scopeId, threadId: entry.registry.threadId }, at: entry.at };
      });
    }
    if (body.interrupted != null) {
      const value = body.interrupted;
      if (!object(value) || !id(value.id) || value.holderId !== undefined && !id(value.holderId)) return invalid();
      result.interrupted = { id: value.id, actor: parseComputerActor(value.actor), ...(value.holderId === undefined ? {} : { holderId: value.holderId }) };
    }
    if (body.handbackEvents != null) {
      if (!Array.isArray(body.handbackEvents)) return invalid();
      result.handbackEvents = body.handbackEvents.map((entry): PendingComputerHandback => {
        if (!object(entry) || !id(entry.id) || !id(entry.desktopId) || !id(entry.label) || !id(entry.at)) return invalid();
        return { id: entry.id, desktopId: entry.desktopId, label: entry.label, at: entry.at, actor: parseComputerActor(entry.actor) };
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
