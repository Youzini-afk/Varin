import type {
  ExternalAgentCapabilities,
  ExternalContextUsage,
  ExternalInput,
  ExternalInteraction,
  ExternalInteractionResponse,
  ExternalItem,
  ExternalTurn,
  ExternalTurnExecution,
} from '@varin/application-client';

export interface HarnessInput extends Omit<ExternalInput, 'attachments'> {
  /** Host-prepared immutable paths. Never accepted from public input. */
  files?: Array<{ attachment: import('@varin/protocol').Attachment; path: string }>;
}

/** A native acknowledgement, never a claim that the model has read the input. */
export interface HarnessSteeringReceipt {
  inputId: string;
  disposition: 'appended' | 'queued' | 'handled';
  nativeId?: string;
}
export interface HarnessSteeringOptions {
  inputId: string;
  expectedNativeId?: string;
  /** Must commit the dispatch intent before a native effect is possible. */
  beforeDispatch(nativeId?: string): Promise<void>;
}
/** Only this explicit negative receipt is safe to retry as a different delivery. */
export class HarnessSteeringRejected extends Error {
  constructor(message: string) { super(message); this.name = 'HarnessSteeringRejected'; }
}
export function assertSteeringContent(input: HarnessInput) {
  if (input.model !== undefined || input.thinking !== undefined || input.mode !== undefined ||
      Object.keys(input.config ?? {}).length)
    throw new HarnessSteeringRejected('Current-turn supplements cannot change model, thinking, mode or configuration; send those options with the next turn');
}

export interface HarnessSink {
  /** Durably record delivery intent after configuration succeeds and before sending input. */
  beforeDispatch?(): Promise<void>;
  started?(nativeId: string): void;
  execution?(value: ExternalTurnExecution): void;
  item(item: Omit<ExternalItem, 'turnId'>): void;
  interaction(
    request: Omit<ExternalInteraction, 'turnId'>,
    signal?: AbortSignal,
  ): Promise<ExternalInteractionResponse>;
  usage(usage: NonNullable<ExternalTurn['usage']>): void;
}

export function describeTurnExecution(
  capabilities: ExternalAgentCapabilities,
  { model, thinking }: NonNullable<ExternalAgentCapabilities['current']> = capabilities.current ?? {},
): ExternalTurnExecution {
  const modelName = model && capabilities.models.find(entry => entry.id === model)?.name;
  const thinkingName = thinking && capabilities.configOptions?.find(option => option.category === 'thought_level')
    ?.options.find(option => option.value === thinking)?.name;
  return {
    ...(model ? { model } : {}),
    ...(modelName && modelName !== model ? { modelName } : {}),
    ...(thinking ? { thinking } : {}),
    ...(thinkingName && thinkingName !== thinking ? { thinkingName } : {}),
  };
}
export interface HarnessConnection {
  sessionId: string;
  capabilities: ExternalAgentCapabilities;
  /** Native protocol occupancy, never billing counters or guessed model limits. */
  readonly contextUsage?: ExternalContextUsage | undefined;
  onContextUsage?(listener: (usage: ExternalContextUsage | undefined) => void): () => void;
  /** Native work may outlive the admitted turn. Unknown tasks are never inferred. */
  readonly backgroundTasks?: number;
  onActivity?(listener: () => void): () => void;
  readonly failure?: Error | undefined;
  onFailure?(listener: (error: Error) => void): () => void;
  onCapabilities?(listener: () => void): () => void;
  /** Refresh metadata only; must not restart the session or dispatch input. */
  refreshCapabilities?(): Promise<void>;
  prompt(
    input: HarnessInput,
    sink: HarnessSink,
  ): Promise<{
    status: 'completed' | 'failed' | 'cancelled';
    error?: string | undefined;
    nativeId?: string | undefined;
  }>;
  /** Optional until the native protocol can safely append to the owned execution. */
  steer?(input: HarnessInput, options: HarnessSteeringOptions): Promise<HarnessSteeringReceipt>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
