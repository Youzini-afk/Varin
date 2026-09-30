/**
 * Follow-up registrations: durable wait intent + continuation contract (D-307).
 *
 * A follow-up binds a *source* (what to wait for) to a continuation *instruction*
 * (what the agent should do when it fires) on the originating session/thread.
 * The host owns observation and delivery — agents register intent; programs watch
 * the source; the original thread is resumed through the normal Thread/Run
 * lifecycle when the condition holds.
 */
import type { JsonValue } from "./types.js";

/** What the program watches. Field sets are per-kind; no arbitrary script conditions. */
export type FollowUpLeafSource =
  | {
      kind: "time";
      /** Absolute due time (epoch ms), resolved at registration. */
      at: number;
      /** Original timezone intent for display (IANA name); `at` stays authoritative. */
      timezone?: string;
    }
  | {
      kind: "experiment";
      /** Durable attempt identity returned by experiment.submit. */
      attemptId: string;
      /** Terminal-ish states that satisfy the wait; default = any terminal. */
      states?: string[];
      /**
       * Optional deadline backstop: fires a "deadline" occurrence while the
       * attempt is still running without cancelling the terminal wait.
       */
      fallbackAt?: number;
    }
  | {
      /** Watches collected artifacts of a durable experiment attempt. */
      kind: "artifact";
      attemptId: string;
      /** Bind one durable artifact identity; omit with `name` to watch the set. */
      artifactId?: string;
      /** Bind by artifact name/path within the attempt. */
      name?: string;
      /**
       * true: fire once per artifact as it reaches available — the wait
       * re-arms after delivery. Default: fire once when the bound artifact
       * (or the collected set, when unbound) is ready, when collection
       * fails, or when the attempt ends without the artifact.
       */
      every?: boolean;
      fallbackAt?: number;
    }
  | {
      /** Watches a workspace path through the document authority. */
      kind: "file";
      /** Workspace-relative path (forward slashes). */
      path: string;
      /**
       * exists  — first durable observation that the path is present.
       * changed — each durable change after registration.
       * ready   — the path exists AND the document authority reports no
       *           active writer/capture on the workspace (writer evidence).
       */
      condition: "exists" | "changed" | "ready";
      fallbackAt?: number;
    }
  | {
      /** Incremental match against an attempt's durable log artifact. */
      kind: "log";
      attemptId: string;
      stream?: "stdout" | "stderr";
      /** Literal text; with `regex: true` a JavaScript RegExp. */
      pattern: string;
      regex?: boolean;
      /** true: fire per new match; default fires on the first match only. */
      every?: boolean;
      fallbackAt?: number;
    }
  | {
      /** Crossing of a structured usage metric on a registered machine. */
      kind: "metric";
      machineId: string;
      /** Structured key: cpuPercent, memoryMb, or gpu:<index>.percent. */
      metric: string;
      predicate: "above" | "below";
      threshold: number;
      /** true: re-arm and fire on each subsequent crossing. */
      every?: boolean;
      fallbackAt?: number;
    }
  | {
      /** Typed external source via a registered, authorized adapter. */
      kind: "external";
      /** Registered adapter id — currently only "github-pr". */
      provider: "github-pr";
      /** Repository branch; defaults to the caller workspace's branch. */
      branch?: string;
      /** Remote name override for github-pr. */
      remote?: string;
      condition: "exists" | "open" | "merged" | "closed";
      fallbackAt?: number;
    }
  | {
      /** Fires only through an explicit followup.check or host-side event. */
      kind: "manual";
      /** Free-form source description kept for the audit trail. */
      note?: string;
    }
  | {
      /**
       * Watches a computer desktop through the catalog — local, managed or
       * remote mirror (execution-environment §8.3). The Host polls the real
       * state; `observedAt` facts keep provenance of each check.
       */
      kind: "desktop";
      /** Catalog desktop id (local-console, managed-linux, remote:r*:…). */
      desktopId: string;
      /**
       * status   — the desktop's catalog status becomes one of `states`.
       * artifact — a file in the managed desktop user's home exists, or its
       *            stored revision differs from `sha256`.
       */
      condition: "status" | "artifact";
      /** status only: the statuses that satisfy the wait. */
      states?: string[];
      /** artifact only: path relative to the managed desktop user's home. */
      path?: string;
      /** artifact only: fire when the stored revision differs from this revision. */
      sha256?: string;
      /** status: fire on each new matching state; artifact: fire on each new revision. */
      every?: boolean;
      fallbackAt?: number;
    }
  | {
      /** Watches an ordinary Harness shell execution owned by this session. */
      kind: "shell";
      /** Stable execution identity returned by bash/powershell. */
      executionId: string;
      /**
       * exit   — the command reaches a confirmed terminal state.
       * output — newly committed output matches `pattern`.
       * status — one of `states` is durably observed.
       */
      condition: "exit" | "output" | "status";
      pattern?: string;
      regex?: boolean;
      states?: Array<"running" | "completed" | "failed" | "cancelled" | "unavailable">;
      /** output only: fire for each later committed match. */
      every?: boolean;
      fallbackAt?: number;
    };

