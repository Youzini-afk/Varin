import type { ComputerArtifact, ComputerDesktop, MemorySourceExcerpt, Run, ThreadSummary } from "@varin/protocol";
import type { ThreadIdentity } from './threads.js';

/** Durable Bot catalog contracts shared by the Application Host, routes, and UI (BC0). */

export interface BotModelSelection {
  providerId: string;
  modelId: string;
}

interface BotSleepProgress {
  resume: boolean;
  stopped: boolean;
  resumed: boolean;
}
export interface BotSleepWork extends BotSleepProgress {
  runtime: 'agent';
  threadId: string;
  branchId: string;
  runId: string;
}

/** A Bot entry is a stable native Thread and branch allocated with its profile. */
export type BotEntry = ThreadIdentity;
export type BotReadyEntry = ThreadIdentity;
export interface BotEntryResult { bot: BotSummary; entry: BotReadyEntry; model: BotModelSelection | null }
export interface BotCreateInput { name?: string; instructions?: string; model?: BotModelSelection }
export interface BotUpdateInput { name?: string; instructions?: string | null; model?: BotModelSelection | null; pinned?: boolean }

export interface BotSleepMachine {
  machineId: string;
  label: string;
  state: "pending" | "stopping" | "stopped" | "starting" | "ready" | "kept-running";
  detail?: string | undefined;
}

/** Durable intent and progress. A failed stop continues to block execution. */
export interface BotActivity {
  state: "awake" | "sleeping" | "asleep" | "waking" | "sleep-failed" | "wake-failed";
  operationId: string;
  planned: boolean;
  machinesPlanned?: boolean;
  readyToResume?: boolean;
  wakeAttempt?: number;
  work: BotSleepWork[];
  machines: BotSleepMachine[];
  error: string | null;
  execution?: {
    currentKernelWorkersDrained: boolean;
    unprovenOperationStopIds: string[];
    unknownEffectOperationIds: string[];
    unresolvedModelRequestIds: string[];
  };
}

export interface BotProfile {
  id: string;
  name: string;
  /** Persona/collaboration guidance owned by the user-facing Bot record. */
  instructions: string | null;
  /** Preferred model; null follows the configured default. */
  model: BotModelSelection | null;
  /** The Application Host that coordinates this Bot's lifecycle. */
  coordinatorHostId: string;
  /** Durable per-Bot working directory for the entry work's cwd. */
  homeDir: string;
  /** Stable entry identities are allocated with this record; ensureEntry materializes them. */
  entry: BotEntry;
  pinnedAt?: string | null;
  activity?: BotActivity;
  archiveRequested?: boolean;
  /** Durable deletion intent; a failed cleanup stays blocked and retryable. */
  deletion?: { operationId: string; error: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface BotSummary extends BotProfile {
  archived: boolean;
}

/** One native Thread branch in the Bot's owner scope. */
export interface BotWorkItem {
  desktops?: ComputerDesktop[];
  artifacts?: ComputerArtifact[];
  runtime: 'agent';
  identity: ThreadIdentity;
  thread: ThreadSummary;
  activeRun: Run | null;
  purpose: 'bot-root' | 'work';
}

export interface BotMemoryItem {
  id: number;
  content: string;
  trigger: string;
  createdAt: number;
  revision: string;
  sourceKind: string | null;
}

/** Framework-neutral product boundary. All navigation uses the returned tagged identity. */
export interface BotsAPI {
  selection: import("./chat-memory.js").ThreadMemoryAPI;
  list(signal?: AbortSignal): Promise<BotSummary[]>;
  get(botId: string, signal?: AbortSignal): Promise<BotSummary | null>;
  create(input?: BotCreateInput): Promise<BotSummary>;
  update(botId: string, patch: BotUpdateInput): Promise<BotSummary>;
  archive(botId: string): Promise<BotSummary>;
  remove(botId: string): Promise<BotSummary | null>;
  changeState(botId: string, action: 'sleep' | 'wake' | 'restore' | 'retry'): Promise<BotSummary>;
  entry(botId: string, signal?: AbortSignal): Promise<BotEntryResult>;
  work(botId: string, signal?: AbortSignal): Promise<BotWorkItem[]>;
  memory: {
    list(botId: string, signal?: AbortSignal): Promise<BotMemoryItem[]>;
    source(botId: string, id: number, signal?: AbortSignal): Promise<MemorySourceExcerpt[]>;
    update(botId: string, item: BotMemoryItem, action: 'correct' | 'forget', content?: string): Promise<void>;
  };
}
