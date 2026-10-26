import type {
  ExternalAgentCapabilities,
  ExternalInput,
  ExternalInteraction,
  ExternalItem,
  ExternalTurn,
} from '@varin/application-client';

export interface HarnessSink {
  started?(nativeId: string): void;
  item(item: Omit<ExternalItem, 'turnId'>): void;
  interaction(
    request: Omit<ExternalInteraction, 'turnId'>,
  ): Promise<{ optionId?: string; answers?: Record<string, string[]>; text?: string }>;
  usage(usage: NonNullable<ExternalTurn['usage']>): void;
}
export interface HarnessConnection {
  sessionId: string;
  capabilities: ExternalAgentCapabilities;
  prompt(
    input: ExternalInput,
    sink: HarnessSink,
  ): Promise<{
    status: 'completed' | 'failed' | 'cancelled';
    error?: string | undefined;
    nativeId?: string | undefined;
  }>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
