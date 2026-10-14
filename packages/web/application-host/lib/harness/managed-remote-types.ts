import type { ExperimentResourceRequest, ResourceMachineView } from "@varin/protocol";
import type { GpuAllocation } from "./gpu-resources.js";
import type { KernelBranchState } from "../kernel/protocol.generated.js";
import type { ThreadPrepareSource, ThreadPreparedSource, ThreadSource } from '@varin/application-client';
import type { SourceResourceOwner, LaunchSource, LaunchTool, HostToolCall, ExecutorOwner, RecoveryAnchor,
  KernelComputeStartParams,
  ChildSourceHandoff, ChildSourcePin, ChildSourceProvenance, DelegatedExecution } from '../kernel/protocol.generated.js';

export const MANAGED_REMOTE_PROTOCOL_VERSION = 1;

export type ManagedHostSourceOwner = Extract<SourceResourceOwner, { kind: 'managed_host' }>;
/** Obtained from the verified authenticated client, never from a request body. */
export interface ManagedSourcePrincipal { principalId: string; capabilities: readonly string[] }
export type SourceAuthorityScope = import('../kernel/protocol.generated.js').SourceAuthorityScope;
export interface ManagedSourceCapabilities {
  tools: LaunchTool[];
  grantCapabilities: string[];
  clientCapabilities: string[];
  unavailable: Array<{ name: string; code: string }>;
}
export interface ManagedSourceCapabilityRequest {
  coordinatorHostId: string;
  mode: ThreadSource['mode'];
  enabledTools?: string[];
}
export interface ManagedSourceIntegrationReceiptRequest { coordinatorHostId: string; source: LaunchSource; runId: string; threadId: string; operationId: string }
export interface ManagedSourceHandoffRequest { coordinatorHostId: string; operationId: string; parentRunId: string; parentThreadId: string; source: LaunchSource }
export interface ManagedSourceResolveRequest { coordinatorHostId: string; path: string }
export interface ManagedSourceResolveReceipt { workspaceId: string; canonicalRoot: string; hostId: string }
export interface ManagedSourcePrepareRequest { coordinatorHostId: string; input: ThreadPrepareSource }
export interface ManagedSourceBindRequest {
  coordinatorHostId: string;
  scope: SourceAuthorityScope;
  source: ThreadSource;
  purpose: 'source' | 'read' | 'integration' | 'result' | 'process_view' | 'script_environment' | 'mcp_owner';
  operationId?: string;
  retention: 'run' | 'caller';
  handoff?: ChildSourceHandoff;
  continuation?: { executionId: string; previousRunId: string; root: string };
}
/** References to the target's Storage remain target references. They confer no local access. */
export interface ManagedSourceBinding {
  authorityId: string;
  resourceEpoch: string;
  executionOwner: ExecutorOwner;
  source: LaunchSource;
  physicalRoot: import('../kernel/protocol.generated.js').LiveRoot | null;
  capabilities: ManagedSourceCapabilities;
}
export interface ManagedSourceAddress {
  coordinatorHostId: string;
  authorityId: string;
  resourceEpoch: string;
}
export interface ManagedSourceProcessAddress extends ManagedSourceAddress { processId: string }
export interface ManagedScriptBindingRequest { coordinatorHostId: string; source: LaunchSource }
export type ManagedScriptControlRequest = Omit<import('../kernel/protocol.generated.js').SourceScriptControlParams, 'principalId'>;
export interface ManagedScriptControlReceipt { processId: string; source: LaunchSource; runId: string; threadId: string; accepted: boolean; executorStopped: boolean; process: (import('../kernel/protocol.generated.js').KernelProcessSnapshot & { treeConfirmed?: boolean }) | null }
export interface ManagedScriptSpawnRequest extends ManagedSourceProcessAddress { node: import('../kernel/protocol.generated.js').NodeBinding; cwd: string }
export interface ManagedSourceProcessSubscription extends ManagedSourceProcessAddress { subscriptionId: string; cursor: number }
export type ManagedSourceProcessControl = ManagedSourceProcessAddress & { subscriptionId: string } & (
  { kind: 'close' } | { kind: 'ack'; stream: 'data' | 'control'; sequence: number }
);
export type ManagedSourceProcessWrite = ManagedSourceProcessAddress & { operationId: string; bytesBase64: string; eof?: boolean };
export type ManagedSourceProcessResize = ManagedSourceProcessAddress & { operationId: string; cols: number; rows: number };
/** Models use the original accepted invocation; service reads below never invent a ToolCall. */
export interface ManagedSourceToolRequest extends ManagedSourceAddress {
  call: HostToolCall;
  journal?: RecoveryAnchor;
}
export interface ManagedSourceReceipt {
  operationId: string;
  resourceEpoch: string;
  executionOwner: ExecutorOwner;
  accepted: boolean;
  executorStopped: boolean;
  result: unknown;
}
export interface ManagedSourceReceiptRelease { operationId: string; resourceEpoch: string; executionOwner: ExecutorOwner; released: boolean }
export interface ManagedSourceControlRequest extends ManagedSourceAddress { operationId: string }
export interface ManagedSourceReleaseRequest extends ManagedSourceAddress { mode: 'retire' | 'revoke' }
export interface ManagedSourceScopeRequest { coordinatorHostId: string; threadId: string; runId: string }
export interface ManagedSourceScopeReleaseRequest extends ManagedSourceScopeRequest { mode: 'retire' | 'revoke' }
export interface ManagedSourceReadScopeRequest { coordinatorHostId:string;scope:Extract<SourceAuthorityScope,{kind:'source_read'}>;source:LaunchSource }
export interface ManagedFileObservationRequest extends ManagedSourceAddress { requestId:string;action:import('../kernel/protocol.generated.js').SourceFileObservationAction }
export interface ManagedSourceInspection { scope: SourceAuthorityScope; phase: 'preparing' | 'ready' | 'retaining' | 'draining' | 'retired' | 'revoked'; purpose: 'source' | 'read' | 'integration' | 'result' | 'process_view' | 'script_environment' | 'mcp_owner'; operationId: string | null; mcpHolders: import('../kernel/protocol.generated.js').SourceMcpHolder[]; mcpDeliveries: import('../kernel/protocol.generated.js').SourceMcpDeliveryReceipt[]; mcpChildren: import('../kernel/protocol.generated.js').SourceMcpChildReference[]; binding: ManagedSourceBinding }

