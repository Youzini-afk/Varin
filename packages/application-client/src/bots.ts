import type { ComputerArtifact, ComputerDesktop, Thread, ThreadRun } from "@varin/protocol";

/** Durable Bot catalog contracts shared by the Application Host, routes, and UI (BC0). */

export interface BotModelSelection {
  providerId: string;
  modelId: string;
}

export interface BotSleepWork {
  threadId: string;
  sessionId: string | null;
  runId: string | null;
  resume: boolean;
  stopped: boolean;
  resumed: boolean;
}

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
}

export interface BotProfile {
  id: string;
  name: string;
  /** Persona/collaboration guidance owned by the user-facing Bot record. */
  instructions: string | null;
  /** Preferred model for the Bot's entry; null follows Pi's fresh-session model selection. */
  model: BotModelSelection | null;
  /** The Application Host that coordinates this Bot's lifecycle. */
  coordinatorHostId: string;
  /** Durable per-Bot working directory for the entry session's cwd. */
  homeDir: string;
  /** The Bot's long-lived conversation session; survives entry reopen. */
  entrySessionId: string | null;
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

/**
 * One work item in a Bot's owner scope. `sessionId` is the session of the
 * latest recorded Run, when one exists — the navigation target for the work.
 */
export interface BotWorkItem {
  thread: Thread;
  activeRun: ThreadRun | null;
  sessionId: string | null;
  desktops?: ComputerDesktop[];
  artifacts?: ComputerArtifact[];
}

export interface BotMemoryItem {
  id: number;
  content: string;
  trigger: string;
  createdAt: number;
  revision: string;
  sourceKind: string | null;
}
