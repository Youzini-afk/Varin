/** Committed Run metadata only. No transcript, provider request, credentials or tool contents. */
export const VARIN_RUN_ACTIVITY_SERVICE_ID = 'varin.run.activity';
export const VARIN_RUN_ACTIVITY_VERSION = 1 as const;
export const VARIN_RUN_ACTIVITY_KINDS = ['run.accepted', 'run.changed', 'run.cancel_requested'] as const;
export const VARIN_RUN_ACTIVITY_STATES = ['accepted', 'preparing', 'runnable', 'generating', 'executing', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export interface VarinRunActivityFact {
  readonly cursor: number;
  readonly subject: string;
  readonly revision: number;
  readonly kind: typeof VARIN_RUN_ACTIVITY_KINDS[number];
  readonly data: Readonly<{ state: typeof VARIN_RUN_ACTIVITY_STATES[number] | null }>;
}
export interface VarinRunActivityDelivery {
  /** Stable across worker/Host restarts and ordinary provider updates. */
  readonly subscriptionId: string;
  readonly threadId: string;
  /** Exact invocation identity, distinct from the stable deduplication key. */
  readonly deliveryId: string;
  readonly fact: VarinRunActivityFact;
}
export interface VarinRunActivityAcknowledgement {
  subscriptionId: string;
  deliveryId: string;
  cursor: number;
}
const identitySchema = { type: 'string', minLength: 1 } as const;
const cursorSchema = { type: 'integer', minimum: 1 } as const;
export const VARIN_RUN_ACTIVITY_DELIVERY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subscriptionId', 'threadId', 'deliveryId', 'fact'],
  properties: {
    subscriptionId: identitySchema, threadId: identitySchema, deliveryId: identitySchema,
    fact: { type: 'object', additionalProperties: false, required: ['cursor', 'subject', 'revision', 'kind', 'data'],
      properties: { cursor: cursorSchema, subject: identitySchema, revision: cursorSchema,
        kind: { enum: VARIN_RUN_ACTIVITY_KINDS },
        data: { type: 'object', additionalProperties: false, required: ['state'],
          properties: { state: { enum: [...VARIN_RUN_ACTIVITY_STATES, null] } } },
      } },
  },
} as const;
export const VARIN_RUN_ACTIVITY_ACKNOWLEDGEMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subscriptionId', 'deliveryId', 'cursor'],
  properties: { subscriptionId: identitySchema, deliveryId: identitySchema, cursor: cursorSchema },
} as const;
export const VARIN_RUN_ACTIVITY_CONTRACT = {
  id: VARIN_RUN_ACTIVITY_SERVICE_ID, version: VARIN_RUN_ACTIVITY_VERSION,
  participation: 'observer', delivery: 'at-least-once',
  methods: {
    observe: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: VARIN_RUN_ACTIVITY_DELIVERY_SCHEMA },
      outputSchema: VARIN_RUN_ACTIVITY_ACKNOWLEDGEMENT_SCHEMA },
    getSnapshot: { input: 'subscriptionId', output: '{ subscriptionId, cursor, projection } | null' },
    inspect: { input: 'none', output: 'contract' },
  },
  factKinds: VARIN_RUN_ACTIVITY_KINDS,
  deduplication: ['subscriptionId', 'fact.cursor'],
  effects: 'Projection only. Business work requires a new, authorized command with observer provenance and an idempotency key.',
} as const;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Run activity requires an object');
  return value as Record<string, unknown>;
};
const fields = (value: Record<string, unknown>, names: readonly string[]): void => {
  if (Object.keys(value).some(key => !names.includes(key))) throw new Error('Unknown Run activity field');
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Run activity identity must be nonempty');
  return value;
};
const number = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Run activity cursor/revision must be a positive safe integer');
  return Number(value);
};
export function parseVarinRunActivityDelivery(value: unknown): VarinRunActivityDelivery {
  const raw = record(value), fact = record(raw.fact), data = record(fact.data);
  fields(raw, ['subscriptionId', 'threadId', 'deliveryId', 'fact']);
  fields(fact, ['cursor', 'subject', 'revision', 'kind', 'data']);
  fields(data, ['state']);
  if (!VARIN_RUN_ACTIVITY_KINDS.includes(fact.kind as VarinRunActivityFact['kind'])
    || (data.state !== null && !VARIN_RUN_ACTIVITY_STATES.includes(data.state as NonNullable<VarinRunActivityFact['data']['state']>))) {
    throw new Error('Unsupported Run activity fact');
  }
  return Object.freeze({ subscriptionId: text(raw.subscriptionId), threadId: text(raw.threadId), deliveryId: text(raw.deliveryId),
    fact: Object.freeze({ cursor: number(fact.cursor), subject: text(fact.subject), revision: number(fact.revision),
      kind: fact.kind as VarinRunActivityFact['kind'], data: Object.freeze({ state: data.state as VarinRunActivityFact['data']['state'] }) }) });
}
export function parseVarinRunActivityAcknowledgement(value: unknown): VarinRunActivityAcknowledgement {
  const raw = record(value);
  fields(raw, ['subscriptionId', 'deliveryId', 'cursor']);
  return { subscriptionId: text(raw.subscriptionId), deliveryId: text(raw.deliveryId), cursor: number(raw.cursor) };
}