/** Closed, non-model source services. A command cannot name an arbitrary kernel method,
 * mint a grant, change a source, or select a different physical root. */
export type SourceServiceOperation =
  | { kind: 'schedule'; invocation: import('../kernel/tool-invocation.js').ToolInvocationAuthority }
  | { kind: 'mcp'; action: import('./managed-mcp-contract.js').ManagedMcpAction }
  | {kind:'native_resource';context:{run_id:string;origin:import('../kernel/protocol.generated.js').ToolOrigin;operation_id:string};action:import('../kernel/protocol.generated.js').SourceResourceAction;authorizeOnly:boolean}
  | { kind: 'language'; query: Omit<import('../kernel/protocol.generated.js').LanguageQuery, 'runId' | 'threadId' | 'grantId' | 'source' | 'physicalRoot'> }
  | { kind: 'language_release' }
  | { kind: 'validate' }
  | { kind: 'read'; path: string }
  | { kind: 'document_read'; path: string; operationId: string }
  | { kind: 'package_capture'; captureId: string; operationId: string; packagePath: string }
  | { kind: 'package_read'; captureId: string; path: string; offset: number; length: number }
  | { kind: 'experiment_admit'; operationId: string; cwd?: string }
  | { kind: 'experiment_capture'; operationId: string; cwd: string; captureScopes: string[] }
  | { kind: 'experiment_read'; operationId: string; path: string; offset: number; length: number }
  | { kind: 'check_path'; path: string }
  | { kind: 'routing_workspace' }
  | { kind: 'resources_prepare'; identity: import('@varin/application-client').ThreadIdentity;
      admitted: import('../kernel/thread-resource-scope.js').ResourceContextScope;
      request?: import('../kernel/protocol.generated.js').AgentResourceRequest;
      snapshot?: import('../kernel/protocol.generated.js').AgentResourceSnapshot;
      instructionDirectories?: string[]; supportingFiles?: { skillName: string; relativePath: string }[] }
  | { kind: 'resource_read'; reference: import('../agent-resources/source-reader.js').ResourceLocation;
      identity: import('@varin/application-client').ThreadIdentity; snapshot: import('../kernel/protocol.generated.js').AgentResourceSnapshot; request?: import('../kernel/protocol.generated.js').AgentResourceRequest }
  | { kind: 'resource_list'; reference: import('../agent-resources/source-reader.js').ResourceLocation;
      identity: import('@varin/application-client').ThreadIdentity; snapshot: import('../kernel/protocol.generated.js').AgentResourceSnapshot; request?: import('../kernel/protocol.generated.js').AgentResourceRequest }
  | {kind:'structure_recipe';path:string;languageId:string|null}
  | {kind:'structure_units';path:string;languageId:string|null}
  | { kind: 'compute'; input: Omit<KernelComputeStartParams, 'workspaceId' | 'rootId' | 'branchId' | 'revision' | 'pinId' | 'objects'> }
  | { kind: 'original_source'; branchId: string }
  | { kind: 'child_prepare'; execution: DelegatedExecution }
  | { kind: 'child_result_prepare'; execution: DelegatedExecution }
  | { kind: 'child_result_publish'; execution: DelegatedExecution }
  | { kind: 'child_result_read'; execution: DelegatedExecution }
  | { kind: 'child_release'; execution: DelegatedExecution }
  | { kind: 'child_unaccepted_release'; source: import('../kernel/protocol.generated.js').UnacceptedChildSourcePin & {operation_id:string;parent_run_id:string;parent_thread_id:string} }
  | { kind: 'integration'; invocation: import('../kernel/tool-invocation.js').ToolInvocationAuthority; child: DelegatedExecution; journal: RecoveryAnchor };
