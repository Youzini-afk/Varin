/**
 * Experiment execution and resource facts (7C/7D, D-300).
 *
 * Durable object graph kept in the Rust kernel typed catalog:
 *   research.source        — a registered research input (dataset, paper, code, artifact)
 *   experiment.spec        — a reusable pinned execution input
 *   experiment.attempt     — one real submission of a spec
 *   experiment.job         — the backend process/scheduler binding for an attempt
 *   experiment.artifact    — a collected output object
 *   resource.machine       — an execution target (local, ssh, cluster)
 *   resource.commitment    — a confirmed Varin reservation on a machine
 *   resource.sample        — the latest observed capacity/usage facts
 *
 * An Agent Run may manage many attempts; attempt lifecycles are independent of
 * Run lifecycles. Request ≠ commitment: admission is confirmed by the resource
 * owner before launch, and queued attempts hold no process.
 */

export type ExperimentAttemptState =
  | "submitted"
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export type ExperimentJobState =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "cancelled"
  | "unknown"
  | "released";

export type ExperimentArtifactState = "pending" | "available" | "failed" | "expired";

export type ExperimentBackend = "local" | string;

export interface ExperimentResourceRequest {
  cpuCores?: number;
  memoryMb?: number;
  gpuCount?: number;
  gpuMemoryMb?: number;
  /** Signals scheduling preference only; it is not a resource dimension. */
  longRunning?: boolean;
}

export interface ExperimentInputRef {
  /** A registered research.source record id. */
  sourceId?: string;
  /** A workspace-relative input path pinned at submit time. */
  path?: string;
  /** A content-addressed object already in the workspace store. */
  objectHash?: string;
  /** What this input is for, in the submitter's words. */
  role?: string;
}

export interface ExperimentSpecView {
  specId: string;
  title?: string;
  command: string;
  args: string[];
  cwd?: string;
  inputs: ExperimentInputRef[];
  resources?: ExperimentResourceRequest;
  outputPaths: string[];
  state: "active" | "retired";
  revision: number;
  createdAt: number;
}

