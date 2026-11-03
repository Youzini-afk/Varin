import type { AgentMemoryScope } from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';

/** A user-selected immutable history cut. Ranges are inclusive. */
export interface ThreadExportSelection extends ThreadIdentity {
  headId: string | null;
  firstItemId?: string;
  lastItemId?: string;
  format: 'markdown' | 'json';
  includeTools: boolean;
  includeAttachments: boolean;
}
export type ThreadMemoryDestination = { kind: 'bot'; id: string } | { kind: 'user' } | AgentMemoryScope;
export interface ThreadRememberScope { destination: ThreadMemoryDestination; revision: string | number }
export interface ThreadRememberInput extends ThreadIdentity {
  key: string;
  destination: ThreadMemoryDestination;
  revision: string | number;
  content: string;
  trigger?: string;
}
export interface ThreadRememberReceipt {
  id: number;
  destination: ThreadMemoryDestination;
  content: string;
  created: boolean;
}
export interface ThreadWorkflowsAPI {
  /** Streams the original owner's export into caller-provided local storage, never a JSON aggregate. */
  export(selection: ThreadExportSelection, destination: WritableStream<Uint8Array>, signal?: AbortSignal): Promise<void>;
  memoryScopes(identity: ThreadIdentity, signal?: AbortSignal): Promise<ThreadRememberScope[]>;
  remember(input: ThreadRememberInput): Promise<ThreadRememberReceipt>;
}