export interface ManagedSourceServiceCancelRequest extends ManagedSourceAddress { requestId: string }
export interface ManagedSourceServiceCancelReceipt { requestId: string; resourceEpoch: string; status: 'drained' | 'not_started' | 'unknown' }
export interface ManagedSourceServiceRequest extends ManagedSourceAddress {
  requestId: string;
  operation: SourceServiceOperation;
}
export interface ManagedChildSourceReceipt {
  source: LaunchSource;
  pin: ChildSourcePin;
  provenance: ChildSourceProvenance;
}
export interface ManagedSourceLocalScope {
  principal: ManagedSourcePrincipal;
  coordinatorHostId: string;
  authorityId: string;
  resourceEpoch: string;
  scope: SourceAuthorityScope;
  source: LaunchSource;
  grant: import('../kernel/kernel-client.js').KernelGrantHandle;
  physicalRoot: import('../kernel/protocol.generated.js').LiveRoot | null;
}
/** Original durable attribution for cleanup; it cannot be used as a current source reader. */
export type ManagedSourceCleanupScope = Omit<ManagedSourceLocalScope, 'grant'> & { operationId: string | null };
export type ManagedSourceServiceHandler = (scope: ManagedSourceLocalScope, operation: SourceServiceOperation, signal?: AbortSignal) => Promise<unknown>;
/** The target Host composes its existing Documents, WorkingState and native resource owners.
 * Network routes only supply authenticated principal and the closed request. */