export interface ExperimentAttemptView {
  attemptId: string;
  /** Null until the accepted intent has a durably prepared immutable spec. */
  specId: string | null;
  /** A requested stop is distinct from a confirmed terminal state. */
  cancelRequested: boolean;
  backend: ExperimentBackend;
  machineId?: string;
  state: ExperimentAttemptState;
  /** Collection is a separate fact from the run outcome. */
  collection: "none" | "pending" | "done" | "failed";
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  queueReason?: string;
  requestId?: string;
  /** Prior attempt whose unchanged spec was explicitly rerun. */
  retryOfAttemptId?: string;
  /** Actual attempt-private working tree on the selected execution target. */
  execution?: {
    rootId: string;
    canonicalRoot: string;
    cwd: string;
  };
  threadId?: string;
  runId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface ExperimentJobView {
  jobId: string;
  attemptId: string;
  backend: ExperimentBackend;
  machineId?: string;
  /** Backend-native identity: kernel process id, Slurm job id, … never a bare PID. */
  backendJobId?: string;
  kernelEpoch?: string;
  pid?: number;
  state: ExperimentJobState;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ExperimentArtifactView {
  artifactId: string;
  attemptId: string;
  name: string;
  kind: "stdout" | "stderr" | "file" | "object";
  state: ExperimentArtifactState;
  byteLength?: number;
  truncated?: boolean;
  objectHash?: string;
  /**
   * Durable content retained by the execution target instead of copied into
   * the coordinator's object store. The reference never contains connection
   * credentials; reads are routed through the recorded machine/backend.
   */
  remote?: {
    machineId: string;
    outputId: string;
    path: string;
    retainedBy: "execution-target";
    accessible: "available" | "unreachable" | "expired";
  };
  path?: string;
  collectedAt?: number;
  error?: string;
}

export interface ExperimentSubmitParams {
  /** Idempotent submission identity; a retry with the same id returns the recorded attempt. */
  requestId?: string;
  /** Explicit rerun provenance; the referenced attempt must use the same spec. */
  retryOfAttemptId?: string;
  title?: string;
  /** Reuse a previously recorded spec instead of pinning a new one. */
  specId?: string;
  command?: string;
  args?: string[];
  /** Absolute directory inside the admitted workspace root; defaults to the root. */
  cwd?: string;
  env?: Record<string, string>;
  inputs?: ExperimentInputRef[];
  resources?: ExperimentResourceRequest;
  /** Workspace-relative output paths collected after the job exits. */
  outputPaths?: string[];
  machineId?: string;
}

export interface ExperimentSubmitResult {
  spec: ExperimentSpecView | null;
  attempt: ExperimentAttemptView;
  text: string;
}

export interface ExperimentListParams {
  state?: ExperimentAttemptState;
  specId?: string;
  limit?: number;
}

export interface ExperimentListResult {
  attempts: ExperimentAttemptView[];
  text: string;
}

export interface ExperimentGetParams {
  attemptId: string;
}

export interface ExperimentGetResult {
  attempt: ExperimentAttemptView;
  spec?: ExperimentSpecView;
  job?: ExperimentJobView;
  artifacts: ExperimentArtifactView[];
}

export interface ExperimentLogsParams {
  attemptId: string;
  stream?: "stdout" | "stderr";
  /** Byte offset into the collected stream. */
  offset?: number;
  maxBytes?: number;
}

export interface ExperimentLogsResult {
  attemptId: string;
  stream: "stdout" | "stderr";
  offset: number;
  nextOffset: number;
  eof: boolean;
  text: string;
  /** Where the bytes came from: live backend buffer or the collected artifact. */
  origin: "live" | "artifact";
}

export interface ExperimentCancelParams {
  attemptId: string;
}

export interface ExperimentArtifactReadParams {
  attemptId: string;
  artifactId: string;
  offset?: number;
  maxBytes?: number;
}

export interface ExperimentArtifactReadResult {
  attemptId: string;
  artifactId: string;
  name: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  bytesBase64: string;
  /** Null for binary material; the same artifact remains downloadable in the UI. */
  text: string | null;
}

export interface ExperimentCancelResult {
  attempt: ExperimentAttemptView;
}

export interface ExperimentWaitParams {
  attemptId: string;
  timeoutMs?: number;
}

export interface ExperimentWaitResult {
  attempt: ExperimentAttemptView;
  timedOut: boolean;
}

export interface ExperimentCollectParams {
  attemptId: string;
}

export interface ExperimentCollectResult {
  attempt: ExperimentAttemptView;
  artifacts: ExperimentArtifactView[];
}

export interface ResourceGpuView {
  index: number;
  /** Stable NVIDIA UUID when the host exposes one. */
  uuid?: string;
  name?: string;
  memoryMb?: number;
  utilizationPercent?: number;
  usedMemoryMb?: number;
}

export interface ResourceCommitmentView {
  commitmentId: string;
  machineId: string;
  attemptId?: string;
  resources: ExperimentResourceRequest;
  /** Concrete target devices held by this commitment, when GPU resources were requested. */
  gpuAllocation?: {
    devices: Array<{
      index: number;
      uuid: string;
      name?: string;
      memoryMb?: number;
    }>;
    environment: {
      name: "CUDA_VISIBLE_DEVICES";
      value: string;
    };
  };
  state: "requested" | "confirmed" | "released" | "revoked" | "failed";
  confirmedAt?: number;
  releasedAt?: number;
}

export interface ResourceMachineView {
  machineId: string;
  kind: string;
  label?: string;
  state: "available" | "degraded" | "offline" | "retired";
  connection: {
    status: "connected" | "degraded" | "offline" | "unknown";
    checkedAt: number;
    detail?: string;
  };
  /** Result of the last host GPU inventory probe. */
  gpuProbe?: {
    status: "available" | "tool-missing" | "no-device" | "error";
    checkedAt: number;
    detail?: string;
  };
  /** Stable execution-target facts resolved from trusted connection management. */
  target?: {
    hostId: string;
    connectionId: string;
    source: "desktop-host" | "ssh-instance" | "configured-host";
    capabilities: string[];
    /** Host that owns placement/queue decisions for work not yet submitted. */
    coordinatorHostId?: string;
    /** Accepted jobs are supervised by this target Host after the client disconnects. */
    acceptedJobsSurviveClientDisconnect: boolean;
    /** Work still waiting for placement needs the named coordinator to remain running. */
    unassignedWorkRequiresCoordinator: boolean;
  };
  /** Total device capacity, last observed. */
  capacity?: {
    cpuCores?: number;
    memoryMb?: number;
    gpus?: ResourceGpuView[];
    observedAt?: number;
  };
  /** Currently observed usage; absent means unread, not idle. */
  usage?: {
    cpuPercent?: number;
    memoryMb?: number;
    gpus?: ResourceGpuView[];
    observedAt: number;
    source: string;
    stale: boolean;
  };
  commitments: ResourceCommitmentView[];
  /**
   * Attempts queued for capacity on this machine, oldest first. A queued
   * attempt holds no commitment and no process.
   */
  queued: Array<{
    attemptId: string;
    resources?: ExperimentResourceRequest;
    reason?: string;
    queuedAt: number;
  }>;
}

export interface ResourceListResult {
  machines: ResourceMachineView[];
  generatedAt: number;
  text: string;
}

export interface SourceRegisterParams {
  kind: string;
  label?: string;
  uri?: string;
  path?: string;
  objectHash?: string;
  note?: string;
}

export interface ResearchSourceView {
  sourceId: string;
  kind: string;
  label?: string;
  uri?: string;
  path?: string;
  objectHash?: string;
  note?: string;
  state: "available" | "retired";
  threadId?: string;
  runId?: string;
  createdAt: number;
}

export interface SourceRegisterResult {
  source: ResearchSourceView;
}

export interface SourceListParams {
  kind?: string;
}

export interface SourceListResult {
  sources: ResearchSourceView[];
  text: string;
}