/**
 * Composite sources keep the tool input declarative: an agent supplies ordinary
 * sources and chooses whether the first (`any`) or every (`all`) source must
 * signal. A composite is one-shot by default. With `every`, only leaves that
 * naturally emit repeatable edges can participate in later cycles.
 */
export type FollowUpSource = FollowUpLeafSource | {
  kind: "any" | "all";
  sources: FollowUpLeafSource[];
  every?: boolean;
  fallbackAt?: number;
};

export type FollowUpStatus =
  /** Registered and observing the source. */
  | "waiting"
  /** An occurrence fired; delivery to the target is in progress. */
  | "triggered"
  /** The latest occurrence reached the target (or the source is a one-shot). */
  | "delivered"
  | "cancelled"
  /** Replaced by a newer definition revision (update creates a successor). */
  | "superseded"
  /** The source can no longer be observed (lost shell, missing attempt). */
  | "unavailable";

export interface FollowUpDefinitionView {
  id: string;
  workspaceId: string;
  /** Present when the target is a thread; absent targets the session itself. */
  threadId?: string;
  sessionId: string;
  instruction: string;
  source: FollowUpSource;
  status: FollowUpStatus;
  /** Content revision for CAS updates/cancel. */
  revision: string;
  /** Registering run when known. */
  runId?: string;
  /** The agent explicitly paused the goal/run for this wait. */
  pausedGoal: boolean;
  createdAt: number;
  updatedAt: number;
  /** Latest occurrence summary, when any. */
  lastOccurrence?: {
    id: string;
    reason: string;
    at: number;
    delivered: boolean;
  };
  /** Human-facing summary of what is being awaited (i18n-free text). */
  waitingSummary: string;
}

export type FollowUpOccurrenceDelivery =
  /** Injected into the active run's next request (inform). */
  | "active-inform"
  /** Resumed the settled thread through normal admission (new run). */
  | "continued"
  /** Parked behind the execution budget; will continue on dequeue. */
  | "parked"
  /** Recorded but not delivered — target gone/cancelled. */
  | "dropped";

export interface FollowUpOccurrenceView {
  id: string;
  followUpId: string;
  reason: string;
  facts: Record<string, JsonValue>;
  delivery: FollowUpOccurrenceDelivery;
  runId?: string;
  at: number;
}

export interface FollowUpRegisterParams {
  source: FollowUpSource;
  /** What the agent should do when the source fires — natural language. */
  instruction: string;
  /**
   * Explicit pause: end the current turn and yield the model slot until the
   * source fires. Suppresses goal auto-continue. Without pause the agent keeps
   * working and the trigger lands as an inform while it runs.
   */
  pause?: boolean;
}

export interface FollowUpRegisterResult {
  followUp: FollowUpDefinitionView;
  /** True when the source was already satisfied at registration — an occurrence was fired synchronously. */
  firedImmediately: boolean;
}

export interface FollowUpListParams {
  /** Default false — include cancelled/superseded/delivered history. */
  includeInactive?: boolean;
}

export interface FollowUpListResult {
  followUps: FollowUpDefinitionView[];
}

export interface FollowUpGetParams {
  id: string;
}

export interface FollowUpGetResult {
  followUp: FollowUpDefinitionView;
  occurrences: FollowUpOccurrenceView[];
}

export interface FollowUpUpdateParams {
  id: string;
  expectedRevision?: string;
  instruction?: string;
  /** Replace the source (e.g. move a deadline); takes effect at this revision. */
  source?: FollowUpSource;
}

export interface FollowUpCancelParams {
  id: string;
  expectedRevision?: string;
}

export interface FollowUpCheckParams {
  id: string;
}

export interface FollowUpCheckResult {
  followUp: FollowUpDefinitionView;
  /** True when the check observed a satisfied condition and fired. */
  fired: boolean;
  /** What the program observed during this check (compact facts). */
  observed?: Record<string, JsonValue>;
}

/** Explicit "invoke the agent now" — separate from a program check (D-307 §8). */
export interface FollowUpFireParams {
  id: string;
  expectedRevision?: string;
  /** Reason recorded on the forced occurrence. */
  reason?: string;
}

export interface FollowUpUpdateResult {
  followUp: FollowUpDefinitionView;
}