export interface ManagedSourceService {
  recovery(principal: ManagedSourcePrincipal, input: import('./managed-recovery-contract.js').ManagedRecoveryRequest, signal?: AbortSignal): Promise<import('./managed-recovery-contract.js').ManagedRecoveryReply>;
  scriptControl(principal: ManagedSourcePrincipal, input: ManagedScriptControlRequest, signal?: AbortSignal): Promise<ManagedScriptControlReceipt>;
  scriptBinding(principal: ManagedSourcePrincipal, input: ManagedScriptBindingRequest, signal?: AbortSignal): Promise<import('../kernel/protocol.generated.js').NodeBinding>;
  scriptSpawn(principal: ManagedSourcePrincipal, input: ManagedScriptSpawnRequest, signal?: AbortSignal): Promise<import('../kernel/protocol.generated.js').KernelProcessSnapshot>;
  processAccess(principal: ManagedSourcePrincipal, input: ManagedSourceProcessAddress, signal?: AbortSignal): Promise<import('../kernel/protocol.generated.js').KernelProcessSnapshot>;
  processSubscribe(principal: ManagedSourcePrincipal, input: ManagedSourceProcessSubscription,
    observer: import('../kernel/kernel-client.js').KernelProcessObserver, signal?: AbortSignal): Promise<import('../kernel/kernel-client.js').KernelProcessSubscription>;
  processControl(principal: ManagedSourcePrincipal, input: ManagedSourceProcessControl): Promise<{ subscriptionId: string; closed: boolean }>;
  processWrite(principal: ManagedSourcePrincipal, input: ManagedSourceProcessWrite): Promise<import('../kernel/protocol.generated.js').KernelProcessInteractionReceipt>;
  processResize(principal: ManagedSourcePrincipal, input: ManagedSourceProcessResize): Promise<import('../kernel/protocol.generated.js').KernelProcessInteractionReceipt>;
  inspectReadScope(principal:ManagedSourcePrincipal,input:ManagedSourceReadScopeRequest,signal?:AbortSignal):Promise<import('../kernel/protocol.generated.js').SourceReadScopeResult>;
  closeReadScope(principal:ManagedSourcePrincipal,input:ManagedSourceReadScopeRequest,signal?:AbortSignal):Promise<import('../kernel/protocol.generated.js').SourceReadScopeResult>;
  fileObservation(principal:ManagedSourcePrincipal,input:ManagedFileObservationRequest,signal?:AbortSignal):Promise<unknown>;
  capabilities(principal: ManagedSourcePrincipal, input: ManagedSourceCapabilityRequest, signal?: AbortSignal): Promise<ManagedSourceCapabilities>;
  integrationReceipt(principal: ManagedSourcePrincipal, input: ManagedSourceIntegrationReceiptRequest, signal?: AbortSignal): Promise<unknown>;
  handoff(principal: ManagedSourcePrincipal, input: ManagedSourceHandoffRequest, signal?: AbortSignal): Promise<ChildSourceHandoff | null>;
  resolve(principal: ManagedSourcePrincipal, input: ManagedSourceResolveRequest, signal?: AbortSignal): Promise<ManagedSourceResolveReceipt>;
  prepare(principal: ManagedSourcePrincipal, input: ManagedSourcePrepareRequest, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  bind(principal: ManagedSourcePrincipal, input: ManagedSourceBindRequest, signal?: AbortSignal): Promise<ManagedSourceBinding>;
  authorize(principal: ManagedSourcePrincipal, input: ManagedSourceToolRequest, signal?: AbortSignal): Promise<unknown>;
  execute(principal: ManagedSourcePrincipal, input: ManagedSourceToolRequest, signal?: AbortSignal): Promise<ManagedSourceReceipt>;
  service(principal: ManagedSourcePrincipal, input: ManagedSourceServiceRequest, signal?: AbortSignal): Promise<unknown>;
  cancelService(principal: ManagedSourcePrincipal, input: ManagedSourceServiceCancelRequest, signal?: AbortSignal): Promise<ManagedSourceServiceCancelReceipt>;
  observe(principal: ManagedSourcePrincipal, input: ManagedSourceControlRequest, signal?: AbortSignal): Promise<ManagedSourceReceipt>;
  cancel(principal: ManagedSourcePrincipal, input: ManagedSourceControlRequest, signal?: AbortSignal): Promise<ManagedSourceReceipt>;
  releaseReceipt(principal: ManagedSourcePrincipal, input: ManagedSourceControlRequest, signal?: AbortSignal): Promise<ManagedSourceReceiptRelease>;
  release(principal: ManagedSourcePrincipal, input: ManagedSourceReleaseRequest, signal?: AbortSignal): Promise<unknown>;
  inspectScope(principal: ManagedSourcePrincipal, input: ManagedSourceScopeRequest, signal?: AbortSignal): Promise<ManagedSourceInspection[]>;
  releaseScope(principal: ManagedSourcePrincipal, input: ManagedSourceScopeReleaseRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface SourceServiceResults {
  schedule: import('../kernel/tool-bridge.js').ToolExecutionReceipt;
  mcp: import('./managed-mcp-contract.js').ManagedMcpReply;
  native_resource: unknown;
  validate: { pathScopes: string[] };
  read: import('./explore-file-reader.js').ExploreFileSnapshot;
  document_read: { bytesBase64: string; byteLength: number; sourceUrl: string; title: string; contentType: 'application/pdf' };
  package_capture: { captureId: string; snapshot: import('../kernel/extension-source.js').ExtensionSourceSnapshot };
  package_read: import('../kernel/protocol.generated.js').KernelObjectSlice;
  experiment_admit: { cwd: string };
  experiment_capture: import('../kernel/managed-research-source.js').ManagedExperimentInput;
  experiment_read: import('../kernel/protocol.generated.js').KernelObjectSlice;

  check_path: void;
  routing_workspace: string;
  language: import('../kernel/language-owner.js').LanguageResult;
  language_release: void;
  resources_prepare: import('../kernel/protocol.generated.js').AgentResourceSnapshot;
  resource_read: import('../agent-resources/source-reader.js').ResourceFileResult;
  resource_list: import('../agent-resources/source-reader.js').ResourceDirectoryResult;
  structure_recipe: {recipeId:string|null};
  structure_units: import('../structure/types.js').StructureUnitsResult;
  compute: import('../kernel/compute-runner.js').KernelComputeResult;
  original_source: import('./working-state/types.js').WorkingOriginalSource | null;
  child_prepare: ManagedChildSourceReceipt;
  child_result_prepare: import('./working-state/types.js').WorkingResultCandidate | null;
  child_result_read: import('./working-state/types.js').WorkingResultCandidate | null;
  child_result_publish: import('./working-state/types.js').WorkingResult;
  child_release: void;
  child_unaccepted_release: void;
  integration: import('./working-state/integration-coordinator.js').IntegrationOperationReceipt;
}
export type SourceServiceResponse<Operation extends SourceServiceOperation> = SourceServiceResults[Operation['kind']];

export interface ManagedRemoteIdentity {
  protocolVersion: typeof MANAGED_REMOTE_PROTOCOL_VERSION;
  hostId: string;
  capabilities: string[];
  machine: ResourceMachineView;
}

export interface ManagedRemoteMaterialEntry {
  path: string;
  state: KernelBranchState;
}

export interface ManagedRemoteMaterialManifest {
  coordinatorHostId: string;
  materialId: string;
  cwd?: string;
  entries: ManagedRemoteMaterialEntry[];
}

export interface ManagedRemoteMaterialProbe {
  ready: boolean;
  missingObjects: Array<{ objectHash: string; byteLength: number }>;
  rootId?: string;
  canonicalRoot?: string;
  cwd?: string;
}

export interface ManagedRemoteMaterialReceipt {
  materialId: string;
  root: string;
  rootId: string;
  canonicalRoot: string;
  cwd: string;
  reused: boolean;
}

export interface ManagedRemoteJobSubmit {
  coordinatorHostId: string;
  sourceWorkspaceId: string;
  attemptId: string;
  backendJobId: string;
  materialId: string;
  cwd: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  gpuAllocation?: GpuAllocation;
}

export interface ManagedRemoteJobObservation {
  status: "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown" | "released";
  writerActive: boolean;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  executionRootId?: string;
  executionCanonicalRoot?: string;
  executionCwd?: string;
}

export interface ManagedRemoteJobReceipt {
  backendJobId: string;
  observation: ManagedRemoteJobObservation;
  kernelEpoch?: string;
  pid?: number;
  executionRootId: string;
  executionCanonicalRoot: string;
  executionCwd: string;
}

export interface ManagedRemoteReadReceipt {
  chunks: Array<{ channel: "stdout" | "stderr"; bytesBase64: string }>;
  nextCursor: number;
  endCursor: number;
  observation: ManagedRemoteJobObservation;
}

export interface ManagedRemoteOutputReceipt {
  outputId: string;
  path: string;
  objectHash: string;
  byteLength: number;
}

export interface ManagedRemoteAdmissionRequest {
  coordinatorHostId: string;
  workspaceId: string;
  machineId: string;
  attemptId: string;
  resources: ExperimentResourceRequest;
}

export interface ManagedRemoteAdmissionReceipt {
  status: "confirmed" | "insufficient";
  commitmentId?: string;
  remaining?: ExperimentResourceRequest;
  gpuAllocation?: GpuAllocation;
  reason?: string;
}
