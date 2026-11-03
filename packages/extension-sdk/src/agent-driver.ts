import {
  parseVarinAgentDriverDescription, parseVarinAgentDriverRunInput, parseVarinAgentDriverRunOutcome,
  VARIN_AGENT_DRIVER_CAPABILITY, VARIN_AGENT_DRIVER_CONTRACT,
  VARIN_AGENT_DRIVER_SERVICE,
  type DriverCheckpoint, type DriverCheckpointInput, type DriverDeliveryInput, type DriverDeliveryReceipt,
  type DriverContextReceipt, type DriverCancelInput, type DriverCancelReceipt,
  type DriverWaitInput, type DriverWaitReceipt,
  type DriverModelInput, type DriverModelReceipt, type DriverReceipt, type DriverReceiptInput,
  type DriverRunInput, type DriverRunOutcome, type DriverToolInput, type DriverToolReceipt,
  type JsonValue, type VarinAgentDriverDescription,
} from '@varin/extension-contract';
import type { VarinBrokeredHostContext } from './index.js';

export {
  VARIN_AGENT_DRIVER_CAPABILITY, VARIN_AGENT_DRIVER_CONTRACT, VARIN_AGENT_DRIVER_SERVICE,
  VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_AGENT_DRIVER_VERSION,
} from '@varin/extension-contract';
export type {
  DriverCheckpoint, DriverCheckpointInput, DriverDeliveryInput, DriverDeliveryReceipt,
  DriverContextInput, DriverContextReceipt, DriverCancelInput, DriverCancelReceipt,
  DriverWaitInput, DriverWaitReceipt,
  DriverModelInput, DriverModelReceipt, DriverReceipt, DriverReceiptInput, DriverRunInput,
  DriverRunOutcome, DriverToolInput, DriverToolReceipt, VarinAgentDriverDescription,
} from '@varin/extension-contract';

export interface VarinAgentDriverContext {
  /** Stop intent only. A rejected observation does not prove that model/tool work has stopped. */
  readonly signal: AbortSignal;
  /** These methods share this invocation's original Run authority, not an extension-global Run. */
  readonly driver: {
    model(input: DriverModelInput): Promise<DriverModelReceipt>;
    tool(input: DriverToolInput): Promise<DriverToolReceipt>;
    /** Consume available original Inbox entries and compile fresh context. This does not wait for future input. */
    context(): Promise<DriverContextReceipt>;
    /** Read a baseline or await any original Run activity. work selects receipt snapshots, not wake filtering. */
    wait(input: DriverWaitInput): Promise<DriverWaitReceipt>;
    /** Request cancellation of this instance's work. requested is intent, not proof of executor stop. */
    cancel(input: DriverCancelInput): Promise<DriverCancelReceipt>;
    checkpoint(input: DriverCheckpointInput): Promise<DriverCheckpoint>;
    deliver(input: DriverDeliveryInput): Promise<DriverDeliveryReceipt>;
    receipt(input: DriverReceiptInput): Promise<DriverReceipt | null>;
  };
}
type DriverAlgorithm = (input: Readonly<DriverRunInput>, context: VarinAgentDriverContext,
  configuration: JsonValue) => DriverRunOutcome | Promise<DriverRunOutcome>;
type DriverDescription = Omit<VarinAgentDriverDescription, 'recovery' | 'checkpointSchema'>;
export type VarinAgentDriverImplementation = DriverDescription & { run: DriverAlgorithm } & (
  | { recovery: 'none'; checkpointSchema: null; resume?: never }
  | { recovery: 'checkpoint'; checkpointSchema: string; resume: DriverAlgorithm }
);

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Register an actual algorithm, not a policy action interpreter. Wire DTO validation belongs to
 * the original native owner. The SDK detaches data and binds primitive calls to this service call;
 * neither runId/epoch in the read-only input nor caller-supplied JSON can create authority. */
export function provideAgentDriver(context: VarinBrokeredHostContext, implementation: VarinAgentDriverImplementation): void {
  const description = freeze(parseVarinAgentDriverDescription({ identity: implementation.identity,
    configuration: implementation.configuration, modelRoles: implementation.modelRoles,
    recovery: implementation.recovery, checkpointSchema: implementation.checkpointSchema }));
  if (description.recovery === 'checkpoint' && typeof implementation.resume !== 'function') {
    throw new Error('Checkpoint driver must implement resume explicitly');
  }
  context.services.provide({ ...VARIN_AGENT_DRIVER_SERVICE }, {
    inspect(args) {
      if (args.length) throw new Error('Driver inspect takes no arguments');
      return structuredClone(VARIN_AGENT_DRIVER_CONTRACT) as unknown as JsonValue;
    },
    describe(args) {
      if (args.length) throw new Error('Driver describe takes no arguments');
      return structuredClone(description) as unknown as JsonValue;
    },
    async run(args, call) {
      if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) {
        throw new Error('Driver run takes one native Run input');
      }
      const input = freeze(parseVarinAgentDriverRunInput(args[0]));
      if (input.mode === 'resume' && (description.recovery !== 'checkpoint' || !input.checkpoint
        || input.checkpoint.schema !== description.checkpointSchema)) {
        throw new Error('Driver cannot resume this checkpoint; starting again is not recovery');
      }
      call.signal.throwIfAborted();
      let open = true;
      const invoke = async <T>(method: string, request: object): Promise<T> => {
        if (!open) throw new Error('Driver invocation has completed');
        call.signal.throwIfAborted();
        // No post-await abort check: an original effect receipt remains evidence after stop intent.
        return await call.capabilities.call(VARIN_AGENT_DRIVER_CAPABILITY, method,
          structuredClone(request) as unknown as JsonValue) as T;
      };
      const driver = driverClient(invoke, description.checkpointSchema);
      try {
        const algorithm = input.mode === 'resume' ? implementation.resume! : implementation.run;
        return parseVarinAgentDriverRunOutcome(await algorithm(input,
          Object.freeze({ signal: call.signal, driver }), description.configuration)) as unknown as JsonValue;
      } finally { open = false; }
    },
  });
}

function driverClient(invoke: <T>(method: string, request: object) => Promise<T>, schema: string | null): VarinAgentDriverContext['driver'] {
  return Object.freeze({
    model: (request: DriverModelInput) => invoke<DriverModelReceipt>('model', request),
    tool: (request: DriverToolInput) => invoke<DriverToolReceipt>('tool', request),
    context: () => invoke<DriverContextReceipt>('context', {}),
    wait: (request: DriverWaitInput) => invoke<DriverWaitReceipt>('wait', request),
    cancel: (request: DriverCancelInput) => invoke<DriverCancelReceipt>('cancel', request),
    async checkpoint(request: DriverCheckpointInput) {
      if (schema === null || request.schema !== schema) throw new Error('Checkpoint schema is not declared by this driver');
      return invoke<DriverCheckpoint>('checkpoint', request);
    },
    deliver: (request: DriverDeliveryInput) => invoke<DriverDeliveryReceipt>('deliver', request),
    receipt: (request: DriverReceiptInput) => invoke<DriverReceipt | null>('receipt', request),
  });
}
