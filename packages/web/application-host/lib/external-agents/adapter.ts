import type {
  ExternalAgentCapabilities,
  ExternalInput,
  ExternalInteraction,
  ExternalInteractionResponse,
  ExternalItem,
  ExternalTurn,
} from '@varin/application-client';

export interface HarnessInput extends Omit<ExternalInput, 'attachments'> {
  /** Host-prepared immutable paths. Never accepted from public input. */
  files?: Array<{ attachment: import('@varin/protocol').Attachment; path: string }>;
}

export interface HarnessSink {
  /** Durably record delivery intent after configuration succeeds and before sending input. */
  beforeDispatch?(): Promise<void>;
  started?(nativeId: string): void;
  item(item: Omit<ExternalItem, 'turnId'>): void;
  interaction(
    request: Omit<ExternalInteraction, 'turnId'>,
    signal?: AbortSignal,
  ): Promise<ExternalInteractionResponse>;
  usage(usage: NonNullable<ExternalTurn['usage']>): void;
}
export interface HarnessConnection {
  sessionId: string;
  capabilities: ExternalAgentCapabilities;
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
  stop(): Promise<void>;
  close(): Promise<void>;
}
