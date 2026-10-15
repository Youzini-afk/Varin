import type { InferenceExecutor, InferenceUsage } from '../../kernel/protocol.generated.js';

/** A physical worker settlement, independent of whether its observer still waits. */
export interface LocalEmbeddingSettlement {
  requestStarted: boolean | null;
  completed: boolean;
  usage: InferenceUsage;
  usageBasis?: 'untruncated-tokenizer-estimate';
  vectors?: number[][];
  error?: string;
  cancelled?: boolean;
}
export interface LocalEmbeddingExecution {
  readonly identity: Extract<InferenceExecutor, { kind: 'local_component' }>;
  /** Always resolves after worker acknowledgement or real worker exit, never just abort. */
  batch(texts: readonly string[], input: {
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
    priority: 'foreground' | 'background';
    tokenLengths?: readonly number[];
  }): Promise<LocalEmbeddingSettlement>;
}
