import { createPlanOwner } from './lib/kernel/plan-owner.js';
import { PlanService } from './lib/kernel/plan-service.js';
import { createPersonalizationContextResolver } from './lib/memory/personalization-context.js';
import { createMemoryOwner } from './lib/kernel/memory-owner.js';
import { ContextService } from './lib/kernel/context-service.js';
import { readContextPolicy } from './lib/kernel/context-settings.js';
import { ThreadCollaboration } from './lib/kernel/thread-collaboration.js';
import { createSemanticInferenceLedger } from './lib/knowledge/semantic/inference-ledger.js';
import { createSemanticInference } from './lib/knowledge/semantic/runtime-inference.js';
import { createRetrievalOwner } from './lib/kernel/retrieval-owner.js';
import { createRetrievalComposition } from './lib/kernel/retrieval-composition.js';
import { createLanguageOwner } from './lib/kernel/language-owner.js';
import { createLiveSourceOwner } from './lib/kernel/live-source.js';
import { createThreadSourcePreparer, createThreadSourceAdmission } from './lib/kernel/thread-sources.js';
import { createThreadContext } from './lib/kernel/thread-context.js';
import { createThreadResourceScope } from './lib/kernel/thread-resource-scope.js';
import { createThreadSkillInputPreparer } from './lib/kernel/thread-skill-input.js';
import { createResourceOwner } from './lib/kernel/resource-owner.js';
import { readAgentResourceConfiguration } from '@varin/pi-host/agent-resource-configuration';
import { createContextComposition } from './lib/kernel/context-composition.js';
import { createPolicyModelPreparer } from './lib/kernel/policy-models.js';
import { createAgentPolicy } from './lib/kernel/agent-policy.js';
import { RunObservers } from './lib/kernel/run-observers.js';
import { McpAuthority, McpCompositions, type McpCompositionScope, mcpHostAgentDir, mcpHostProjectTrusted, readMcpHostPermissionPolicy } from '@varin/pi-host/mcp-authority';
import { createMcpLease } from './lib/kernel/mcp-owner.js';
import { createExtensionTools } from './lib/kernel/extension-tool-owner.js';
import { createMaterialToolOwner, MATERIAL_SNAPSHOT_CAPABILITY } from './lib/kernel/material-tool-owner.js';
import { createIntegrationToolOwner, createIntegrationTargetOpener, createIntegrationReceiptReconciler, CHILD_INTEGRATION_CAPABILITY } from './lib/kernel/integration-tool-owner.js';
import { createMcpHarnessServices } from './lib/harness/mcp-service.js';
import { sharedHostCredentialAuthority } from '@varin/runtime-broker';
import { AgentRuntimeClient } from './lib/kernel/agent-runtime-client.js';
import { createThreadProcesses } from './lib/kernel/thread-processes.js';
import { ThreadAdapter } from './lib/kernel/thread-adapter.js';
import { registerThreadRoutes } from './lib/kernel/thread-routes.js';
import { registerRuntimeMaintenanceRoutes } from './lib/kernel/runtime-maintenance-routes.js';
import { createModelAuthority } from './lib/kernel/model-authority.js';
import 'reflect-metadata';
import { createBotDataCleanup } from './lib/bots/bot-data-cleanup.js';
import { createKernelComputeService } from './lib/kernel/compute-service.js';
import { createExperimentService } from './lib/harness/experiments.js';
import { createResourceService } from './lib/harness/resources.js';
import { createSourceService } from './lib/harness/sources.js';
import { createManagedRemoteExecutionService } from './lib/harness/managed-remote-service.js';
import { createManagedRemoteTargetRegistry, configuredHosts, type ManagedRemoteTargetRegistry } from './lib/harness/managed-remote-client.js';
import { registerManagedRemoteRoutes } from './lib/harness/managed-remote-routes.js';
import compression from 'compression';
import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import http2 from 'node:http2';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import webPush from 'web-push';
import {
  ApplicationExtensionCatalog,
  ApplicationExtensionRuntime,
  ExtensionPackageManager,
} from '@varin/extension-host';
import { VARIN_BUNDLED_LANGUAGE_SERVERS } from '@varin/extension-builtins';
import { createDocumentAuthority, type DocumentAuthority, type DocumentMutationObservation } from './lib/documents/authority.js';
import { createManagedRootAdmission } from './lib/kernel/managed-root-admission.js';
import { createKernelProcessService } from './lib/kernel/process-service.js';
import { createKernelProcessIdentityResolver } from './lib/kernel/process-identity.js';
import { registerBuiltinWorkbenchLayoutService } from './lib/extensions/workbench-layout-service.js';
import { toJsonValue } from './lib/extensions/json-value.js';
import { createDocumentsCapabilityHandler } from './lib/documents/capability.js';
import {
  createWorkspaceRecoveryEngine,
  type RecoverySessionNavigation,
  type WorkspaceRecoveryEngine,
} from './lib/recovery/engine.js';
import { createWorkspaceRecoveryCapabilityHandler } from './lib/recovery/capability.js';
import { RecoveryPrimitiveError } from './lib/recovery/errors.js';
import { createPiWorkspaceWriterTracker } from './lib/recovery/pi-writer-tracker.js';
import { createRecoveryTurnCoordinator } from './lib/recovery/turn-coordinator.js';
import { createLanguageSupervisor, SURFACE_LANGUAGE_VIEW } from './lib/lsp/supervisor.js';
import { createLanguagePrewarm } from './lib/lsp/prewarm.js';
import { createManagedLanguageServers } from './lib/lsp/managed-servers.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './lib/workspace/path-safety.js';
import { createLanguageCapabilityHandler, createWorkspaceSearchCapabilityHandler } from './lib/lsp/capability.js';
import { createRunRuntime } from './lib/run/runtime.js';
import {
  createWorkspaceDebugCapabilityHandler,
  createWorkspaceTasksCapabilityHandler,
  createWorkspaceTestCapabilityHandler,
} from './lib/run/capability.js';
import { createWorkspaceContentSearch } from './lib/search/content.js';
import { createDocumentRootGuard } from './lib/documents/allowed-roots.js';
import { createWorkspaceConfig } from './lib/workspace/workspace-config.js';

import { createHarnessRouter, buildHarnessRespondParams } from './lib/harness/router.js';
import { createHarnessServiceHost, deriveHarnessCapabilities } from './lib/harness/service-host.js';
import { createSourceViewRuntime } from './lib/harness/source-view-runtime.js';
import { discoverShells } from './lib/harness/shell-discovery.js';
import { createShellPathResolver } from './lib/harness/shell-path.js';
import { createHarnessSessionRegistration } from './lib/harness/session-registration.js';
import { performHarnessWebFetch, registerHarnessServices } from './lib/harness/harness-services.js';
import { createUserThreadSendAdapter } from './lib/harness/thread-ui-adapter.js';
import { openWorkspaceKnowledge, type KnowledgeStore } from './lib/knowledge/store.js';
import { knowledgeStorageActivity } from './lib/knowledge/store-process.js';
import { createKnowledgeContextRuntime } from './lib/knowledge/context-runtime.js';
import { createGitStatusObserver } from './lib/knowledge/git-status-runtime.js';
import { createSymbolGraphRuntime } from './lib/knowledge/symbol-runtime.js';
import { createProjectIndexScope, insideDirectory, excludedFromIndex, indexPathAllowed } from './lib/knowledge/index-scope.js';
import { createIndexDirectoryManager } from './lib/knowledge/index-directories.js';
import { purgeSemanticWorkspaceCache } from './lib/knowledge/semantic/cache-maintenance.js';
import { projectFolders, projectContainsPath } from '@varin/application-client';
import { createLocalSemanticEmbedder } from './lib/knowledge/semantic/local-embedder.js';
import { createLocalSemanticComponentManager } from './lib/knowledge/semantic/local-component.js';
import { registerLocalSemanticComponentRoutes } from './lib/knowledge/semantic/local-component-routes.js';
import { createSemanticIndexManagement, DEFAULT_SEMANTIC_INDEX_CONFIGURATION, registerSemanticIndexRoutes } from './lib/knowledge/semantic/index-management.js';
import { createWorkspaceSemanticRuntime, GLOBAL_INFERENCE_SCOPE } from './lib/knowledge/semantic/workspace-runtime.js';
import { createEmbedScheduler } from './lib/knowledge/semantic/embed-scheduler.js';
import { createVectorCache } from './lib/knowledge/semantic/vector-cache.js';
import { createKnowledgeVectorRuntime } from './lib/knowledge/vectors/index.js';
import type { KnowledgeVectorRuntime, MemoryRecallAssociation, MemoryRecallSource } from './lib/knowledge/vectors/index.js';
import { recallMemories } from './lib/memory/memory-recall.js';



import { type TodoToolDeps } from './lib/harness/todo-tool.js';
import { openUserKnowledgeStore, type RecallToolDeps } from './lib/harness/recall-tool.js';
import { createThreadRegistry } from './lib/harness/thread-registry.js';

import { createOnThreadDequeued } from './lib/harness/thread-dequeue.js';
import { createThreadTranscriptReader } from './lib/harness/thread-transcript.js';
import { createHarnessPathAuthority } from './lib/harness/path-authority.js';
import { sessionScopeId, isSessionScopeId, sessionIdFromScopeId, isSessionStoreKey, isBotStoreKey, isBotScopeId, botIdFromScopeId, botScopeId, knowledgeStoreKeyForScope, scopeOfScopeId } from './lib/harness/owner-scope.js';
import { createMemoryService } from './lib/memory/memory-service.js';
import { createMemoryOrganizer, type OrganizerRunSource } from './lib/memory/memory-organizer.js';
import { registerSelectionMemoryRoutes } from './lib/memory/selection-memory-routes.js';
import { createAgentPersonalization } from './lib/memory/agent-personalization.js';
import { registerAgentPersonalizationRoutes } from './lib/memory/agent-personalization-routes.js';
import { createExploreFileReader } from './lib/harness/explore-file-reader.js';
import { createThreadWorktreeRuntime } from './lib/harness/thread-worktree.js';
import { createThreadRuntime } from './lib/harness/thread-runtime.js';
import { createResearchRootRuntime } from './lib/harness/research-root-runtime.js';
import { createAgentRootRuntime } from './lib/harness/agent-root-runtime.js';
import { correlatedReply, createThreadWaitRuntime } from './lib/harness/thread-wait-runtime.js';
import { isAttachedRootPurpose } from '@varin/protocol';
import { createBotRootRuntime } from './lib/harness/bot-root-runtime.js';
import { createBotService } from './lib/bots/bot-service.js';
import { createBotLifecycleRuntime } from './lib/bots/bot-lifecycle-runtime.js';
import { registerBotRoutes } from './lib/bots/bot-routes.js';
import { createComputerService } from './lib/computer/computer-service.js';
import { resolveComputerActor } from './lib/computer/computer-actor.js';
import { HostSshManager } from './lib/connections/ssh-manager.js';
import { registerConnectionRoutes } from './lib/connections/connection-routes.js';
import { attachConnectionProxy } from './lib/connections/host-proxy.js';
import { configuredVmProviders } from './lib/computer/vm-provider.js';
import { registerComputerRoutes } from './lib/computer/computer-routes.js';
import { attachDesktopMedia } from './lib/computer/desktop-media.js';
import { attachServiceForward } from './lib/harness/environment-forward-server.js';
import { createVmGuestRegistration } from './lib/computer/vm-guest-register.js';
import { createWorktreeReclaimGuard } from './lib/harness/worktree-reclaim-guard.js';
import { resolveThreadWorktreeSettings } from './lib/harness/thread-worktree-settings.js';
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter } from './lib/kernel/storage-adapter.js';
import { KernelFileResourceBackend } from './lib/kernel/file-resource-backend.js';
import { KernelPathLockService } from './lib/kernel/file-resource-lock-service.js';
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from './lib/kernel/kernel-recovery-store.js';
import { createRetrievalArtifactAccess } from './lib/harness/retrieval-artifacts.js';
import { createWebMaterialStore, type WebMaterialStore } from './lib/harness/web-materials.js';
import { createMaterialCollections as createMaterialCollectionsService } from './lib/harness/material-collections.js';
import { createResearchDecideService, type ResearchDecideDeps } from './lib/harness/research-decide.js';
import { ThreadExecutionViewRegistry } from './lib/harness/working-state/execution-view.js';
import { createWorkingBranchLookups } from './lib/harness/working-state/working-branch-lookups.js';
import { createWorkingBranchWriteServices } from './lib/harness/working-state/working-branch-writes.js';
import { acquireVirtualWriteTicket, VirtualWriteGate } from './lib/harness/working-state/virtual-write-gate.js';
import { IntegrationCoordinator } from './lib/harness/working-state/integration-coordinator.js';
import { reconcileInterruptedKernelBranchIntegrations } from './lib/recovery/durable-file-operation.js';
import { DEFAULT_HARNESS_SETTINGS, resolveHarnessDocumentReadingSettings, THINKING_LEVELS, type SessionSnapshot } from '@varin/protocol';
import { createSettingsService, settingsDocumentRevision } from './lib/harness/settings-service.js';
import { createFollowUpService } from './lib/harness/followups.js';
import { createFollowUpThreadSender } from './lib/harness/followup-delivery.js';
import { createClientSurfaceBridge } from './lib/harness/client-surfaces.js';
import { createSettingsActionRegistry } from './lib/harness/settings-actions.js';
import { createKernelSettingsActionOperationStore } from './lib/harness/settings-operation-store.js';
import * as gitIdentityStorage from './lib/git/identity-storage.js';
import { getGitHubAuth, getGitHubAuthAccounts, isGhCliActive, isGhCliDisabled } from './lib/github/auth.js';
import { getGhCliToken } from './lib/github/gh-cli-credential.js';
import { getStatus as getGitStatus, resolvePrimaryWorktreeRoot } from './lib/git/service.js';
import { createVerificationCoordinator } from './lib/harness/verification-coordinator.js';
import { createSourceViewStore, SOURCE_VIEW_STORAGE_SCOPE } from './lib/harness/source-view-store.js';
import { createKernelClient, type KernelClient } from './lib/kernel/kernel-client.js';
import { registerHarnessExperimentRoutes } from './lib/harness/experiment-routes.js';
import { registerHarnessFollowUpRoutes } from './lib/harness/follow-up-routes.js';
import { registerHarnessThreadRoutes } from './lib/harness/thread-routes.js';
import { registerHarnessContextRoutes } from './lib/harness/context-routes.js';
import { createLanguageSupervisorDiagnosticsProvider } from './lib/harness/diagnostics-adapter.js';
import { createLspNavigationServices } from './lib/harness/lsp-nav.js';
import { createRelationCollector } from './lib/knowledge/relations.js';
import { createLspStructureProvider } from './lib/structure/lsp-provider.js';
import { createStructureSource } from './lib/structure/source.js';
import { createTreeSitterStructureProvider } from './lib/structure/tree-sitter-provider.js';
import { createGrammarAbiInspector, GRAMMAR_MAX_ABI, GRAMMAR_MIN_ABI } from './lib/structure/grammar-abi.js';
import { createGrammarInstaller } from './lib/structure/grammar-installer.js';
import { EMPTY_GRAMMAR_PACK_MANIFEST, loadCommittedGrammarPackManifest } from './lib/structure/grammar-manifest.js';
import { createGrammarStore } from './lib/structure/grammar-store.js';
import { resolveStructureRuntimeFile } from './lib/structure/runtime-path.js';
import { createLanguageSupportRuntime } from './lib/language-support/runtime.js';
import { createWebFetch, type SsrfPolicy } from './lib/harness/web-fetch.js';
import { createDocumentReader } from './lib/harness/document-reading.js';
import { createPdfEngine } from './lib/harness/pdf-engine.js';
import { createUserMaterialReadAdapter } from './lib/harness/material-read-ui-adapter.js';
import { resolveHarnessWebBinding } from './lib/harness/harness-web-settings.js';
import { encodeDocumentText } from './lib/documents/inspect.js';
import { createWebSearchService, resolveConfiguredSearchProvider } from './lib/harness/web-search.js';
import { createResearchSearchService } from './lib/harness/research-search.js';
import { registerWebSearchCredentialRoutes } from './lib/harness/web-search-routes.js';
import { registerPdfMaterialRoutes } from './lib/harness/pdf-material-routes.js';
import { checkDesktopHttpUrl, checkSsrf, isSameHost } from './lib/harness/ssrf-policy.js';
import { createEgressRuntime } from './lib/harness/egress.js';
import { readEgressHostConfiguration } from './lib/harness/egress-settings.js';
import { registerEgressRoutes } from './lib/harness/egress-routes.js';
import { readPiAuthFile, removePiProviderAuth, savePiProviderAuth } from './lib/pi-config/storage.js';

import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelMode,
  normalizeTunnelProvider,
  normalizeTunnelStartRequest,
  type TunnelController,
} from './lib/tunnels/types.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import {
  getInvalidBindHostErrorMessage,
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
  normalizeBindHost,
} from './lib/security/bind-host.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import {
  createTerminalCommandObserveAdapter,
  createTerminalCommandProjector,
} from './lib/knowledge/terminal-projection.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { mintOutsideFileGrant } from './lib/fs/routes.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import {
  createGlobalUiEventBroadcaster,
  createNotificationEmitterRuntime,
} from './lib/notifications/emitter-runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createPiSessionRuntime } from './lib/notifications/pi-session-runtime.js';
import { createMobileDeviceStore } from './lib/mobile/device-store.js';
import { createMobilePairingRuntime } from './lib/mobile/pairing-runtime.js';
import { createMobilePushRuntime } from './lib/mobile/push-runtime.js';
import { registerMobileRoutes } from './lib/mobile/routes.js';
import { createGracefulShutdownRuntime } from './lib/shutdown-runtime.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { createPreviewProxyRuntime } from './lib/preview/proxy-runtime.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { createRelayService } from './lib/relay/service.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';
import { PiRuntimeBrokerError, PiRuntimeLifecycle } from '@varin/runtime-broker';
import {
  attachPiSessionExecutionAdmission,
  createWebPiRuntimeBroker,
} from './lib/pi-runtime/broker.js';
import { createPiRuntimeGateway } from './lib/pi-runtime/gateway.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createPiScheduledTaskExecutor } from './lib/scheduled-tasks/pi-executor.js';
import { createSessionSettleTracker } from './lib/scheduled-tasks/session-settle.js';
import { createPiSessionAutomationRuntime } from './lib/pi-session-automation/runtime.js';
import { createPiSessionTitleRuntime } from './lib/pi-session-automation/titles.js';
import { createServerBootstrapRuntime } from './lib/platform/bootstrap-runtime.js';
import { parseServeCliOptions } from './lib/platform/cli-options.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/platform/core-routes.js';
import { createPlatformEnvironmentRuntime } from './lib/platform/environment-runtime.js';
import { resolveVarinDataDir } from './lib/platform/data-paths.js';
import { clearAppImageArgv0FromProcessEnv } from './lib/platform/inherited-env.js';
import { pathLooksUserConfigured, mergePathValues } from './lib/platform/path-utils.js';
import { createProjectDirectoryRuntime } from './lib/platform/project-directory-runtime.js';
import { registerVarinRoutes } from './lib/platform/varin-routes.js';
import { createPlatformRoutesRuntime } from './lib/platform/routes-runtime.js';
import { runCliEntryIfMain } from './lib/platform/cli-entry-runtime.js';
import { createServerStartupRuntime } from './lib/platform/server-startup-runtime.js';
import { createSettingsHelpers } from './lib/platform/settings-helpers.js';
import { createSettingsNormalizationRuntime } from './lib/platform/settings-normalization-runtime.js';
import { createSettingsRuntime } from './lib/platform/settings-runtime.js';
import { recordStartupPerformance } from './lib/platform/startup-performance.js';
import { createStaticRoutesRuntime } from './lib/platform/static-routes-runtime.js';
import { createStartupPipelineRuntime } from './lib/platform/startup-pipeline-runtime.js';
import { createThemeRuntime } from './lib/platform/theme-runtime.js';
import { createTunnelAuth } from './lib/platform/tunnel-auth.js';
import { createTunnelWiringRuntime } from './lib/platform/tunnel-wiring-runtime.js';
import type {
  DesktopNotificationPayload,
  HostPiRuntimeBrokerFactoryOptions,
  StartWebUiServerOptions,
  WebUiServerController,
} from './public-contract.js';
export type * from './public-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CLIENT_RELOAD_DELAY_MS = 800;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const DESKTOP_NOTIFY_PREFIX = '[VarinDesktopNotify] ';
const MAX_THEME_JSON_BYTES = 512 * 1024;

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);
const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export function mergeSessionSnapshotForKnowledgeOwner(previousValue: unknown, nextValue: unknown): Record<string, unknown> {
  const previous = recordOf(previousValue);
  const next = recordOf(nextValue);
  const previousWorkspace = recordOf(previous.workspace);
  const nextWorkspace = recordOf(next.workspace);
  const hasWorkspaceId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const ownerId = (workspace: Record<string, unknown>): string | null => (
    workspace.kind === 'workspace'
      ? hasWorkspaceId(workspace.authorityId)
        ? workspace.authorityId
        : hasWorkspaceId(workspace.id) ? workspace.id : null
      : null
  );
  const previousOwner = ownerId(previousWorkspace);
  const nextOwner = ownerId(nextWorkspace);
  const canKeepKnownOwner = previousOwner !== null
    && (nextWorkspace.kind === undefined || nextWorkspace.kind === 'workspace')
    && (nextOwner === null || nextOwner === previousOwner);
  const merged = { ...previous, ...next };
  if (canKeepKnownOwner) {
    // Pi can publish partial root-session snapshots. Carry its already known
    // workspace identity through missing fields, while letting a different
    // explicit owner replace the old snapshot.
    const workspace: Record<string, unknown> = { ...previousWorkspace, ...nextWorkspace, kind: 'workspace' };
    if (!hasWorkspaceId(nextWorkspace.authorityId) && hasWorkspaceId(previousWorkspace.authorityId)) {
      workspace.authorityId = previousWorkspace.authorityId;
    }
    if (!hasWorkspaceId(nextWorkspace.id) && hasWorkspaceId(previousWorkspace.id)) {
      workspace.id = previousWorkspace.id;
    }
    merged.workspace = workspace;
  }
  return merged;
}

export async function resolveKnowledgeScopeOwner(
  resolveDurableOwner: () => Promise<{ owningScopeId: string } | null>,
  fallbackScopeId: string | null,
  snapshotWorkspaceId: string | null,
): Promise<string | null> {
  const owner = await resolveDurableOwner();
  return owner?.owningScopeId ?? fallbackScopeId ?? snapshotWorkspaceId;
}

const isEnvFlagEnabled = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '1' || value.trim().toLowerCase() === 'true';
};

const isEnvFlagDisabled = (value: unknown): boolean => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '0' || value.trim().toLowerCase() === 'false';
};

const VARIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    throw new Error('package.json does not declare a version');
  } catch (error) {
    throw new Error(`Unable to resolve the Varin Web application version: ${errorMessage(error)}`);
  }
})();

const VARIN_DATA_DIR = resolveVarinDataDir(process);
const VARIN_USER_CONFIG_ROOT = VARIN_DATA_DIR;
const VARIN_USER_THEMES_DIR = path.join(VARIN_USER_CONFIG_ROOT, 'themes');
const VARIN_PROJECTS_CONFIG_DIR = path.join(VARIN_USER_CONFIG_ROOT, 'projects');
const SETTINGS_FILE_PATH = path.join(VARIN_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(VARIN_DATA_DIR, 'push-subscriptions.json');
const MOBILE_DEVICES_FILE_PATH = path.join(VARIN_DATA_DIR, 'mobile-devices.json');
const APNS_TOKENS_FILE_PATH = path.join(VARIN_DATA_DIR, 'apns-tokens.json');
const REMOTE_CLIENTS_FILE_PATH = path.join(VARIN_DATA_DIR, 'remote-clients.json');
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(VARIN_DATA_DIR, 'client-pairing-sessions.json');
const MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(VARIN_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(VARIN_DATA_DIR, 'cloudflare-named-tunnels.json');

const shouldSkipApiCompression = (): boolean => {
  if (isEnvFlagEnabled(process.env.VARIN_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.VARIN_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.VARIN_COMPRESS_API)) return true;
  return process.env.VARIN_RUNTIME === 'desktop';
};

const SSE_PATHS = new Set([
  '/api/notifications/stream',
  '/api/varin/events',
  '/api/varin/runtime-manager/events',
  '/api/varin/realtime-proxy/sse',
]);

const shouldSkipCompression = (req: Request, res: Response): boolean => {
  if (process.env.VARIN_RUNTIME === 'desktop') return true;
  const acceptsSse = (value: unknown): boolean => Array.isArray(value)
    ? value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'))
    : typeof value === 'string' && value.toLowerCase().includes('text/event-stream');
  if (acceptsSse(req.headers.accept)) return true;
  const pathname = req.path || req.url || '';
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) return true;
  return SSE_PATHS.has(pathname) || acceptsSse(res.getHeader('Content-Type'));
};

const fsPromises = fs.promises;
const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  realpathSync: fs.realpathSync,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});
const {
  normalizeDirectoryPath,
  normalizePathForPersistence,
  normalizeSettingsPaths,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
} = settingsNormalizationRuntime;

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
  },
});
const {
  readManagedRemoteTunnelConfigFromDisk,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
} = managedTunnelConfigRuntime;

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
});
const {
  normalizePwaAppName,
  normalizePwaOrientation,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  formatSettingsResponse,
} = settingsHelpers;

type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
let readSettingsFromDisk: SettingsRuntime['readSettingsFromDisk'] = async () => ({});
const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  readSettingsFromDisk,
  getReadSettingsFromDisk: () => readSettingsFromDisk,
  sanitizeProjects,
});
const { resolveProjectDirectory } = projectDirectoryRuntime;

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  formatSettingsResponse,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
});
readSettingsFromDisk = settingsRuntime.readSettingsFromDisk;
const { updateSettingsOnDisk, persistSettings } = settingsRuntime;

const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: VARIN_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});
const { readCustomThemesFromDisk } = themeRuntime;

const requestSecurityRuntime = createRequestSecurityRuntime({ readSettingsFromDisk });
const {
  getUiSessionTokenFromRequest,
  rejectWebSocketUpgrade,
  isRequestOriginAllowed,
} = requestSecurityRuntime;

const pushRuntime = createPushRuntime({
  webPush,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const {
  getOrCreateVapidKeys,
  addOrUpdatePushSubscription,
  removePushSubscription,
  sendPushToAllUiSessions,
  isAnyInteractiveClientVisible,
  isUiVisible,
  ensurePushInitialized,
  setPushInitialized,
  updateUiVisibility,
} = pushRuntime;

const mobileDeviceStore = createMobileDeviceStore({
  crypto,
  mobileDevicesFilePath: MOBILE_DEVICES_FILE_PATH,
});
const mobilePushRuntime = createMobilePushRuntime({ deviceStore: mobileDeviceStore });
const { sendMobilePushToAllDevices } = mobilePushRuntime;
const mobilePairingRuntime = createMobilePairingRuntime({ crypto, deviceStore: mobileDeviceStore });
const apnsRuntime = createApnsRuntime({
  fsPromises,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const {
  addOrUpdateApnsToken,
  removeApnsToken,
  sendApnsToAllUiSessions,
} = apnsRuntime;

const uiNotificationClients = new Set<Response>();
const uiVarinEventClients = new Set<Response>();
const desktopNotifyEnabled = process.env.VARIN_DESKTOP_NOTIFY === 'true'
  || process.env.VARIN_RUNTIME === 'desktop';
let broadcastGlobalUiEvent: ReturnType<typeof createGlobalUiEventBroadcaster> | null = null;
const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => desktopNotifyEnabled,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});
const {
  writeSseEvent,
  emitDesktopNotification,
  broadcastUiNotification,
} = notificationEmitterRuntime;
let isPiSessionLive: (sessionId: string) => Promise<boolean> = async () => false;
const clientSurfaceBridge = createClientSurfaceBridge({
  writeSseEvent,
  isSessionLive: (sessionId) => isPiSessionLive(sessionId),
});
broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  writeSseEvent,
});
const sessionRuntime = createPiSessionRuntime({ broadcastEvent: broadcastGlobalUiEvent });

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: VARIN_PROJECTS_CONFIG_DIR,
});
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  listProjects: async () => sanitizeProjects((await readSettingsFromDisk()).projects || []) ?? [],
  emitTaskRunEvent: (event) => {
    for (const client of uiVarinEventClients) {
      try {
        writeSseEvent(client, {
          type: 'varin:scheduled-task-ran',
          properties: {
            projectId: event.projectID,
            taskId: event.taskID,
            ranAt: event.ranAt,
            status: event.status,
            ...(event.sessionID ? { sessionId: event.sessionID } : {}),
          },
        });
      } catch {
        uiVarinEventClients.delete(client);
      }
    }
  },
  logger: console,
});
const scheduledTaskService = createScheduledTaskService({
  readSettingsFromDisk,
  sanitizeProjects,
  projectConfigRuntime,
  scheduledTasksRuntime,
});

const platformEnvironmentRuntime = createPlatformEnvironmentRuntime();
platformEnvironmentRuntime.applyLoginShellEnvSnapshot();
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});

type UiAuthController = ReturnType<typeof createUiAuth>;
type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

let server: http.Server | null = null;
let uiAuthController: UiAuthController | null = null;
let activeTunnelController: TunnelController | null = null;
let terminalRuntime: TerminalRuntime | null = null;
let activeDocumentsAuthority: DocumentAuthority | null = null;
let exitOnShutdown = true;
let isShuttingDown = false;
let signalsAttached = false;
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';

const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDisk,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => { activeTunnelController = value; },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => { runtimeManagedRemoteTunnelHostname = value; },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => { runtimeManagedRemoteTunnelToken = value; },
});

const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => { isShuttingDown = value; },
  sessionRuntime,
  scheduledTasksRuntime,
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => { terminalRuntime = value; },
  getDocumentsAuthority: () => activeDocumentsAuthority,
  setDocumentsAuthority: (value) => { activeDocumentsAuthority = value; },
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => { uiAuthController = value; },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => { activeTunnelController = value; },
  tunnelAuthController,
});
const gracefulShutdown = gracefulShutdownRuntime.gracefulShutdown;
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createDictationRuntime,
  createServerStartupRuntime,
});
const bootstrapRuntime = createServerBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerMobileRoutes,
  registerVarinRoutes,
  express,
});
const platformRoutesRuntime = createPlatformRoutesRuntime({ clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS });

const requestReachedLanAddress = (req: Request): string | null => {
  const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && !address.startsWith('127.') ? address : null;
};

const extractAssistantText = (messages: unknown): string => {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== 'assistant' || !Array.isArray(candidate.content)) continue;
    const text = candidate.content
      .filter((part: unknown): part is { text: string; type: 'text' } => (
        Boolean(part)
        && typeof part === 'object'
        && !Array.isArray(part)
        && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string'
      ))
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text.slice(0, 240);
  }
  return '';
};

async function main(options: StartWebUiServerOptions = {}): Promise<WebUiServerController> {
  if (server?.listening) throw new Error('Varin server is already running');
  isShuttingDown = false;
  const port = typeof options.port === 'number' && Number.isFinite(options.port) && options.port >= 0
    ? Math.trunc(options.port)
    : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : undefined;
  const configuredBindHost = host || process.env.VARIN_HOST?.trim() || '127.0.0.1';
  const effectiveBindHost = normalizeBindHost(configuredBindHost);
  if (!effectiveBindHost) throw new Error(getInvalidBindHostErrorMessage(configuredBindHost));
  const uiPassword = typeof options.uiPassword === 'string'
    ? options.uiPassword
    : typeof process.env.VARIN_UI_PASSWORD === 'string'
      ? process.env.VARIN_UI_PASSWORD
      : null;
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(typeof uiPassword === 'string' && uiPassword.trim())
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (typeof options.exitOnShutdown === 'boolean') exitOnShutdown = options.exitOnShutdown;
  if (typeof options.onDesktopNotification === 'function') {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  const getIsWindowFocused = typeof options.getIsWindowFocused === 'function'
    ? options.getIsWindowFocused
    : () => false;
  const getDesktopRuntimeConfig = typeof options.getDesktopRuntimeConfig === 'function'
    ? options.getDesktopRuntimeConfig
    : null;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.VARIN_API_ONLY);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : undefined;
  const startupTunnelRequest = (
    typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string'
  )
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : options.tryCfTunnel === true
      ? normalizeTunnelStartRequest({
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          token: '',
        })
      : null;

  console.log(`Starting Varin on port ${port === 0 ? 'auto' : port}`);
  const app = express();
  const extensionCatalog = options.extensionCatalog
    || options.extensionRuntime?.catalog
    || new ApplicationExtensionCatalog({ dataDir: VARIN_DATA_DIR });
  const extensionPackages = options.extensionPackages
    || options.extensionRuntime?.packages
    || new ExtensionPackageManager({
    catalog: extensionCatalog,
    dataDir: VARIN_DATA_DIR,
    varinVersion: VARIN_VERSION,
  });
  let extensionRuntime = options.extensionRuntime || null;
  const ownsExtensionRuntime = !extensionRuntime;
  app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  const packagedClientOrigins = new Set(['varin-ui://app', 'capacitor://localhost', 'http://localhost', 'https://localhost']);
  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (packagedClientOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-Varin-Application-Token,X-Varin-Directory,X-Varin-Directory-Encoding');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
  app.use(compression({
    filter: (req, res) => shouldSkipCompression(req, res) ? false : compression.filter(req, res),
    threshold: 1024,
  }));
  server = http.createServer(app);
  const serverStartedAt = new Date().toISOString();
  type PiRuntimeHandshake = Awaited<ReturnType<PiRuntimeLifecycle['start']>> | null;
  type RelayService = ReturnType<typeof createRelayService>;
  type TunnelRuntimeContext = ReturnType<ReturnType<typeof createTunnelWiringRuntime>['initialize']>;
  let piRuntimeHandshake: PiRuntimeHandshake = null;
  let piRuntimeLifecycle: PiRuntimeLifecycle | null = null;
  let relayServiceInstance: RelayService | null = null;
  let tunnelRuntimeContext: TunnelRuntimeContext | null = null;
  let kernelClient: KernelClient | null = null;
  let realtimeProxyRuntime: Pick<ReturnType<typeof attachRealtimeProxy>, 'stop'> = { stop: () => {} };
  let dictationRuntime: ReturnType<typeof createDictationRuntime> | null = null;
  const currentPiRuntimeHandshake = () => (
    piRuntimeLifecycle ? piRuntimeLifecycle.handshake : piRuntimeHandshake
  );

  const activePort = () => tunnelRuntimeContext?.getActivePort() || port;
  const resolvePairingTransports = (req: Request) => {
    const local = `http://127.0.0.1:${activePort()}`;
    let lanHost = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      lanHost = requestReachedLanAddress(req);
      if (!lanHost) {
        for (const list of Object.values(os.networkInterfaces())) {
          const entry = (list || []).find((candidate) => candidate.family === 'IPv4' && !candidate.internal);
          if (entry) { lanHost = entry.address; break; }
        }
      }
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(effectiveBindHost.toLowerCase())) {
      lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort()}` : null;
    return { local, lan, relayAvailable: true };
  };
  const resolveDirectLanUrls = (req: Request): string[] => {
    const urls: string[] = [];
    const add = (address: string | null): void => {
      if (!address) return;
      const url = `http://${address.includes(':') ? `[${address}]` : address}:${activePort()}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      add(requestReachedLanAddress(req));
      for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) add(entry.address);
      }
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(effectiveBindHost.toLowerCase())) {
      add(effectiveBindHost);
    }
    return urls;
  };

  const sayTTSCapability = detectSayTtsCapability(process);
  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    varinVersion: VARIN_VERSION,
    runtimeName: process.env.VARIN_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot: () => {
      const handshake = currentPiRuntimeHandshake();
      return {
        apiOnly,
        ...(process.env.VARIN_RELEASE_ID?.trim()
          ? { releaseId: process.env.VARIN_RELEASE_ID.trim() }
          : {}),
        piRuntime: {
          ready: Boolean(handshake),
          capabilities: handshake?.capabilities ?? null,
          hostVersion: handshake?.hostVersion ?? null,
          nodeVersion: handshake?.runtime?.nodeVersion ?? null,
          piVersion: handshake?.runtime?.piVersion ?? null,
          protocolVersion: handshake?.protocolVersion ?? null,
          source: handshake?.runtime?.source ?? null,
          manager: piRuntimeLifecycle?.snapshot ?? null,
        },
        kernel: kernelClient?.handshake
          ? {
              ready: kernelClient.isReady,
              epoch: kernelClient.kernelEpoch,
              version: kernelClient.handshake.kernelVersion,
              protocolVersion: kernelClient.handshake.protocolVersion,
            }
          : { ready: false, epoch: null, version: null, protocolVersion: null },
      };
    },
    verboseRequestLogs: isEnvFlagEnabled(process.env.VARIN_VERBOSE_REQUEST_LOGS),
    uiPassword,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: async (pairingOptions) => relayServiceInstance
      ? pairingOptions?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate()
      : null,
    reconcileRelay: () => relayServiceInstance?.reconcile() ?? Promise.resolve(),
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    getServerId: () => relayServiceInstance?.getServerId() ?? Promise.resolve(null),
    getServerPort: activePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getServerLabel: () => os.hostname()?.trim() || 'Varin',
    readSettingsFromDisk,
    normalizeTunnelSessionTtlMs,
    sayTTSCapability,
    ensurePushInitialized,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    updateSettingsOnDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => {},
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    sessionRuntime,
    setPushInitialized,
    fs,
    path,
    server,
    __dirname,
    varinDataDir: VARIN_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL_MS,
    mobileDeviceStore,
    mobilePairingRuntime,
    mobilePushRuntime,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  realtimeProxyRuntime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig,
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed,
  });

  const requirePiRuntime = options.requirePiRuntime ?? process.env.VARIN_RUNTIME !== 'desktop';
  type PiWriterTracker = ReturnType<typeof createPiWorkspaceWriterTracker>;
  type RecoveryTurnCoordinator = ReturnType<typeof createRecoveryTurnCoordinator>;
  type PiAdmissionRequest = Parameters<NonNullable<HostPiRuntimeBrokerFactoryOptions['admitSessionExecution']>>[0];
  let piWriterTracker: PiWriterTracker | null = null;
  let recoveryTurnCoordinator: RecoveryTurnCoordinator | null = null;
  let assertBotSessionExecution = async (_sessionId: string): Promise<void> => {};
  const admitPiSessionExecution = async (request: PiAdmissionRequest) => {
    if (!piWriterTracker) {
      throw new PiRuntimeBrokerError(
        'runtime_not_ready',
        'Pi workspace writer admission is not ready',
        { retryable: true },
      );
    }
    const assertCanExecute = async () => {
      if (request.sessionId && request.phase !== 'worker-start') await assertBotSessionExecution(request.sessionId);
    };
    await assertCanExecute();
    const lease = await (recoveryTurnCoordinator?.admit(request) ?? piWriterTracker.admit(request));
    return { close: () => lease?.close(), assertCanExecute };
  };
  const piRuntimeBrokerFactory = options.createPiRuntimeBroker || ((brokerOptions: HostPiRuntimeBrokerFactoryOptions) => createWebPiRuntimeBroker({
    agentDir: process.env.VARIN_AGENT_DIR,
    clientVersion: VARIN_VERSION,
    cwd: process.cwd(),
    // The official Host always provides SSRF-guarded web.fetch. Reader-model
    // execution stays inside pi-host so it uses the session's credential and
    // model authority rather than creating a second model stack in the Host.
    harnessDocumentRead: true,
    harnessDocumentPathOverlay: true,
    harnessWebRead: true,
    // Provider identity is frozen per session from Pi settings. The Host
    // service itself is always present, so changing provider does not require
    // an application restart.
    harnessWebSearch: true,
    resolveProjectWorkFocus: async ({ cwd, workspace }) => {
      if (workspace?.kind === 'unbound') return undefined;
      const settings = await readSettingsFromDisk();
      const projects = sanitizeProjects(settings.projects || []) ?? [];
      const projectId = workspace?.kind === 'workspace' ? workspace.id : undefined;
      const explicitProject = projectId === undefined
        ? undefined
        : projects.find((entry) => entry.id === projectId);
      const project = explicitProject
        ?? projects.find((entry) => projectContainsPath(entry, cwd));
      return project?.defaultWorkFocus === 'code' || project?.defaultWorkFocus === 'research'
        ? project.defaultWorkFocus
        : undefined;
    },
    ...brokerOptions,
  }));
  const createPiRuntimeBroker = (brokerOptions: HostPiRuntimeBrokerFactoryOptions) => attachPiSessionExecutionAdmission(
    piRuntimeBrokerFactory({
      ...brokerOptions,
      admitSessionExecution: admitPiSessionExecution,
    }),
    admitPiSessionExecution,
  );
  const standalonePayloadDir = options.standalonePayloadDir || process.env.VARIN_PI_STANDALONE_PAYLOAD;
  piRuntimeLifecycle = options.piRuntimeLifecycle || new PiRuntimeLifecycle({
    dataDir: VARIN_DATA_DIR,
    createBroker: (brokerOptions) => createPiRuntimeBroker(brokerOptions),
    ...(options.hostEntry ? { hostEntry: options.hostEntry } : {}),
    ...(standalonePayloadDir
      ? {
          installer: {
            standalonePayloadDir,
          },
        }
      : {}),
  });
  const ownsPiRuntimeBroker = !options.piRuntimeBroker && !options.piRuntimeLifecycle;
  const piRuntimeBroker = options.piRuntimeBroker || piRuntimeLifecycle.asBroker();
  isPiSessionLive = async (sessionId) => (
    (await piRuntimeBroker.listSessions()).some((session) => session.id === sessionId)
  );
  if (options.piRuntimeBroker) {
    attachPiSessionExecutionAdmission(piRuntimeBroker, admitPiSessionExecution);
  }
  const getReadyPiRuntimeBroker = () => (
    options.piRuntimeBroker
    || (piRuntimeLifecycle?.currentBroker ? piRuntimeBroker : null)
  );
  const startPiRuntime = async () => {
    recordStartupPerformance('pi-runtime.warmup.start');
    try {
      piRuntimeHandshake = await piRuntimeLifecycle.start() ?? null;
      if (piRuntimeHandshake) {
        recordStartupPerformance('pi-runtime.warmup.ready');
        return;
      }
      if (requirePiRuntime) {
        recordStartupPerformance('pi-runtime.warmup.error');
        throw new Error('Pi runtime is not ready');
      }
    } catch (error) {
      recordStartupPerformance('pi-runtime.warmup.error');
      if (requirePiRuntime) throw error;
      console.warn('[PiRuntime] Deferred runtime start:', errorMessage(error));
    }
  };
  piRuntimeLifecycle.subscribe((snapshot) => {
    if (snapshot.status === 'ready') piRuntimeHandshake = piRuntimeLifecycle.handshake ?? piRuntimeHandshake;
  });
  if (!extensionRuntime) {
    extensionRuntime = await ApplicationExtensionRuntime.create({
      brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.resolve('@varin/extension-host'))),
      catalog: extensionCatalog,
      dataDir: VARIN_DATA_DIR,
      packages: extensionPackages,
      varinVersion: VARIN_VERSION,
    });
  }
  kernelClient = createKernelClient({
    hostId: extensionRuntime.services.hostId,
    storageRoot: path.join(VARIN_DATA_DIR, 'kernel', extensionRuntime.services.hostId),
    buildVersion: VARIN_VERSION,
    kernelBuildIdentity: VARIN_VERSION,
    onExit: (error) => console.error('[VarinKernel] Kernel process exited:', error.message),
  });
  await kernelClient.start();
  const sourceViewStorageRoot = path.join(VARIN_DATA_DIR, 'source-views');
  await fsPromises.mkdir(sourceViewStorageRoot, { recursive: true });
  const kernelSessionActors = new Map<string, { authorityInstanceId: string; sessionId: string; workerId: string; workerGeneration: number; runId?: string }>();
  const scopeDirectory = async (scopeId: string): Promise<string> => {
    if (isSessionScopeId(scopeId)) {
      const sessionId = sessionIdFromScopeId(scopeId);
      const summary = await piRuntimeBroker.requestForSession(sessionId, 'session.summary', { sessionId })
        .catch(async () => (await piRuntimeBroker.listSessions()).find(candidate => candidate.id === sessionId));
      if (!summary?.cwd) throw new Error(`Task session directory is unavailable: ${sessionId}`);
      return summary.cwd;
    }
    if (isBotScopeId(scopeId)) return botScopeRoot(scopeId);
    return (await documentsAuthority.inspectWorkspace(scopeId)).root;
  };
  const scopeDocumentWorkspace = async (scopeId: string): Promise<string> => isSessionScopeId(scopeId) || isBotScopeId(scopeId)
      ? (await documentsAuthority.resolveWorkspace({ path: await scopeDirectory(scopeId) })).workspaceId : scopeId;
  const kernelStorageAdapter = new KernelStorageAdapter({
    client: kernelClient,
    hostId: extensionRuntime.services.hostId,
    hostGeneration: `${extensionRuntime.services.hostId}:${process.pid}`,
    storageRoot: path.join(VARIN_DATA_DIR, 'kernel', extensionRuntime.services.hostId),
    resolveWorkspaceRoot: async (workspaceId) => workspaceId === SOURCE_VIEW_STORAGE_SCOPE
      ? sourceViewStorageRoot
      : scopeDirectory(workspaceId),
    resolveActor: async (workspaceId, purpose, hint) => {
      const maintenance = hint?.capabilities?.some((capability) => (
        capability === 'recovery.maintenance' || capability === 'storage.maintenance'
      ));
      if (maintenance) {
        if (hint?.owningWorkspace !== workspaceId) throw new Error(`Kernel maintenance identity does not own workspace ${workspaceId}`);
        return hint;
      }
      const sessionId = hint?.sessionId;
      if (!sessionId) throw new Error(`Kernel operation ${purpose} requires an exact session actor`);
      const actor = kernelSessionActors.get(sessionId);
      if (!actor) throw new Error(`Kernel actor session is not registered: ${sessionId}`);
      const resolved = await harnessSessionRegistration.resolveActor(actor).catch(() => null);
      if (!resolved?.workspaceId) throw new Error(`Kernel actor is stale: ${sessionId}`);
      const binding = await threadRegistry.getSessionBinding(sessionId).catch(() => null);
      const owningWorkspace = binding?.owningScopeId ?? resolved.workspaceId;
      if (owningWorkspace !== workspaceId) throw new Error(`Kernel actor ${sessionId} does not own workspace ${workspaceId}`);
      const threadId = binding?.threadId;
      const runId = actor.runId ?? binding?.runId;
      if (hint.threadId && hint.threadId !== threadId) throw new Error(`Kernel actor thread identity is stale: ${sessionId}`);
      if (hint.runId && hint.runId !== runId) throw new Error(`Kernel actor run identity is stale: ${sessionId}`);
      const executionRoot = (await documentsAuthority.inspectWorkspace(resolved.workspaceId)).root;
      const pathScopes = (resolved.workspaceScope?.length ? resolved.workspaceScope : ['']).map((scope) => {
        const relative = path.isAbsolute(scope) ? path.relative(executionRoot, scope) : scope;
        const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
        if (path.isAbsolute(relative) || normalized === '..' || normalized.startsWith('../')) {
          throw new Error(`Kernel actor scope is outside its execution workspace: ${scope}`);
        }
        return normalized;
      });
      return {
        authorityInstanceId: actor.authorityInstanceId,
        workerId: actor.workerId,
        workerGeneration: actor.workerGeneration,
        sessionId,
        ...(threadId ? { threadId } : {}),
        ...(runId ? { runId } : {}),
        owningWorkspace,
        executionWorkspace: resolved.workspaceId,
        pathScopes,
        capabilities: [...resolved.grantedCapabilities],
      };
    },
  });
  let resolveManagedContainer: ((directory: string, owningWorkspaceId: string) => Promise<{ workspaceId: string; canonicalRoot: string }>) | null = null;
  const resolveKernelExecutionRoot = async (canonicalRoot: string, owningWorkspaceId: string) => {
    try {
      const resolved = await documentsAuthority.resolveWorkspace({ path: canonicalRoot });
      const inspected = await documentsAuthority.inspectWorkspace(resolved.workspaceId);
      return { workspaceId: resolved.workspaceId, canonicalRoot: inspected.root };
    } catch (error) {
      if (!resolveManagedContainer) throw error;
      return resolveManagedContainer(canonicalRoot, owningWorkspaceId);
    }
  };
  kernelStorageAdapter.bindFileRootResolver(resolveKernelExecutionRoot);
  const kernelFileResources = new KernelFileResourceBackend(kernelStorageAdapter, {
    resolveExecutionRoot: resolveKernelExecutionRoot,
  });
  const kernelRecoveryFileResources = new KernelFileResourceBackend(kernelStorageAdapter, {
    resolveExecutionRoot: resolveKernelExecutionRoot,
    authorityPurpose: 'recovery-maintenance',
    authorityCapabilities: ['recovery.maintenance'],
  });
  const kernelPathLockService = new KernelPathLockService(kernelStorageAdapter, {
    resolveOwningWorkspaceId: async (sessionId, executionWorkspaceId) => {
      const binding = await threadRegistry.getSessionBinding(sessionId).catch(() => null);
      return binding?.owningScopeId ?? executionWorkspaceId;
    },
    resolveWorkspaceRoot: async (workspaceId) => (await documentsAuthority.inspectWorkspace(workspaceId)).root,
  });
  const kernelRecoveryContentStore = new KernelRecoveryContentStore(
    kernelStorageAdapter,
    kernelRecoveryFileResources,
  );
  kernelStorageAdapter.bindFileStore(kernelRecoveryContentStore);
  kernelStorageAdapter.bindFileResources(kernelFileResources);
  const kernelRecoveryStore = new KernelRecoveryStore(kernelStorageAdapter, kernelRecoveryContentStore);
  const workspaceConfig = createWorkspaceConfig({
    env: process.env,
    cwd: process.cwd(),
    pathModule: path,
    osModule: os,
  });
  const workspaceRootGuard = createDocumentRootGuard({
    fsPromises,
    pathModule: path,
    workspace: workspaceConfig,
  });
  const configuredDirtyBarrierTimeout = process.env.VARIN_DIRTY_BARRIER_TIMEOUT_MS?.trim() ?? '';
  const dirtyBarrierTimeoutMs = /^\d+$/.test(configuredDirtyBarrierTimeout)
    ? Number(configuredDirtyBarrierTimeout)
    : undefined;
  let observeKnowledgeDocumentMutation = (_event: DocumentMutationObservation): void => {};
  let observeThreadIntegrationParentChange = (_workspaceId: string, _resourceIds?: readonly string[]): void => {};
  const documentsAuthority = createDocumentAuthority({
    hostId: extensionRuntime.services.hostId,
    dataDir: VARIN_DATA_DIR,
    maxReadBytes: workspaceConfig.maxReadBytes,
    isAllowedRoot: workspaceRootGuard,
    isTrusted: workspaceRootGuard,
    onMutation: (event) => observeKnowledgeDocumentMutation(event),
    onIntegrationParentChanged: (workspaceId, resourceIds) => observeThreadIntegrationParentChange(workspaceId, resourceIds),
    ...(dirtyBarrierTimeoutMs !== undefined ? { dirtyBarrierTimeoutMs } : {}),
  });
  activeDocumentsAuthority = documentsAuthority;
  const harnessPathAuthority = createHarnessPathAuthority({
    authorityId: extensionRuntime.services.hostId,
    documents: documentsAuthority,
    fsPromises,
    pathModule: path,
    resolveInputPath: (actor, input, signal) => shellPathResolver(actor, input, signal),
  });
  piWriterTracker = createPiWorkspaceWriterTracker({ documents: documentsAuthority });
  const workspaceRecoveryEngines = new Map<string, WorkspaceRecoveryEngine>();
  const assertRecoverySessionWorkspace = async (sessionId: string, workspaceId: string): Promise<void> => {
    const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId });
    const authorityWorkspaceId = snapshot.workspace?.kind === 'workspace'
      ? snapshot.workspace.authorityId ?? snapshot.workspace.id
      : null;
    if (authorityWorkspaceId !== workspaceId) {
      throw new RecoveryPrimitiveError(
        'navigation-conflict',
        'The Pi session is no longer bound to the workspace selected for recovery',
        { details: { sessionId, workspaceId } },
      );
    }
  };
  const recoverySessionNavigation: RecoverySessionNavigation = {
    async commit(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.commit',
        {
          expectedLeafId: input.expectedLeafId,
          operationId: input.operationId,
          preparedTargetLeafId: input.preparedTargetLeafId,
          sessionId: input.sessionId,
          targetId: input.entryId,
        },
      );
    },
    async commitLeaf(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.commitLeaf',
        {
          expectedLeafId: input.expectedLeafId,
          operationId: input.operationId,
          preparedTargetLeafId: input.preparedTargetLeafId,
          sessionId: input.sessionId,
        },
      );
    },
    async prepare(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.prepare',
        { sessionId: input.sessionId, targetId: input.entryId },
      );
    },
    async prepareLeaf(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.prepareLeaf',
        { sessionId: input.sessionId, targetLeafId: input.targetLeafId },
      );
    },
  };
  const resolveDirectoryApplyContext = async (directory: string, owningWorkspaceId?: string) => {
    const resolved = await documentsAuthority.resolveWorkspace({ path: directory });
    return {
      workspaceId: resolved.workspaceId,
      resourceOperationGate: kernelRecoveryFileResources.gateFor({
        authorityId: extensionRuntime.services.hostId,
        canonicalRoot: directory,
        filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
        workspaceId: owningWorkspaceId ?? resolved.workspaceId,
      }),
    };
  };
  const recoveryEngineForOwner = (context: {
    owner?: { extensionId?: string | undefined } | undefined;
  }): WorkspaceRecoveryEngine => {
    const storageOwnerId = context?.owner?.extensionId;
    if (typeof storageOwnerId !== 'string' || !storageOwnerId) {
      throw new Error('Workspace recovery capability requires an extension owner');
    }
    let engine = workspaceRecoveryEngines.get(storageOwnerId);
    if (!engine) {
      engine = createWorkspaceRecoveryEngine({
        authorityId: extensionRuntime.services.hostId,
        dataDir: VARIN_DATA_DIR,
        documents: documentsAuthority,
        durableRecoveryStore: kernelRecoveryStore,
        sessionNavigation: recoverySessionNavigation,
        resolveDirectoryApplyContext,
        fileStore: kernelRecoveryContentStore,
      });
      engine = createKernelRecoveryDirectFacade(engine, kernelRecoveryStore, {
        authorityId: extensionRuntime.services.hostId,
        listWorkspaceRegistrations: () => documentsAuthority.listWorkspaceRegistrations(),
        resolveDirectoryApplyContext,
      });
      workspaceRecoveryEngines.set(storageOwnerId, engine);
    }
    return engine;
  };
  const foundationalRecoveryEngine = recoveryEngineForOwner({
    owner: { extensionId: 'varin.builtin.recovery' },
  });
  documentsAuthority.bindDurableMutationStorage((workspaceId, operation) => (
    foundationalRecoveryEngine.withWorkspaceStorage(
      workspaceId,
      { mode: 'exclusive', purpose: 'agent-mutation', create: true },
      (context) => operation(context),
    )
  ));
  let fencedRecoveryOperations = [];
  try {
    fencedRecoveryOperations = await foundationalRecoveryEngine.fenceUnfinishedOperations();
    await foundationalRecoveryEngine.resumeWorkspaceOperations();
  } catch (error) {
    console.error('[WorkspaceRecovery] Startup workspace recovery requires attention:', errorMessage(error));
  }
  const piRuntimeStartup = startPiRuntime();
  if (requirePiRuntime || fencedRecoveryOperations.length > 0) await piRuntimeStartup;
  else void piRuntimeStartup;
  const combinedRecoveryStartup = piRuntimeStartup.then(() => (
    foundationalRecoveryEngine.resumeCombinedOperations()
  )).catch((error) => {
    console.error('[WorkspaceRecovery] Startup combined recovery requires attention:', errorMessage(error));
  });
  if (fencedRecoveryOperations.length > 0) await combinedRecoveryStartup;
  else void combinedRecoveryStartup;
  extensionRuntime.workbench.setWorkspaceScopeResolver((scopeId: unknown) => documentsAuthority.resolveScopeId(scopeId));
  const kernelProcesses = createKernelProcessService({
    client: kernelClient,
    // Registry/admission are initialized before the first product process is
    // launched; keep that startup dependency explicit without creating a fake root.
    resolveIdentity: (cwd) => createKernelProcessIdentityResolver({
      documents: documentsAuthority,
      registry: threadRegistry,
      admitManaged: (directory, owner) => managedRootAdmission.materialization(directory, owner),
    })(cwd),
    onError: (error) => console.error("[VarinProcess]", error.message),
  });
  // Installation programs are Host-owned tooling. They receive only this
  // private resource root; editor/agent LSP processes still use their workspace.
  const languageToolProcesses = createKernelProcessService({
    client: kernelClient,
    resolveIdentity: async (cwd) => {
      const canonicalRoot = await canonicalizePathIdentity(path.join(VARIN_DATA_DIR, 'language-servers'));
      const canonicalCwd = await canonicalizePathIdentity(cwd);
      if (!isPathWithinRoot(canonicalCwd, canonicalRoot)) throw new Error('Language tool preparation escaped its private directory');
      const workspaceId = `language-tools:${extensionRuntime.services.hostId}`;
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
    },
  });
  // Tool downloads use the same Host proxy/system-network policy as other
  // outbound requests. The callback runs only when a provider is requested.
  const managedLanguageServers = createManagedLanguageServers({
    directory: VARIN_DATA_DIR, spawn: languageToolProcesses.spawn,
    fetch: (input, init) => egressRuntime.fetch(input, init),
  });
  const documentReadingDirectory = path.join(VARIN_DATA_DIR, 'document-reading');
  await fsPromises.mkdir(documentReadingDirectory, { recursive: true });
  const documentProcesses = createKernelProcessService({
    client: kernelClient,
    resolveIdentity: async (cwd) => {
      const canonicalRoot = await canonicalizePathIdentity(documentReadingDirectory);
      const canonicalCwd = await canonicalizePathIdentity(cwd);
      if (!isPathWithinRoot(canonicalCwd, canonicalRoot)) throw new Error('Document parser escaped its private directory');
      const workspaceId = `document-reading:${extensionRuntime.services.hostId}`;
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
    },
  });
  const managedLanguageProviders = new Map(managedLanguageServers.languageIds.map((languageId) => [`varin.managed.${languageId}`, languageId]));
  const languageSupervisor = createLanguageSupervisor({
    activateProviders: ({ languageId }) => extensionRuntime.activateForEvent('workspace-match', { languageId }),
    prepareProvider: (providerId, root, signal) => {
      const languageId = managedLanguageProviders.get(providerId);
      return languageId ? managedLanguageServers.ensure(languageId, root, signal) : Promise.resolve(null);
    },
    documents: documentsAuthority,
    spawn: kernelProcesses.spawn,
    pathModule: path,
    env: process.env,
    // Workspaces become executable only after their canonical root is an
    // explicit Varin project/directory grant. The same Host guard owns file
    // authority, so renderer or extension input cannot expand this boundary.
    isTrusted: workspaceRootGuard,
  });
  for (const [providerId, languageId] of managedLanguageProviders) {
    languageSupervisor.registerProvider({ providerId, command: providerId, languageIds: [languageId], source: 'builtin' });
  }
  const kernelCompute = createKernelComputeService({
    client: kernelClient,
    resolveIdentity: (cwd) => createKernelProcessIdentityResolver({
      documents: documentsAuthority, registry: threadRegistry,
      admitManaged: (directory, owner) => managedRootAdmission.materialization(directory, owner),
    })(cwd),
  });
  // Experiment/resource/source authority (7C/7D, D-300). The service grant is
  // Host-internal — the same trust level as the native process host — so a
  // detached reconciler can inspect, stop and collect jobs after restarts.
  const broadcastResearchFacts = (workspaceId: string, fact: 'attempt' | 'machine' | 'source' | 'followup') => {
    for (const client of uiVarinEventClients) {
      try {
        writeSseEvent(client, {
          type: 'varin:harness-experiment-changed',
          properties: { workspaceId, fact },
        });
      } catch {
        uiVarinEventClients.delete(client);
      }
    }
  };
  let managedRemoteTargets: ManagedRemoteTargetRegistry | null = null;
  const resourceService = createResourceService({
    client: kernelClient,
    onError: (error) => console.error("[VarinResource]", error.message),
    onChange: (workspaceId) => broadcastResearchFacts(workspaceId, 'machine'),
    onCapacityAvailable: (workspaceId) => experimentService.refreshQueue(workspaceId),
    refreshTargets: (workspaceId) => managedRemoteTargets?.refresh(workspaceId),
    resolveExternalAuthority: (machineId, machine) => managedRemoteTargets?.externalAuthority(machineId, machine) ?? null,
  });
  const managedRemoteExecution = createManagedRemoteExecutionService({
    client: kernelClient,
    hostId: extensionRuntime.services.hostId,
    resources: resourceService,
    onError: (error) => console.error("[VarinManagedRemote]", error.message),
  });
  managedRemoteTargets = createManagedRemoteTargetRegistry({
    coordinatorHostId: extensionRuntime.services.hostId,
    kernel: kernelClient,
    resources: resourceService,
    readSettings: async () => await readSettingsFromDisk() as unknown as Record<string, unknown>,
    // A reconnected target re-attaches to its durable jobs — the attempt
    // records already carry the backend job identity, so the experiment
    // reconcile inspects and re-polls rather than resubmitting.
    onTargetReachable: (workspaceId) => {
      void experimentService.ensureReconciled(workspaceId).catch((error: unknown) => {
        console.error("[VarinManagedTarget] Post-reconnect reconcile failed:", errorMessage(error));
      });
    },
    onError: (error) => console.error("[VarinManagedTarget]", error.message),
  });
  const sourceService = createSourceService({
    client: kernelClient,
    onChange: (workspaceId) => broadcastResearchFacts(workspaceId, 'source'),
  });
  const experimentService = createExperimentService({
    client: kernelClient,
    resources: resourceService,
    sources: sourceService,
    resolveWorkspaceRoot: async (workspaceId) => (await documentsAuthority.inspectWorkspace(workspaceId)).root,
    onError: (error) => console.error("[VarinExperiment]", error.message),
    onAttemptChanged: (workspaceId) => broadcastResearchFacts(workspaceId, 'attempt'),
    resolveBackend: (ctx, machineId, machine, caller) => managedRemoteTargets!.resolveBackend(ctx, machineId, machine, caller),
  });
  // Agent-facing settings authority (D-306). Reads/writes go through the real
  // owners — the app settings store and the Pi settings protocol — so the
  // catalog the agent sees is the same one the settings UI edits.
  const settingsActionRegistry = createSettingsActionRegistry({
    semanticIndex: () => semanticIndexManagement,
    requestWorkspace: (cwd, method, params) => piRuntimeBroker.requestForWorkspace(cwd, method as never, params as never),
    requestSession: (sessionId, method, params) => piRuntimeBroker.requestForSession(sessionId, method as never, params as never),
    resolveWorkspaceRoot: async (workspaceId) => (
      await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null)
    )?.root ?? null,
    extensionRuntime: () => extensionRuntime,
    tunnel: () => tunnelRuntimeContext?.tunnelService ?? null,
    remoteClients: () => remoteClientAuthRuntime,
    languageSupport: () => languageSupportRuntime,
    runtimeLifecycle: () => piRuntimeLifecycle,
    agentPersonalization: () => agentPersonalization,
    gitIdentities: gitIdentityStorage,
    surfaceHint: () => {
      const surfaces = clientSurfaceBridge.list();
      return surfaces.length === 1 ? surfaces[0]!.kind : null;
    },
    gitHubAuthStatus: async () => ({
      connected: Boolean(getGitHubAuth()?.accessToken),
      accounts: getGitHubAuthAccounts(),
      ghCli: {
        available: getGhCliToken() !== null,
        disabled: isGhCliDisabled(),
        active: isGhCliActive(),
      },
    }),
    readAppSettings: () => readSettingsFromDisk(),
    persistAppSettings: (changes, removals, expectedRevision) => settingsRuntime.persistSettingsCas(
      changes,
      removals,
      expectedRevision,
      settingsDocumentRevision,
    ),
  });
  const settingsActionOperations = createKernelSettingsActionOperationStore(kernelStorageAdapter);
  const settingsService = createSettingsService({
    readAppSettings: () => readSettingsFromDisk(),
    persistAppSettings: (changes, removals, expectedRevision) => settingsRuntime.persistSettingsCas(
      changes,
      removals,
      expectedRevision,
      settingsDocumentRevision,
    ),
    requestPi: (cwd, method, params) => piRuntimeBroker.requestForWorkspace(cwd, method, params as never),
    resolveWorkspaceRoot: async (workspaceId) => (
      await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null)
    )?.root ?? null,
    actions: settingsActionRegistry,
    actionOperations: settingsActionOperations,
    clientSurfaces: clientSurfaceBridge,
    resolveOptions: async (source, caller) => {
      if (source === 'thinking-levels') {
        return THINKING_LEVELS.map((level) => ({ value: level }));
      }
      if (source === 'models' && caller.workspaceId) {
        const root = await documentsAuthority.inspectWorkspace(caller.workspaceId).then((ws) => ws.root).catch(() => null);
        if (!root) return null;
        const models = await piRuntimeBroker.requestForWorkspace(root, 'model.list', {}).catch(() => null);
        return models?.filter((model) => model.available).map((model) => ({
          value: model.id,
          label: `${model.name} (${model.provider})`,
        })) ?? null;
      }
      return null;
    },
    onChanged: (change) => {
      for (const client of uiVarinEventClients) {
        try {
          writeSseEvent(client, {
            type: 'varin:settings-changed',
            properties: change,
          });
        } catch {
          uiVarinEventClients.delete(client);
        }
      }
    },
  });
  void managedRemoteExecution.reconcile().catch((error) => console.error("[VarinManagedRemote]", error.message));
  const workspaceContentSearch = createWorkspaceContentSearch({ documents: documentsAuthority, compute: kernelCompute });
  // ── Harness service host ──────────────────────────────────────────
  // Global services (output store, path locks, search, diagnostics) plus
  // per-session shell supervisors. Registered with the harness router
  // and wired into the broker event stream alongside the recovery turn
  // coordinator.

  // Web fetch service — SSRF-guarded, domain policy from workspace config
  const ssrfPolicy: SsrfPolicy = { check: options.desktopNetworkFetch ? checkDesktopHttpUrl : checkSsrf, isSameHost };
  // Single outbound egress authority: proxy/NO_PROXY policy + connect-path
  // SSRF classification shared by web.fetch and web.search providers.
  const egressRuntime = createEgressRuntime({
    allowLocalTargets: Boolean(options.desktopNetworkFetch),
    ...(options.desktopNetworkFetch ? { systemFetch: options.desktopNetworkFetch } : {}),
    getHostConfiguration: async () => {
      const document = await readSettingsFromDisk();
      const network = document.outboundNetwork as { mode?: unknown } | undefined;
      return readEgressHostConfiguration(document, network?.mode === 'proxy' ? readPiAuthFile() : {});
    },
  });
  registerEgressRoutes(app, {
    requireAuth: uiAuthController.requireAuth,
    readSettings: readSettingsFromDisk,
    readAuth: readPiAuthFile,
    saveAuth: savePiProviderAuth,
    removeAuth: removePiProviderAuth,
    egress: egressRuntime,
  });
  const retrievalEvidenceAccess: {
    persistReceipt?: (
      workspaceId: string,
      receipt: import('./lib/harness/web-fetch-receipt.js').WebFetchReceiptDraft,
      markdown: string,
    ) => Promise<import('@varin/protocol').RetrievalUrlReceipt>;
    syncThread?: (workspaceId: string, thread: import('@varin/protocol').Thread) => Promise<void>;
  } = {};
  // Deferred until the kernel working-state access exists below; fetches
  // still deliver content but mint no snapshotId if it is unavailable.
  const webMaterialAccess: { put?: WebMaterialStore['put']; read?: WebMaterialStore['read']; findAnalysis?: WebMaterialStore['findAnalysis']; findAnalysisConfig?: WebMaterialStore['findAnalysisConfig'] } = {};
  const materialStore: Pick<WebMaterialStore, 'put' | 'read' | 'findAnalysis' | 'findAnalysisConfig'> = {
    put: async (workspaceId, draft, body, authority, options) => {
      if (!webMaterialAccess.put) throw new Error('Durable material storage is unavailable');
      return webMaterialAccess.put(workspaceId, draft, body, authority, options);
    },
    read: async (workspaceId, snapshotId, authority, options) => (
      webMaterialAccess.read ? webMaterialAccess.read(workspaceId, snapshotId, authority, options) : null
    ),
    findAnalysis: (...args) => webMaterialAccess.findAnalysis ? webMaterialAccess.findAnalysis(...args) : Promise.resolve(null),
    findAnalysisConfig: (...args) => webMaterialAccess.findAnalysisConfig ? webMaterialAccess.findAnalysisConfig(...args) : Promise.resolve(null),
  };
  const documentReader = createDocumentReader({
    materials: materialStore,
    engineFactory: (settings) => createPdfEngine(settings, { spawn: documentProcesses.spawn, temporaryRoot: documentReadingDirectory }),
  });
  const webFetchService = createWebFetch({
    ssrf: ssrfPolicy,
    egress: egressRuntime,
    documentReader,
    ...(options.renderWebPage ? { renderer: options.renderWebPage } : {}),
    persistReceipt: async (workspaceId, receipt, markdown) => {
      if (!retrievalEvidenceAccess.persistReceipt) throw new Error('Durable web receipt storage is unavailable');
      return retrievalEvidenceAccess.persistReceipt(workspaceId, receipt, markdown);
    },
    materials: materialStore,
  });
  const webSearchService = createWebSearchService(
    async ({ sessionId }) => {
      const binding = harnessServiceHost.getWebBinding(sessionId);
      if (!binding) return { unavailable: true as const, hint: 'Web search session settings are unavailable' };
      if (binding.searchError) return { unavailable: true as const, hint: binding.searchError };
      const search = binding.settings?.search;
      return resolveConfiguredSearchProvider({
        settings: search,
        // Credential material is intentionally resolved live for every call.
        // Revocation makes an old frozen binding unavailable immediately.
        auth: search ? readPiAuthFile() : {},
        // Search providers share the host egress policy (proxy/NO_PROXY/SSRF).
        fetch: egressRuntime.fetch as typeof globalThis.fetch,
      });
    },
    async ({ sessionId }) => {
      const domains = harnessServiceHost.getWebBinding(sessionId)?.settings?.domains;
      return {
        ...(domains?.allow === undefined ? {} : { allow: [...domains.allow] }),
        block: [...(domains?.block ?? [])],
      };
    },
    // URL items share the exact web.fetch authority path: session binding,
    // domain policy, renderer entitlement, and receipt minting.
    {
      fetchUrl: (url, ctx) => performHarnessWebFetch(harnessServiceHost, { url }, ctx),
    },
  );
  // Scholarly APIs share the same egress authority — proxies and SSRF
  // classification apply identically to every outbound consumer.
  const researchSearchService = createResearchSearchService({ fetch: egressRuntime.fetch as typeof globalThis.fetch });
  // ── Phase 2: Knowledge store, memory agent, observers ────────────
  // Knowledge stores are opened lazily per workspace and cached.
  const knowledgeStores = new Map<string, KnowledgeStore>();
  const knowledgeStoreLoads = new Map<string, Promise<KnowledgeStore>>();
  let userKnowledgeStore: KnowledgeStore | null = null;
  let userKnowledgeStoreLoad: Promise<KnowledgeStore> | null = null;
  let knowledgeVectors: KnowledgeVectorRuntime | null = null;
  const hostId = extensionRuntime.services.hostId;
  let threadRuntime: ReturnType<typeof createThreadRuntime> | null = null;
  let bindThreadKnowledgeSession = (_sessionId: string, _workspaceId: string): void => undefined;
  const harnessShellActivity = {
    hasActiveCommandAtDirectory: (_directory: string): boolean => false,
    closeSessionShell: async (_sessionId: string): Promise<void> => {},
  };
  const sessionSnapshots = new Map<string, Record<string, unknown>>();
  const computerServiceRef: { current?: ReturnType<typeof createComputerService> } = {};
  const memoryOrganizerRef: { current?: ReturnType<typeof createMemoryOrganizer> } = {};
  const threadWaitRuntimeRef: { current?: ReturnType<typeof createThreadWaitRuntime> } = {};
  let botAdmissionReady = false;
  let botLifecycleRuntime: ReturnType<typeof createBotLifecycleRuntime> | null = null;
  const canExecuteBotScope = async (scopeId: string): Promise<boolean> => !isBotScopeId(scopeId)
    || (botAdmissionReady && await botService.canExecute(botIdFromScopeId(scopeId)));
  const threadRegistry = createThreadRegistry({
    dataDir: VARIN_DATA_DIR,
    hostId,
    canExecuteScope: canExecuteBotScope,
    onObserverError: (error) => {
      console.error('[HarnessThreads] Observer failed:', errorMessage(error));
    },
    onThreadChanged: (workspaceId, parent, thread, activeRun) => {
      threadWaitRuntimeRef.current?.observe(workspaceId, thread, activeRun);
      threadRuntime?.observeCodeSubmissions(workspaceId, thread);
      broadcastGlobalUiEvent?.({
        type: 'varin:harness-thread-changed',
        properties: { workspaceId, parent, thread, activeRun },
      });
      if (retrievalEvidenceAccess.syncThread) {
        void threadRegistry.getThreadById(workspaceId, thread.id).then((current) => (
          current ? retrievalEvidenceAccess.syncThread?.(workspaceId, current) : undefined
        )).catch((error) => {
          console.error('[HarnessThreads] Evidence ownership reconciliation failed:', errorMessage(error));
        });
      }
      if (thread.lifecycle === 'archived') {
        void followUpService.settleTarget(workspaceId, { kind: 'thread', id: thread.id }).catch((error: unknown) => {
          console.error('[VarinFollowUp] Archive settle failed:', errorMessage(error));
        });
      }
    },
    onThreadDone: (workspaceId, parent, threadId, report) => {
      broadcastGlobalUiEvent?.({
        type: 'varin:harness-thread-done',
        properties: { workspaceId, parent, threadId, report },
      });
      if (isBotScopeId(workspaceId)) memoryOrganizerRef.current?.noteScope(workspaceId);
    },
    onThreadReturned: (_scopeId, _parent, _threadId, run) => {
      void computerServiceRef.current?.finishExecution(run.id).catch(error => console.error('[Computer] Run cleanup failed:', errorMessage(error)));
    },

    onThreadDequeued: createOnThreadDequeued({
      getRegistry: () => threadRegistry,
      getRuntime: () => threadRuntime,
      formatError: errorMessage,
      onEndRunFailure: (_error, endError) => {
        console.error('[HarnessThreads] Failed to record dequeued thread failure:', errorMessage(endError));
      },
    }),
    onAdmissionFreed: (workspaceId, parent) => {
      // A freed shared-budget slot retries deferred work: lost-run resume
      // rechecks admission per Thread before starting anything (3.18C).
      void threadRuntime?.resumeLostForParent(workspaceId, parent).catch((error: unknown) => {
        console.error('[HarnessThreads] Lost-run resume after freed admission failed:', errorMessage(error));
      });
    },
    onThreadRemoved: (workspaceId, threadId) => (
      followUpService.settleTarget(workspaceId, { kind: 'thread', id: threadId })
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('[VarinFollowUp] Thread-removal settle failed:', errorMessage(error));
        })
    ),
  });
  const threadRegistryStartup = await threadRegistry.reconcileAfterHostRestart();
  for (const failure of threadRegistryStartup.failures) {
    console.error(`[HarnessThreads] Startup reconciliation failed (${failure.code}) for ${failure.path}: ${failure.message}`);
  }
  // BC0: durable Bot identity. The profile record lives in the kernel catalog;
  // the Bot's work is ordinary Threads under the `bot:<id>` owner scope, and
  // its entry chat is a real unbound Pi session anchored to a `bot-root` Thread.
  const botService = createBotService({
    client: kernelClient,
    hostId,
    dataDir: VARIN_DATA_DIR,
    registry: threadRegistry,
    lifecycle: () => {
      if (!botLifecycleRuntime) throw new Error('Bot lifecycle is not ready');
      return botLifecycleRuntime;
    },
    onChange: (bot) => broadcastGlobalUiEvent?.({ type: 'varin:bot-changed', properties: { botId: bot.id } }),
    onDeleted: (botId) => broadcastGlobalUiEvent?.({ type: 'varin:bot-changed', properties: { botId } }),
    removeData: createBotDataCleanup({
      dataDir: VARIN_DATA_DIR, hostId, registry: threadRegistry,
      deleteThread: (...args) => {
        if (!threadRuntime) throw new Error('Thread runtime is not ready');
        return threadRuntime.deleteUser(...args);
      },
      deleteSession: async (sessionId) => {
        const result = await piRuntimeBroker.deleteSession(sessionId);
        broadcastGlobalUiEvent?.({ type: 'varin:session-deleted', properties: { sessionId } });
        return result;
      },
      releaseRemoteScope: (scopeId) => managedRemoteTargets.releaseScope(scopeId),
      closeMemory: async (scopeId, storeKey) => {
        await knowledgeVectors?.releaseScope('bot', scopeId);
        const loading = knowledgeStoreLoads.get(storeKey);
        if (loading) await Promise.allSettled([loading]);
        await knowledgeStores.get(storeKey)?.close();
        knowledgeStores.delete(storeKey);
      },
      files: new KernelFileResourceBackend(kernelStorageAdapter, { authorityPurpose: 'bot-data-cleanup' }),
    }),
    createSession: (input) => piRuntimeBroker.createSession(
      input.cwd,
      input.name,
      undefined,
      { kind: 'unbound' },
      input.model ? { model: input.model } : undefined,
    ),
    openSession: (input) => piRuntimeBroker.openSession({ ...input, workspace: { kind: 'unbound' } }),
    applyModel: async (input) => {
      if (!input.model) {
        await piRuntimeBroker.requestForSession(input.sessionId, 'model.resetDefault', { sessionId: input.sessionId });
        return;
      }
      await piRuntimeBroker.requestForSession(input.sessionId, 'model.select', {
        sessionId: input.sessionId,
        provider: input.model.providerId,
        modelId: input.model.modelId,
      });
    },
    applyInstructions: async (input) => {
      await piRuntimeBroker.requestForSession(input.sessionId, 'session.instructions.apply', input);
    },
    onError: (error) => {
      console.error('[VarinBots]', errorMessage(error));
    },
  });
  botAdmissionReady = true;
  assertBotSessionExecution = async (sessionId) => {
    const entry = await botService.botForSession(sessionId);
    const owner = entry ? null : await threadRegistry.resolveSessionOwner(sessionId);
    if ((entry && !await botService.canExecute(entry.id)) || (owner && !await canExecuteBotScope(owner.owningScopeId))) {
      throw new PiRuntimeBrokerError('runtime_not_ready', 'This Bot is asleep or changing state. Wake it before continuing.', { retryable: true });
    }
  };
  const botScopeRoot = async (scopeId: string): Promise<string> => {
    const bot = await botService.get(botIdFromScopeId(scopeId));
    if (!bot) throw new Error(`Unknown Bot scope: ${scopeId}`);
    return bot.homeDir;
  };
  // BC4: Computer Use catalog + supervised native drivers. Observation and
  // input run through one service shared by Bots, ordinary workbench agents,
  // and the settings surface; the persisted default target lives under the
  // Host data dir.
  const connections = new HostSshManager({
    settingsFilePath: path.join(VARIN_DATA_DIR, 'settings.json'),
    appVersion: VARIN_VERSION,
    emit: (event, detail) => {
      broadcastGlobalUiEvent?.({ type: event, properties: { ...detail } });
      options.onConnectionStatus?.(detail);
    },
  });
  const vmGuestRegistration = createVmGuestRegistration({
    readSettings: async () => await readSettingsFromDisk() as Record<string, unknown>,
    updateSettings: (mutator) => updateSettingsOnDisk((current) => mutator(current as Record<string, unknown>) as typeof current),
  });
  const desktopControlHolder = `desktop:${hostId}`;
  const computerService = createComputerService({
    localControlHolder: options.onComputerControlsReady ? desktopControlHolder : undefined,
    resolveActor: (sessionId) => resolveComputerActor(threadRegistry, sessionId),
    bindDesktop: (actor, desktopId) => threadRegistry.setThreadEnvironment(actor.scopeId, actor.threadId, { desktopId }).then(() => {}),
    revokeSession: (actor) => piRuntimeBroker.requestForSession(actor.sessionId, 'session.computer.cancel', { sessionId: actor.sessionId, runId: actor.runId }).then(() => {}),
    notifyActor: async (actor, text, wake, id) => {
      await piRuntimeBroker.requestForSession(actor.sessionId, wake ? 'agent.threadRequest' : 'agent.notify', { sessionId: actor.sessionId, messageId: `computer:${id}`, text });
    },
    onAutomationChange: (state) => {
      // A previous Run can finish releasing input after the next one has started. Project the
      // registry's current root execution, never publish that old cleanup as the new round's state.
      void computerServiceRef.current?.automation.snapshot(state.rootSessionId).then(current => {
        broadcastGlobalUiEvent?.({ type: 'varin:computer-automation', properties: current });
      }).catch(error => console.error('[Computer] State projection failed:', errorMessage(error)));
    },
    onActivityChange: (entry) => broadcastGlobalUiEvent?.({ type: 'varin:computer-activity', properties: entry }),
    onGesture: (gesture, localConsole) => { if (localConsole) options.onComputerGesture?.(gesture); },
    onControlChange: control => options.onComputerControl?.(control),
    controlWindows: options.computerControlWindows,
    client: kernelClient,
    hostId,
    dataDir: VARIN_DATA_DIR,
    appVersion: VARIN_VERSION,
    registerVmGuest: vmGuestRegistration.register,
    removeVmGuest: vmGuestRegistration.remove,
    resolveWork: async (sessionId) => {
      const owner = await threadRegistry.resolveSessionOwner(sessionId);
      return owner ? { scopeId: owner.owningScopeId, threadId: owner.threadId } : null;
    },
    onHandback: async (event) => {
      await createFollowUpThreadSender({
        registry: threadRegistry,
        continueRun: (input) => threadRuntime!.continueRun(input),
        sendToSession: (sessionId, message, meta) => threadRuntime!.send(sessionId, message, meta),
      })({
        scopeId: event.scopeId, threadId: event.threadId,
        requestId: event.id, from: { kind: 'user', id: `desktop:${event.desktopId}` },
        text: `Human returned control of desktop "${event.label}" (${event.desktopId}) at ${event.at}. Inspect the current desktop state before continuing; the human may have changed files or applications while holding control.`,
      });
      await computerService.automation.notifyHandoff(event.actor, `The user returned control of desktop "${event.label}". The assigned worker can observe the current scene and continue.`, `handback:${event.id}`, [event.actor.sessionId]);
    },
    // BC6: remote desktops are served by the same `desktopHosts` connection
    // settings managed-remote resolves — apiUrl + clientToken authenticate
    // Host-to-Host computer calls; no local credentials cross the wire.
    remoteHosts: async () => configuredHosts(await readSettingsFromDisk() as unknown as Record<string, unknown>),
    // BC7: `computerVmProviders` settings entries configure libvirt targets
    // (qemu:///system or qemu+ssh://…); virsh auth stays in the environment.
    vmProviders: async () => configuredVmProviders(await readSettingsFromDisk() as unknown as Record<string, unknown>),
  });
  computerServiceRef.current = computerService;
  void computerService.defaultDesktop().then(id => id ? computerService.prewarm(id) : undefined)
    .catch(error => console.error('[Computer] Desktop preparation failed:', errorMessage(error)));
  options.onComputerControlsReady?.({
    holderId: desktopControlHolder,
    takeover: async () => { await computerService.takeover({ desktopId: 'local-console', holderId: desktopControlHolder }); },
    handback: async () => { await computerService.handback({ desktopId: 'local-console', holderId: desktopControlHolder }); },
    cancel: async () => {
      await computerService.automation.cancelDesktop('local-console');
    },
  });
  // BC1: unified memory domain. The same service backs the harness memory.*
  // methods, the UI routes, and later the background organizer — one writer
  // semantics for accepted/suggested, dedupe, correction, and forgetting.
  const memoryService = createMemoryService({
    storeForScopeId: getKnowledgeStoreForScope,
    userStore: getUserKnowledgeStore,
    sessionStoreIfPresent: async (sessionId) => await knowledgeStoreExistsForScope(sessionScopeId(sessionId))
      ? getKnowledgeStoreForScope(sessionScopeId(sessionId)) : null,
    ownerForSession: async (sessionId) => {
      const scopeId = await owningKnowledgeScopeIdForSession(sessionId) ?? sessionScopeId(sessionId);
      if (isBotScopeId(scopeId)) return { scope: 'bot', ownerId: botIdFromScopeId(scopeId) };
      if (isSessionScopeId(scopeId)) return { scope: 'session', ownerId: sessionIdFromScopeId(scopeId) };
      return { scope: 'workspace', ownerId: scopeId };
    },
    vectors: () => knowledgeVectors,
    associationForSession: (sessionId) => workAssociationForSession(sessionId),
    readSessionEntries: async (sessionId, scope) => (await piRuntimeBroker.previewSessionEntries(sessionId, undefined, scope)).entries,
    readRunReport: async (scopeId, threadId, runId) => {
      const run = (await threadRegistry.listRuns(scopeId, threadId)).find((run) => run.id === runId);
      if (!run?.report) return null;
      return [run.report.conclusion, run.report.unresolved.length ? `Unresolved: ${run.report.unresolved.join('; ')}` : ''].filter(Boolean).join('\n\n');
    },
    onChanged: (owner, ids) => {
      broadcastGlobalUiEvent?.({
        type: 'varin:harness-knowledge-changed',
        properties: {
          scope: owner.scope,
          ...(owner.ownerId ? { workspaceId: owner.scope === 'bot' ? botScopeId(owner.ownerId) : owner.ownerId } : {}),
          ids: [...ids],
        },
      });
    },
    onError: (error) => console.error('[VarinMemory]', errorMessage(error)),
  });
  let personalizationRuntime: AgentRuntimeClient | undefined = undefined;
  const agentPersonalization = createAgentPersonalization({
    client: kernelClient,
    context: createPersonalizationContextResolver({ runtime: () => personalizationRuntime, legacy: async (sessionId) => {
      const binding = await threadRegistry.getSessionBinding(sessionId);
      const thread = binding?.owner === 'spawned-child' ? await threadRegistry.getThreadById(binding.owningScopeId, binding.threadId) : null;
      if (binding?.owner === 'spawned-child' && !thread) throw new Error('The session thread configuration is unavailable');
      const threadRole = binding?.owner !== 'spawned-child' ? 'main' as const
        : thread?.preset === 'retrieval' || thread?.kind === 'discussion' ? 'read-only' as const : 'worker' as const;
      const scopeId = await owningKnowledgeScopeIdForSession(sessionId);
      if (scopeId && isBotScopeId(scopeId)) return { bot: true, threadRole };
      const snapshot = sessionSnapshots.get(sessionId);
      const cwd = typeof snapshot?.cwd === 'string' ? snapshot.cwd : '';
      const projects = sanitizeProjects((await readSettingsFromDisk()).projects) ?? [];
      const project = projects.find(entry => cwd && projectContainsPath(entry, cwd));
      return { bot: false, threadRole, ...(project ? { projectId: project.id } : {}) };
    } }),
    onChanged: () => {
      broadcastGlobalUiEvent?.({ type: 'varin:agent-personalization-changed', properties: {} });
      void refreshThreadPersonalization().catch(() => console.error('[Thread] Personalization refresh requires attention'));
    },
  });
  // Bot background memory organizer reads durable session/run sources.
  // filters them with the memory-organization fast decision when bound, and
  // narrates proposals through the models.memoryOrganizer slot on the shared
  // workspace worker. All commits go through memoryService, so inferred output
  // keeps suggested/accepted semantics, dedupe, and correction CAS.
  const memoryOrganizer = createMemoryOrganizer({
    configCwd: VARIN_DATA_DIR,
    getBroker: getReadyPiRuntimeBroker,
    storeForScopeId: getKnowledgeStoreForScope,
    hasStoreForScope: async (scopeId) => {
      const storePath = path.join(VARIN_DATA_DIR, 'knowledge', hostId, `${knowledgeStoreKeyForScope(scopeId)}.tdb`);
      return fsPromises.access(storePath).then(() => true, () => false);
    },
    listScopeIds: async () => {
      return (await botService.list()).map((bot) => botScopeId(bot.id)).sort();
    },
    listScopeSessions: async (scopeId) => {
      const threads = await threadRegistry.listWorkspaceThreads(scopeId);
      const ids = new Set<string>();
      for (const thread of threads) {
        for (const run of await threadRegistry.listRuns(scopeId, thread.id)) {
          if (run.sessionId) ids.add(run.sessionId);
        }
      }
      return [...ids];
    },
    listRunSources: async (scopeId) => {
      const threads = await threadRegistry.listWorkspaceThreads(scopeId);
      const sources: OrganizerRunSource[] = [];
      for (const thread of threads) {
        for (const run of await threadRegistry.listRuns(scopeId, thread.id)) {
          if (!run.report) continue;
          const report = run.report;
          const unresolved = report.unresolved.length > 0 ? `Unresolved: ${report.unresolved.join('; ')}` : '';
          sources.push({
            threadId: thread.id,
            threadTitle: thread.brief || thread.id,
            runId: run.id,
            sessionId: run.sessionId,
            reportText: [report.conclusion, unresolved].filter(Boolean).join('\n\n'),
            endedAt: run.endedAt,
          });
        }
      }
      return sources;
    },
    scopeForSession: async (sessionId) => {
      const scope = await owningKnowledgeScopeIdForSession(sessionId);
      return scope && isBotScopeId(scope) ? scope : null;
    },
    canExecuteScope: canExecuteBotScope,
    // A Bot scope with no dedicated organizer slot inherits the Bot's own
    // model — Bot memory keeps organizing without a second configuration.
    organizerModelForScope: async (scopeId) => {
      if (!isBotScopeId(scopeId)) return null;
      const bot = await botService.get(botIdFromScopeId(scopeId));
      if (!bot || bot.archived) return null;
      if (bot.model) return bot.model;
      if (!bot.entrySessionId) return null;
      // An unset preference inherits the Bot entry's actual Pi selection,
      // including Pi's default. It must not disable background memory or borrow
      // whichever unrelated chat happens to be live.
      const liveModel = recordOf(sessionSnapshots.get(bot.entrySessionId)?.model);
      if (typeof liveModel.provider === 'string' && typeof liveModel.id === 'string') {
        return { providerId: liveModel.provider, modelId: liveModel.id };
      }
      const entries = (await piRuntimeBroker.previewSessionEntries(bot.entrySessionId, bot.homeDir, 'branch')).entries;
      const selected = entries.findLast((entry) => entry.type === 'model_change');
      return selected?.type === 'model_change' ? { providerId: selected.provider, modelId: selected.modelId } : null;
    },
    readEntries: async (sessionId) => (
      (await piRuntimeBroker.previewSessionEntries(sessionId, undefined, 'all')).entries
    ),
    memory: memoryService,
    onError: (error) => console.error('[VarinMemoryOrganizer]', errorMessage(error)),
  });
  memoryOrganizerRef.current = memoryOrganizer;
  const threadTranscriptReader = createThreadTranscriptReader({
    readSessionEntries: (sessionId) => piRuntimeBroker.previewSessionEntries(sessionId, undefined, 'all'),
  });
  const threadWorktreeRuntime = createThreadWorktreeRuntime({
    spawnProcess: kernelProcesses.spawn,
    authorizeManagedRoot: async (candidate) => {
      const normalize = (value: string) => {
        const resolved = path.resolve(value).replace(/\\/g, '/');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      const canonical = async (value: string) => normalize(await fs.promises.realpath(value).catch(() => path.resolve(value)));
      const observed = await canonical(candidate);
      for (const rootName of ['worktrees', 'thread-scratch']) {
        const applicationRoot = await canonical(path.join(VARIN_DATA_DIR, rootName));
        const applicationRelative = path.relative(applicationRoot, observed);
        if (applicationRelative
          && !applicationRelative.startsWith('..')
          && !path.isAbsolute(applicationRelative)
          && applicationRelative.split(/[\\/]/).filter(Boolean).length === 1) {
          return true;
        }
      }
      if (path.basename(observed).toLowerCase() !== 'worktrees'
        || path.basename(path.dirname(observed)).toLowerCase() !== '.varin') return false;
      const workspaceRoot = path.dirname(path.dirname(observed));
      try {
        const identity = await documentsAuthority.resolveWorkspace({ path: workspaceRoot });
        const inspected = await documentsAuthority.inspectWorkspace(identity.workspaceId);
        return await canonical(inspected.root) === await canonical(workspaceRoot);
      } catch {
        return false;
      }
    },
    removeManagedPath: async ({ workspaceId, managedRoot, path: targetPath, operationId }) => {
      const relative = path.relative(managedRoot, targetPath).replace(/\\/g, '/');
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error(`Managed directory removal escaped its ownership root: ${targetPath}`);
      }
      const identity = {
        authorityId: extensionRuntime.services.hostId,
        canonicalRoot: managedRoot,
        filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
        workspaceId,
      };
      await kernelFileResources.gateFor(identity).run(
        [{ resourceId: relative, scope: 'subtree' }],
        () => kernelFileResources.remove(identity, relative, {
          recursive: true,
          force: true,
          operationId,
        }),
      );
    },
    createScratch: async (sourceRoot, threadId) => {
      const workspaceKey = crypto.createHash('sha256').update(path.resolve(sourceRoot)).digest('hex');
      const managedRoot = path.join(VARIN_DATA_DIR, 'thread-scratch', workspaceKey);
      await fs.promises.mkdir(managedRoot, { recursive: true });
      return { path: path.join(managedRoot, threadId), managedRoot };
    },
    createWorktree: async (directory, input) => {
      const git = await import('./lib/git/service.js');
      return git.createWorktree(directory, input, {
        documents: documentsAuthority,
        writerOwner: { kind: 'harness-thread', id: `create:${String(input.worktreeName ?? 'thread')}` },
      });
    },
    getWorktreeBootstrapStatus: async (directory) => {
      const git = await import('./lib/git/service.js');
      return git.getWorktreeBootstrapStatus(directory);
    },
    gitBinary: platformEnvironmentRuntime.resolveGitBinaryForSpawn(),
    env: {
      ...process.env,
      PATH: platformEnvironmentRuntime.buildAugmentedPath(),
    },
  });
  const managedRootAdmission = createManagedRootAdmission({
    listWorktrees: async (workspaceId) => (await threadRegistry.listWorkspaceThreadSnapshots(workspaceId))
      .flatMap(({ thread }) => thread.worktree ? [thread.worktree] : []),
    assertOwnership: (worktree, operation, candidates) => threadWorktreeRuntime.assertOwnership(worktree, operation, candidates),
  });
  kernelStorageAdapter.bindManagedRootResolver(managedRootAdmission.materialization);
  resolveManagedContainer = managedRootAdmission.container;
  const branchEntryIdsForSession = async (sessionId: string): Promise<string[]> => {
    const branch = await piRuntimeBroker.requestForSession(sessionId, 'session.entries', {
      sessionId,
      scope: 'branch',
    });
    return branch.entries.map((entry) => entry.id);
  };
  const harnessWorkingStates = createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter, foundationalRecoveryEngine, kernelRecoveryStore, scopeDocumentWorkspace);
  // Source views own private kernel records, not user workspace recovery or disk mutations.
  const sourceViews = createSourceViewStore(createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter));
  const retrievalArtifacts = createRetrievalArtifactAccess(harnessWorkingStates);
  const webMaterials = createWebMaterialStore(harnessWorkingStates);
  webMaterialAccess.put = webMaterials.put;
  webMaterialAccess.read = webMaterials.read;
  webMaterialAccess.findAnalysis = webMaterials.findAnalysis;
  webMaterialAccess.findAnalysisConfig = webMaterials.findAnalysisConfig;
  const materialCollectionsService = createMaterialCollectionsService(harnessWorkingStates, {
    materials: webMaterials,
    // URL members go through the full web.fetch path: session binding,
    // domain policy, renderer entitlement, and receipt authority.
    fetchUrl: (params, ctx) => performHarnessWebFetch(harnessServiceHost, params, ctx),
    resolveThreadId: async (sessionId) => {
      const binding = await threadRegistry.getSessionBinding(sessionId);
      return binding?.threadId;
    },
    // Same reachability rule as thread.send: parent, child, or same-parent
    // sibling inside the caller's root-task family.
    threadsRelated: async (fromThreadId, toThreadId, workspaceId) => {
      const from = await threadRegistry.getThreadById(workspaceId, fromThreadId);
      const to = await threadRegistry.getThreadById(workspaceId, toThreadId);
      if (!from || !to) return false;
      return (to.parent.kind === "thread" && to.parent.id === from.id)
        || (from.parent.kind === "thread" && from.parent.id === to.id)
        || (to.parent.kind === from.parent.kind && to.parent.id === from.parent.id);
    },
  });
  // Fast-decision deps are bound after the semantic runtime exists; the
  // service reads them at call time so an unconfigured purpose reports
  // honestly instead of being absent.
  const researchDecideDeps: ResearchDecideDeps = {
    materials: webMaterials,
    resolveThreadId: async (sessionId) => {
      const binding = await threadRegistry.getSessionBinding(sessionId);
      return binding?.threadId;
    },
  };
  const researchDecideService = createResearchDecideService(researchDecideDeps);
  retrievalEvidenceAccess.persistReceipt = retrievalArtifacts.persistReceipt;
  retrievalEvidenceAccess.syncThread = retrievalArtifacts.syncThreadEvidence;
  const retainedSourceViewIds = new Set<string>();
  for (const workspaceId of await threadRegistry.listWorkspaceIds()) {
    const workspaceThreads = await threadRegistry.listWorkspaceThreads(workspaceId);
    for (const thread of workspaceThreads) if (thread.manifest.sourceViewId) retainedSourceViewIds.add(thread.manifest.sourceViewId);
    await harnessWorkingStates.withBranchStore(
      workspaceId,
      'startup-branch-integration-reconcile',
      (store, context) => {
        if (!context) throw new Error('Working-state root context is unavailable');
        if (!context.durableRecoveryStore) throw new Error('Durable recovery operation storage is unavailable');
        return reconcileInterruptedKernelBranchIntegrations({ ...context, durableRecoveryStore: context.durableRecoveryStore }, store);
      },
      'exclusive',
    );
    await retrievalArtifacts.reconcileWorkspaceEvidence(
      workspaceId,
      workspaceThreads,
    );
  }
  await sourceViews.reconcile(retainedSourceViewIds);
  const threadExecutionViews = new ThreadExecutionViewRegistry();
  const virtualWriteGate = new VirtualWriteGate();
  const workingBranchLookups = createWorkingBranchLookups({
    views: threadExecutionViews,
    workingStates: harnessWorkingStates,
  });
  const workingBranchWrites = createWorkingBranchWriteServices({
    views: threadExecutionViews,
    workingStates: harnessWorkingStates,
    writeGate: virtualWriteGate,
  });
  const sourceViewRuntime = createSourceViewRuntime({
    documents: documentsAuthority,
    registry: threadRegistry,
    views: threadExecutionViews,
    branchLookups: workingBranchLookups,
    branchWrites: workingBranchWrites,
    worktrees: threadWorktreeRuntime,
    sourceViews,
    materializeExecutionView: (sessionId, signal) => threadRuntime!.materializeExecutionView(sessionId, signal),
  });
  const verificationCoordinator = createVerificationCoordinator({
    workingStates: harnessWorkingStates,
    captureParentIdentity: async (workspaceId, parentRoot) => {
      const inspected = await threadWorktreeRuntime.inspectWorkspaceIdentity(parentRoot);
      if (inspected.status !== 'ready') return { treeHash: null, reason: inspected.reason };
      const treeHash = await harnessWorkingStates.withBranchStore(
        workspaceId,
        'parent-command-input-identity',
        (store) => store.captureSeededPathIdentity(parentRoot, inspected.changedFiles, inspected.baseRef),
        'shared',
      );
      return { treeHash };
    },
    loadParentWindows: async (workspaceId, parentSessionId) => {
      const binding = await threadRegistry.getSessionBinding(parentSessionId);
      const owningWorkspaceId = binding?.owningScopeId ?? workspaceId;
      const parent = binding
        ? { kind: 'thread' as const, id: binding.threadId }
        : { kind: 'session' as const, id: parentSessionId };
      const children = await threadRegistry.listThreads(owningWorkspaceId, parent, true);
      return harnessWorkingStates.withBranchStore(
        owningWorkspaceId,
        'parent-verification-window-restore',
        async (store) => (await Promise.all(children.map(async (thread) => (
          (await store.listParentVerifications(thread.id)).map((bundle) => ({ parent, threadId: thread.id, bundle }))
        )))).flat(),
        'shared',
      );
    },
    onProjection: (workspaceId, threadId, projection) => threadRegistry.setVerification(workspaceId, threadId, projection).then(() => undefined),
  });
  const threadIntegrationCoordinator = new IntegrationCoordinator({
    resolveDocumentWorkspaceId: scopeDocumentWorkspace,
    workingStates: harnessWorkingStates,
    inspectDirtyBuffers: (workspaceId) => documentsAuthority.inspectDirtyBuffers(workspaceId),
    beginDirtyStateBarrier: (workspaceId, paths) => documentsAuthority.beginDirtyStateBarrier(workspaceId, paths),
    requestSurfaceOperation: (request, options) => documentsAuthority.requestSurfaceOperation(request, options),
    resolveDirectoryApplyContext,
    holdParentVirtualWrite: async (sessionId, signal) => {
      const ticket = await acquireVirtualWriteTicket(
        virtualWriteGate,
        sessionId,
        () => {
          const view = threadExecutionViews.get(sessionId);
          return !!view && view.mode === 'virtual';
        },
        signal,
      );
      return ticket === 'disk'
        ? { status: 'disk' as const }
        : { status: 'virtual' as const, release: () => ticket.finish() };
    },
    resolveParentSessionId: (workspaceId, branchId) => (
      threadExecutionViews.findByBranch(workspaceId, branchId)?.sessionId
    ),
    commitParentVirtualWrites: async (input) => {
      const result = await input.store.commitVirtualWrites(
        input.branchId,
        input.expectedWriteRevision,
        input.files,
      );
      const sessionId = input.sessionId
        ?? threadExecutionViews.findByBranch(input.workspaceId, input.branchId)?.sessionId;
      if (result.status === 'committed' && sessionId) {
        const live = threadExecutionViews.get(sessionId);
        if (live?.mode === 'virtual') {
          threadExecutionViews.bind({ ...live, writeRevision: result.writeRevision });
        }
      }
      return result;
    },
  });
  threadRuntime = createThreadRuntime({
    registry: threadRegistry,
    stopExperimentsForThread: (workspaceId, threadId) => experimentService.stopForThreads(workspaceId, [threadId]),
    deleteSession: (sessionId) => piRuntimeBroker.deleteSession(sessionId),
    deleteKnowledgeSession: async (workspaceId, sessionId) => {
      // Delete the session's event/block/session knowledge nodes through the
      // existing KnowledgeStore.deleteSession (D-242 rework). Accepted
      // workspace/user knowledge is retained.
      const store = knowledgeStores.get(knowledgeStoreKeyForScope(workspaceId)) ?? null;
      if (store) await store.deleteSession(sessionId);
    },
    releaseThreadEvidence: (workspaceId, threadId) => retrievalArtifacts.releaseThreadEvidence(workspaceId, threadId),
    onThreadSessionBound: (sessionId, owningWorkspaceId) => bindThreadKnowledgeSession(sessionId, owningWorkspaceId),
    worktrees: threadWorktreeRuntime,
    workingStates: harnessWorkingStates,
    executionViews: threadExecutionViews,
    virtualWriteGate,
    measureManagedDirectory: async (workspaceId, worktree) => {
      if (!worktree.managedRoot) {
        return { logicalBytes: null, allocatedBytes: null, unknown: true };
      }
      const relative = path.relative(worktree.managedRoot, worktree.path).replace(/\\/g, '/');
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        return { logicalBytes: null, allocatedBytes: null, unknown: true };
      }
      return kernelFileResources.measure({
        authorityId: extensionRuntime.services.hostId,
        canonicalRoot: worktree.managedRoot,
        filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
        workspaceId,
      }, relative);
    },
    cloneAgentInputSnapshot: (sessionId, context) => documentsAuthority.cloneAgentInputSnapshot(sessionId, context),
    agentInputSurfaceOwner: (sessionId, context, workspaceId) => documentsAuthority.agentInputSurfaceOwner(sessionId, context, workspaceId),
    sourceViews,
    resolveIntegrationCoordinator: () => threadIntegrationCoordinator,
    canReclaimWorktree: createWorktreeReclaimGuard(documentsAuthority),
    resolveBaselineApplyContext: resolveDirectoryApplyContext,
    hasActiveCommands: (directory) => harnessShellActivity.hasActiveCommandAtDirectory(directory),
    verification: verificationCoordinator,
    worktreeSettings: DEFAULT_HARNESS_SETTINGS.worktree,
    resolveWorktreeSettings: async (workspaceId, parent) => {
      // Bot deletion closes every parent session. Cleanup accounting must not reopen one for display settings.
      if (isBotScopeId(workspaceId) && (await botService.get(botIdFromScopeId(workspaceId)))?.deletion) {
        return DEFAULT_HARNESS_SETTINGS.worktree;
      }
      const sessionId = parent.kind === 'session'
        ? parent.id
        : (await threadRegistry.getActiveRun(workspaceId, parent.id))?.sessionId;
      if (!sessionId) throw new Error('Parent thread has no Pi session for worktree settings');
      return resolveThreadWorktreeSettings(await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {}));
    },
    // A `bot:` scope's working root is the Bot's durable home directory —
    // there is no registered project workspace behind it.
    resolveWorkspaceRoot: scopeDirectory,
    resolveRuntimeWorkspaceId: async (cwd) => (await documentsAuthority.resolveWorkspace({ path: cwd })).workspaceId,
    beginBaselineCapture: (workspaceId, ignoredWriterIds, signal) => documentsAuthority.beginCapture(workspaceId, { ignoredWriterIds }, signal),
    completeBaselineCapture: async (capture, signal) => {
      const completed = await documentsAuthority.completeCapture(capture, signal);
      return { stable: completed.stable, reasons: completed.reasons };
    },
    beginDirtyStateBarrier: (workspaceId, paths, signal) => documentsAuthority.beginDirtyStateBarrier(workspaceId, paths, { signal }),
    inspectBaselineWriters: async (workspaceId, root) => {
      const writersOf = async (id: string) => {
        const inspected = await documentsAuthority.inspectWorkspace(id) as {
          activeWriters?: Array<{ writerId?: string; id?: string; purpose?: string; owner?: { kind: string; id: string }; startedAt?: string }>;
        };
        return Array.isArray(inspected.activeWriters) ? inspected.activeWriters : [];
      };
      const writers = [...await writersOf(workspaceId)];
      try {
        const resolved = await documentsAuthority.resolveWorkspace({ path: root });
        if (resolved.workspaceId !== workspaceId) writers.push(...await writersOf(resolved.workspaceId));
      } catch {
        // Scratch and unregistered roots have no Documents writers of their own.
      }
      return writers.map((writer) => ({
        id: writer.writerId ?? writer.id ?? "writer",
        ...(writer.purpose === undefined ? {} : { purpose: writer.purpose }),
        ...(writer.owner === undefined ? {} : { owner: writer.owner }),
        ...(writer.startedAt === undefined ? {} : { startedAt: writer.startedAt }),
      }));
    },
    readBlocks: async (sessionId) => {
      const store = await getKnowledgeStoreForSession(sessionId);
      if (!store) return null;
      return (await store.getBlocks(sessionId, await branchEntryIdsForSession(sessionId)))
        .map((block) => ({ label: block.label, content: block.content }));
    },
    withMergeWriter: async (workspaceId, threadId, operation) => {
      const writer = await documentsAuthority.registerWriterForScope(
        workspaceId,
        { kind: 'harness-thread', id: `merge:${threadId}` },
        { mode: 'process', purpose: 'harness-thread-merge' },
      );
      if (!writer) throw new Error('Thread integration has no workspace writer authority');
      const outcome = await Promise.resolve().then(operation).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const applied = outcome.ok ? recordOf(outcome.value).appliedPaths : undefined;
      const changed = !outcome.ok || (Array.isArray(applied) && applied.length > 0);
      const cleanupErrors: unknown[] = [];
      try { if (changed) await writer.markMutated(); }
      catch (error) { cleanupErrors.push(error); }
      try { await writer.close(); }
      catch (error) { cleanupErrors.push(error); }
      if (!outcome.ok) {
        for (const error of cleanupErrors) console.error('[HarnessThreads] Merge writer cleanup failed:', errorMessage(error));
        throw outcome.error;
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Failed to finalize the merge writer');
      return outcome.value;
    },
    sessions: {
      create: (input) => piRuntimeBroker.createSession(
        input.cwd,
        input.name,
        input.parentSession,
        { authorityId: input.workspaceId, id: input.workspaceId, kind: 'workspace' },
        {
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelSettings === undefined ? {} : { modelSettings: input.modelSettings }),
          ...(input.permissions ? { permissions: input.permissions } : {}),
          ...(input.scope?.length ? { scope: input.scope } : {}),
          tools: input.tools,
          workFocus: input.workFocus,
        },
      ),
      open: (input) => piRuntimeBroker.openSession({
        cwd: input.cwd,
        ...(input.modelSettings === undefined ? {} : { modelSettings: input.modelSettings }),
        ...(input.model ? { model: input.model } : {}),
        ...(input.permissions ? { permissions: input.permissions } : {}),
        ...(input.scope?.length ? { scope: input.scope } : {}),
        sessionId: input.sessionId,
        workspace: { authorityId: input.workspaceId, id: input.workspaceId, kind: 'workspace' },
        tools: input.tools,
      }),
      prompt: async (sessionId, text, instructions, images, inputContext) => {
        const fixedContext = inputContext ?? await sourceViewRuntime.contextForSession(sessionId);
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.prompt', {
          sessionId,
          text,
          ...(instructions ? { instructions } : {}),
          ...(images?.length ? { images } : {}),
          ...(fixedContext ? { inputContext: fixedContext } : {}),
        });
        if (!result.accepted) throw new Error(`Pi child session rejected its initial prompt: ${sessionId}`);
      },
      request: async (sessionId, text, messageId) => {
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.threadRequest', { sessionId, text, messageId });
        if (!result.accepted) throw new Error(`Pi session rejected execution input: ${sessionId}`);
      },
      notify: async (sessionId, text, messageId) => {
        if (!piRuntimeBroker.activeSessionIds.includes(sessionId)) await piRuntimeBroker.openSession({ sessionId });
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.notify', { sessionId, text, messageId });
        if (!result.accepted) throw new Error(`Pi session rejected passive input: ${sessionId}`);
      },
      send: async (sessionId, text) => {
        const inputContext = await sourceViewRuntime.contextForSession(sessionId);
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.followUp', {
          sessionId, text, ...(inputContext ? { inputContext } : {}),
        });
        if (!result.accepted) throw new Error(`Pi child session rejected follow-up input: ${sessionId}`);
      },
      abort: async (sessionId) => { await piRuntimeBroker.requestForSession(sessionId, 'agent.abort', { sessionId }); },
      close: async (sessionId) => {
        await harnessShellActivity.closeSessionShell(sessionId);
        await piRuntimeBroker.closeSession(sessionId);
      },
      snapshot: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }),
      summary: async (sessionId) => {
        try {
          return await piRuntimeBroker.requestForSession(sessionId, 'session.summary', { sessionId });
        } catch (activeError) {
          const summary = (await piRuntimeBroker.listSessions()).find((candidate) => candidate.id === sessionId);
          if (summary) return summary;
          throw activeError;
        }
      },
      stats: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.stats', { sessionId }),
      captureInput: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.input.capture', { sessionId }),
      entries: (sessionId, scope = 'branch') => piRuntimeBroker.requestForSession(sessionId, 'session.entries', { sessionId, scope }),
      readEntries: (sessionId, _cwd, scope = 'branch') => piRuntimeBroker.previewSessionEntries(sessionId, undefined, scope),
    },
    onError: (error) => {
      console.error('[HarnessThreads] Runtime failed:', errorMessage(error));
    },
  });
  // Durable follow-up registrations (D-307): the service owns observation and
  // delivers occurrences through the real Thread/Run lifecycle — an active run
  // gets an inform, a settled thread resumes via continueRun, and the shared
  // budget parks extras as pending continuations. Never a second agent loop.
  // Typed external follow-up sources. "github-pr" resolves the workspace's own
  // checkout branch/remotes through the authenticated GitHub auth — the wire
  // carries only a provider id + condition, never a URL or code. The resolver's
  // response is already credential-free (repo/branch/PR facts only).
  const followUpExternalSources = {
    githubPr: {
      // Deterministic adapter-owned spacing; the resolver itself caches and
      // honors GitHub rate-limit backoff.
      intervalMs: 60_000,
      async query({ workspaceId, source }: {
        workspaceId: string;
        source: { branch?: string; remote?: string; condition: 'exists' | 'open' | 'merged' | 'closed' };
      }) {
        const workspace = await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null);
        const directory = workspace?.root;
        if (!directory) {
          return { matched: false, unavailable: true, facts: { reason: 'workspace root unknown' } };
        }
        const { getOctokitOrNull } = await import('./lib/github/index.js');
        const octokit = getOctokitOrNull();
        if (!octokit) {
          return { matched: false, unavailable: true, facts: { reason: 'github not connected' } };
        }
        const branch = source.branch
          ?? (await getGitStatus(directory).catch(() => null))?.current
          ?? '';
        if (!branch) {
          return { matched: false, unavailable: true, facts: { reason: 'no git branch resolvable' } };
        }
        const { resolveGitHubPrStatus } = await import('./lib/github/pr-status.js');
        const { isGitHubRateLimitError, noteGitHubRateLimit } = await import('./lib/github/rate-limit.js');
        const status = await resolveGitHubPrStatus({
          octokit,
          directory,
          branch,
          ...(source.remote ? { remoteName: source.remote } : {}),
        }).catch((error: unknown) => {
          if (isGitHubRateLimitError(error)) {
            noteGitHubRateLimit(error);
            return null;
          }
          throw error;
        });
        if (status === null) {
          return {
            matched: false,
            retryAfterMs: 60_000,
            facts: { reason: 'github rate limited', branch },
          };
        }
        const pr = status.pr;
        const state = pr === null ? 'none'
          : pr.merged_at ? 'merged'
          : pr.state === 'open' ? 'open'
          : 'closed';
        const matched = source.condition === 'exists' ? pr !== null
          : source.condition === 'merged' ? state === 'merged'
          : source.condition === 'open' ? state === 'open'
          : state === 'closed';
        return {
          matched,
          ...(pr ? { eventId: `github-pr-${pr.number}-${state}` } : {}),
          facts: {
            branch,
            remote: status.resolvedRemoteName ?? source.remote ?? null,
            repository: status.repo ? `${status.repo.owner}/${status.repo.repo}` : null,
            pr: pr === null ? null : {
              number: pr.number,
              state,
              title: pr.title,
              url: pr.html_url,
            },
            condition: source.condition,
          },
        };
      },
    },
  };

  const followUpService = createFollowUpService({
    client: kernelClient,
    canExecuteScope: canExecuteBotScope,
    getThread: (workspaceId, threadId) => threadRegistry.getThreadById(workspaceId, threadId),
    notifySession: async (sessionId, text, messageId) => {
      const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.notify', { sessionId, text, messageId });
      if (!result.accepted) throw new Error(`Pi session rejected the follow-up inform: ${sessionId}`);
    },
    sessionRequest: async (sessionId, text, messageId) => {
      const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.threadRequest', { sessionId, text, messageId });
      if (!result.accepted) throw new Error(`Pi session rejected the follow-up trigger: ${sessionId}`);
    },
    sessionBusy: async (sessionId) => {
      const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }).catch(() => null);
      return Boolean(snapshot && (snapshot.busy === true || snapshot.isStreaming === true));
    },
    sendToThread: createFollowUpThreadSender({
      registry: threadRegistry,
      continueRun: (input) => threadRuntime!.continueRun(input),
      sendToSession: (sessionId, message, meta) => threadRuntime!.send(sessionId, message, meta),
    }),
    setFollowUpAttention: async (workspaceId, threadId, waitingFor) => {
      const thread = await threadRegistry.getThreadById(workspaceId, threadId);
      if (!thread) return;
      if (waitingFor === null) {
        // Never steal a user/permission wait that arrived meanwhile.
        if (thread.attention === 'followup') {
          await threadRegistry.setAttention(workspaceId, threadId, 'none', null);
        }
        return;
      }
      await threadRegistry.setAttention(workspaceId, threadId, 'followup', waitingFor);
    },
    requestForSession: (sessionId, method, params) => (
      piRuntimeBroker.requestForSession(sessionId, method, { sessionId, ...params } as never)
    ),
    subscribeAttempts: (listener) => experimentService.subscribeAttempts(listener),
    getAttempt: async (caller, attemptId) => {
      try {
        const result = await experimentService.get(caller, attemptId);
        return result.attempt;
      } catch (error) {
        if ((error as { harnessCode?: string }).harnessCode === 'not-found') return null;
        throw error;
      }
    },
    getExperiment: async (caller, attemptId) => {
      try {
        const result = await experimentService.get(caller, attemptId);
        return { attempt: result.attempt, artifacts: result.artifacts };
      } catch (error) {
        if ((error as { harnessCode?: string }).harnessCode === 'not-found') return null;
        throw error;
      }
    },
    readExperimentLog: (caller, params) => experimentService.logs(caller, params),
    watchWorkspace: (workspaceId, listener) => {
      try {
        const subscription = documentsAuthority.watch(workspaceId, (event) => {
          listener({
            sourceId: event.sourceId,
            kind: event.kind,
            sequence: event.sequence,
            generation: event.generation,
            ...(event.resource ? { path: event.resource.resourceId } : {}),
          });
        });
        return { ready: subscription.ready, close: () => subscription.close() };
      } catch {
        return null;
      }
    },
    statWorkspaceFile: async (workspaceId, filePath) => {
      const workspace = await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null);
      if (!workspace) return null;
      const absolute = path.resolve(workspace.root, filePath);
      const relative = path.relative(workspace.root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { exists: false };
      try {
        const stat = await fs.promises.stat(absolute);
        return { exists: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return { exists: false };
      }
    },
    workspaceHasActiveWriters: async (workspaceId) => {
      const state = await documentsAuthority.inspectMutation(workspaceId).catch(() => null);
      return (state?.activeWriters?.length ?? 0) > 0;
    },
    subscribeResourceSamples: (listener) => resourceService.subscribeSamples(listener),
    getResourceSample: (machineId) => resourceService.getMachineSample(machineId),
    // Desktop source (EE §8.3): the computer catalog is authoritative for
    // status (remote mirrors included); file revision checks delegate to the
    // managed-desktop artifact reader. Missing deps mean "not observable".
    observeDesktop: async (desktopId) => {
      const catalog = await computerService.list();
      const desktop = catalog.desktops.find((entry) => entry.id === desktopId);
      return { status: desktop?.status ?? null };
    },
    inspectDesktopArtifact: async (desktopId, relativePath) => {
      try {
        const version = await computerService.inspectArtifact(desktopId, relativePath);
        return { sha256: version.sha256 };
      } catch {
        return null;
      }
    },
    externalSource: (provider) => provider === 'github-pr' ? followUpExternalSources.githubPr : null,
    getShellEvents: (workspaceId, sessionId, executionId, afterId) => (
      knowledgeContextRuntime.shellEvents(workspaceId, sessionId, executionId, afterId)
    ),
    subscribeShellEvents: (listener) => knowledgeContextRuntime.subscribeShellEvents(listener),
    getShellExecutionStatus: async (sessionId, executionId) => {
      const supervisor = harnessServiceHost.getShellSupervisor(sessionId);
      if (!supervisor) return null;
      return supervisor.inspectExecution(executionId);
    },
    readShellExecutionOutput: async (sessionId, executionId, offset, length) => {
      const supervisor = harnessServiceHost.getShellSupervisor(sessionId);
      if (!supervisor) return null;
      return supervisor.readExecutionOutput(executionId, offset, length);
    },
    onChange: (workspaceId) => broadcastResearchFacts(workspaceId, 'followup'),
    onError: (error) => console.error('[VarinFollowUp]', error.message),
  });
  // Rebuild follow-up observers for every workspace that owns durable
  // definitions. The kernel record store enumerates them directly — recovery
  // does not depend on the Thread catalog, saved projects, or an open UI, and
  // one failing workspace does not block the rest.
  void (async () => {
    for (const workspaceId of await followUpService.definitionWorkspaces()) {
      await followUpService.reconcile(workspaceId).catch((error) => {
        console.error(`[VarinFollowUp] Reconcile failed for ${workspaceId}:`, errorMessage(error));
      });
    }
  })().catch((error) => console.error('[VarinFollowUp] Reconcile failed:', errorMessage(error)));
  void computerService.reconcileHandbacks().catch((error) => {
    console.error('[Computer] Handback delivery will retry:', errorMessage(error));
  });
  observeThreadIntegrationParentChange = (workspaceId, resourceIds) => {
    void threadRuntime!.invalidateIntegrationPreviews(workspaceId, resourceIds).catch((error: unknown) => {
      console.error('[HarnessThreads] Integration preview invalidation failed:', errorMessage(error));
    });
  };
  const researchRootRuntime = createResearchRootRuntime({
    registry: threadRegistry,
    getSessionSnapshot: (sessionId) => (
      sessionSnapshots.get(sessionId) as unknown as SessionSnapshot | undefined
    ) ?? null,
    sessions: {
      snapshot: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }),
      stats: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.stats', { sessionId }),
      entries: (sessionId, scope = 'branch') => piRuntimeBroker.requestForSession(sessionId, 'session.entries', { sessionId, scope }),
    },
    onError: (error) => {
      console.error('[ResearchRoot] Runtime failed:', errorMessage(error));
    },
    rejectHarnessRequest: async (sessionId, requestId, message) => {
      await piRuntimeBroker.requestForSession(
        sessionId,
        'harness.respond',
        buildHarnessRespondParams(sessionId, requestId, {
          ok: false,
          error: { code: 'unavailable', message, retryable: true },
        }),
      );
    },
  });
  // BC0: the same attached-root lifecycle, specialized for Bot entry chats —
  const agentRootRuntime = createAgentRootRuntime({
    registry: threadRegistry,
    getSessionSnapshot: sessionId => (sessionSnapshots.get(sessionId) as unknown as SessionSnapshot | undefined) ?? null,
    sessions: {
      snapshot: sessionId => piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }),
      stats: sessionId => piRuntimeBroker.requestForSession(sessionId, 'session.stats', { sessionId }),
      entries: (sessionId, scope = 'branch') => piRuntimeBroker.requestForSession(sessionId, 'session.entries', { sessionId, scope }),
    },
    onError: error => console.error('[AgentRoot] Runtime failed:', errorMessage(error)),
    rejectHarnessRequest: async (sessionId, requestId, message) => {
      await piRuntimeBroker.requestForSession(sessionId, 'harness.respond', buildHarnessRespondParams(sessionId, requestId,
        { ok: false, error: { code: 'unavailable', message, retryable: true } }));
    },
  });
  // a session whose durable `bot.profile` points at it attaches a `bot-root`
  // Thread under the `bot:<id>` scope instead of a project workspace.
  const botRootRuntime = createBotRootRuntime({
    botForSession: (sessionId) => botService.botForSession(sessionId),
    registry: threadRegistry,
    getSessionSnapshot: (sessionId) => (
      sessionSnapshots.get(sessionId) as unknown as SessionSnapshot | undefined
    ) ?? null,
    sessions: {
      snapshot: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }),
      stats: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.stats', { sessionId }),
      entries: (sessionId, scope = 'branch') => piRuntimeBroker.requestForSession(sessionId, 'session.entries', { sessionId, scope }),
    },
    onError: (error) => {
      console.error('[BotRoot] Runtime failed:', errorMessage(error));
    },
    rejectHarnessRequest: async (sessionId, requestId, message) => {
      await piRuntimeBroker.requestForSession(
        sessionId,
        'harness.respond',
        buildHarnessRespondParams(sessionId, requestId, {
          ok: false,
          error: { code: 'unavailable', message, retryable: true },
        }),
      );
    },
  });
  const threadWaitRuntime = createThreadWaitRuntime({
    registry: threadRegistry,
    onError: error => console.error('[ThreadWait] Recovery failed:', errorMessage(error)),
    resume: async (scopeId, thread, wait) => {
      if (!await threadRegistry.canExecuteScope(scopeId)) throw new Error('The task execution scope is unavailable');
      const original = wait.replyTo ? thread.messages?.find(message => message.id === wait.replyTo && message.direction === 'out') : undefined;
      const otherRequests = (thread.dependencyWaits ?? []).filter(other => other.replyTo && other.replyTo !== wait.replyTo).flatMap(other => {
        const request = thread.messages?.find(message => message.id === other.replyTo && message.direction === 'out');
        if (!request) return [];
        const reply = correlatedReply(thread, request.id);
        return [`Request ${request.id} to ${request.to.kind} ${request.to.id}:\n${request.text}\n`
          + (reply ? `Reply already recorded:\n${reply.text}` : 'No reply was recorded at recovery. Reuse the original requestId if this answer is still needed.')];
      });
      const text = `${wait.reason ?? 'The dependency wait ended'}. Resume the overall task: ${thread.brief}\n`
        + (original ? `Original request ${original.id} to ${original.to.kind} ${original.to.id}:\n${original.text}\nIf still waiting for its answer, reuse this requestId rather than sending it again.\n` : '')
        + (otherRequests.length ? `Other reply waits from the interrupted execution:\n${otherRequests.join('\n\n')}\n` : '')
        + 'Inspect relevant teammate work and continue implementation or integration.';
      if (isAttachedRootPurpose(thread.purpose)) {
        await piRuntimeBroker.openSession({ sessionId: wait.sessionId });
        const result = await piRuntimeBroker.requestForSession(wait.sessionId, 'agent.threadRequest', { sessionId: wait.sessionId, messageId: wait.id, text });
        if (!result.accepted) throw new Error('The waiting session did not accept its continuation');
      } else {
        await threadRuntime!.continueRun({ scopeId, parent: thread.parent, threadId: thread.id, mode: 'continue',
          resumeSuspended: true, task: text, requestId: wait.id, from: { kind: 'thread', id: thread.id } });
      }
    },
  });
  threadWaitRuntimeRef.current = threadWaitRuntime;
  piRuntimeBroker.setQuestionContinuation(async (sessionId, reply) => {
    const owner = await threadRegistry.resolveSessionOwner(sessionId);
    if (!owner || owner.owner === 'attached-root') return false;
    const runs = await threadRegistry.listRuns(owner.owningScopeId, owner.threadId);
    const prior = runs.find(candidate => candidate.request?.requestId === reply.messageId);
    const run = prior ?? runs.find(candidate => candidate.id === owner.runId);
    if (!run) throw new Error('The question thread run no longer exists');
    if (!prior && run.outcome === null && run.workerState !== 'lost') return false;
    const thread = await threadRegistry.getThreadById(owner.owningScopeId, owner.threadId);
    if (!thread || !run.frozen) throw new Error('The question thread cannot be continued');
    await threadRuntime!.continueRun({ scopeId: owner.owningScopeId, parent: thread.parent, threadId: thread.id,
      mode: 'continue', resumeSuspended: true, task: reply.text, requestId: reply.messageId,
      from: { kind: 'user', id: 'question' }, frozen: run.frozen });
    return true;
  });
  piRuntimeBroker.setSessionRunCoordinator(async ({ snapshot }) => {
    if (snapshot.workFocus?.active.id !== 'research' || snapshot.workspace?.kind === 'workspace') return;
    try {
      const identity = await documentsAuthority.resolveWorkspace({ path: snapshot.cwd });
      return {
        workspace: {
          authorityId: identity.workspaceId,
          id: identity.workspaceId,
          kind: 'workspace' as const,
        },
      };
    } catch (error) {
      throw new Error(
        `Research work focus requires an admitted workspace for ${snapshot.cwd}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }, { appliesToWorkFocus: ['research'] });
  const hostCredentialAuthority = options.piRuntimeBroker?.credentialAuthority ?? sharedHostCredentialAuthority(process.env.VARIN_AGENT_DIR);
  const mcpAgentDir = mcpHostAgentDir(process.env.VARIN_AGENT_DIR);
  const mcpAuthority = new McpAuthority({
    providerToken: async (_scope, provider) => (await hostCredentialAuthority.getAuth(provider))?.auth.apiKey,
    credentialScope: async (_scope, provider) => hostCredentialAuthority.currentScope(provider),
  });
  const mcpCompositions = new McpCompositions(mcpAuthority, (code, reference) => { console.error('[MCP]', code, reference); });
  const agentMcpScopes = new Map<string, { identity: string; ready: Promise<McpCompositionScope> }>();
  const releaseAgentMcpScope = (runId: string) => {
    const entry = agentMcpScopes.get(runId); agentMcpScopes.delete(runId);
    if (entry) void entry.ready.then(scope => scope.release(), () => undefined);
  };
  kernelClient.onToolReleased(releaseAgentMcpScope);
  kernelClient.subscribeExit(() => { for (const runId of agentMcpScopes.keys()) releaseAgentMcpScope(runId); });
  const prepareAgentPolicy = createAgentPolicy(extensionRuntime);
  const modelAuthority = createModelAuthority(hostCredentialAuthority);
  const liveSources = createLiveSourceOwner({ documents: documentsAuthority, kernel: kernelClient });
  kernelClient.setLanguageOwner(createLanguageOwner({ documents: documentsAuthority, supervisor: languageSupervisor, validateSource: liveSources.validate }));
  const agentRuntime: AgentRuntimeClient = new AgentRuntimeClient(kernelClient, async (input, signal) => {
    // A read-only fixed branch has no executable filesystem view. Global MCP capabilities run
    // in the neutral Host scope; they must not borrow the mutable project directory.
    const workspace = input.source && input.executionCwd
      ? await documentsAuthority.inspectWorkspace(input.source.workspaceId) : undefined;
    const configCwd = workspace?.root ?? mcpAgentDir;
    const scope = {
      agentDir: mcpAgentDir, configCwd, executionCwd: input.executionCwd ?? mcpAgentDir,
      environmentId: workspace ? `${hostId}:${input.source!.executionWorkspaceId}` : `${hostId}:global`,
      executionScope: workspace ? 'workspace' as const : 'global' as const,
      projectTrusted: Boolean(workspace) && mcpHostProjectTrusted(mcpAgentDir, configCwd),
      sessionId: `agent:${input.threadId}`,
    };
    const identity = JSON.stringify(scope);
    let selected = agentMcpScopes.get(input.runId);
    if (selected?.identity !== identity) {
      releaseAgentMcpScope(input.runId);
      const ready = mcpCompositions.observe(scope, () => {
        void agentRuntime.refreshMcp(input.runId).catch(() => {
          console.error('[MCP] Tool composition preparation failed for Run:', input.runId);
        });
      }, signal);
      selected = { identity, ready };
      const owned = selected;
      agentMcpScopes.set(input.runId, selected);
      void ready.then(scope => { if (agentMcpScopes.get(input.runId) !== owned) scope.release(); }, () => {
        if (agentMcpScopes.get(input.runId) === owned) agentMcpScopes.delete(input.runId);
      });
    }
    const owner = await selected.ready;
    signal?.throwIfAborted();
    const lease = input.requiredBinding?await owner.restore(input.requiredBinding,signal):owner.snapshot();
    return createMcpLease({ lease, kernel: kernelClient,
      ...(input.source && !input.executionCwd ? { unavailableWorkspaceScope: {
        workspaceId: input.source.workspaceId,
        reason: 'Project MCP capabilities require a prepared execution environment matching the pinned source. Only global Host MCP capabilities are available for this read-only source.',
      } } : {}),
      currentPolicy: async () => {
        const trusted = Boolean(workspace) && mcpHostProjectTrusted(mcpAgentDir, configCwd);
        if (scope.projectTrusted && !trusted) throw new Error('MCP project trust was revoked');
        return readMcpHostPermissionPolicy(mcpAgentDir, configCwd, trusted);
      },
    });
  }, {
    prepare: (input, signal) => prepareAgentPolicy({ sessionId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.requiredBinding ? { requiredBinding: input.requiredBinding } : {}) }, signal),
    observe: (input, changed, signal) => prepareAgentPolicy.observe({ sessionId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}) }, changed, signal),
  }, createPolicyModelPreparer({ models: modelAuthority,
    // This is a user-scoped role. Native Threads do not impersonate Pi sessions.
    settings: () => piRuntimeBroker.requestCatalog('settings.get', {}),
  }), liveSources.validate, createExtensionTools({runtime:extensionRuntime,kernel:kernelClient,currentPolicy:async runId=>{
    const launch=await kernelClient.agentRuntimeRequest<import('./lib/kernel/protocol.generated.js').LaunchIntent|null,'runtime.launch.inspect'>('runtime.launch.inspect',{runId});
    const workspace=launch?.selection.source?await documentsAuthority.inspectWorkspace(launch.selection.source.workspace_id):undefined;
    const cwd=workspace?.root??mcpAgentDir;
    return readMcpHostPermissionPolicy(mcpAgentDir,cwd,Boolean(workspace)&&mcpHostProjectTrusted(mcpAgentDir,cwd));
  }}));
  const runObservers = new RunObservers(agentRuntime, extensionRuntime, (threadId, _error) => {
    console.error('[RunObserver] Activity projection requires attention:', threadId ?? 'selection');
  });
  personalizationRuntime = agentRuntime;
  const threadWorkingStates = createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter);
  const threadResources = createThreadResourceScope({
    agentDir: mcpAgentDir, documents: documentsAuthority, workingStates: threadWorkingStates, resolvePrimaryWorktreeRoot,
    validateLiveSource: liveSources.validate,
    projectTrusted: root => mcpHostProjectTrusted(mcpAgentDir, root),
    configuration: root => readAgentResourceConfiguration({ agentDir: mcpAgentDir, ...(root ? { cwd: root } : {}) }),
    withSourceRead: (input, consume) => kernelStorageAdapter.withResourceRead(input, consume),
  });
  const threadContext = createThreadContext({ personalization: agentPersonalization,
      resources: threadResources,
      composition: createContextComposition(extensionRuntime),
      projectForWorkspace: async workspaceId => {
        const { root } = await documentsAuthority.inspectWorkspace(workspaceId);
        const projects = sanitizeProjects((await readSettingsFromDisk()).projects) ?? [];
        return projects.find(project => projectContainsPath(project, root))?.id;
      },
    });
  kernelClient.setResourceOwner(createResourceOwner({ runtime: agentRuntime, resources: threadResources }));
  kernelClient.setPlanOwner(createPlanOwner(getUserKnowledgeStore, agentRuntime));
  kernelClient.setMemoryOwner(createMemoryOwner({ personalization: agentPersonalization, prepareContext: threadContext }));
  const contextService=new ContextService(agentRuntime,threadContext,async(run,launch)=>{
    const source=launch?.selection.source;
    const root=source ? (await documentsAuthority.inspectWorkspace(source.workspace_id)).root : undefined;
    const model=run.configuration as {providerId?:string;model:string};
    return readContextPolicy({agentDir:mcpAgentDir,...(root?{projectRoot:root}:{}),projectTrusted:root!==undefined && mcpHostProjectTrusted(mcpAgentDir,root),
      ...(model.providerId?{providerId:model.providerId}:{}),modelId:model.model});
  },(runId,signal)=>threads.continueLaunch(runId,{signal}));
  kernelClient.setContextOwner(contextService);
  const threads = new ThreadAdapter(agentRuntime,
    modelAuthority, createThreadSourceAdmission({ documents: documentsAuthority, liveSources,
      workingStates: createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter), runtime: agentRuntime }), (runId, _error) => {
      // Durable launch remains inspectable/resumable. Never log credentials or provider responses.
      console.error('[Thread] Launch preparation requires attention:', runId);
    }, createThreadSourcePreparer({ documents: documentsAuthority, liveSources, workingStates: threadWorkingStates, prepareResources: threadResources.prepareSourceCapture }),
    threadContext, new PlanService(agentRuntime, getUserKnowledgeStore), createThreadSkillInputPreparer(threadResources), createThreadProcesses({ runtime: agentRuntime, kernel: kernelClient,
      terminal: () => terminalRuntime, resolveLiveSource: liveSources.validate,
      onError: () => console.error('[Thread] Original process terminal requires attention'),
    }));
  const collaboration = new ThreadCollaboration({ runtime: agentRuntime,
    kernel: kernelClient, storageAdapter: kernelStorageAdapter, resolveLiveSource: liveSources.validate,
    sourceCaptureOwners: { documents: documentsAuthority, prepareResources: threadResources.prepareSourceCapture, inspectInventory: (directory, signal) => threadWorktreeRuntime.inspectGitBaselineInventory(directory, signal) },
    reconcileDomainReceipts: createIntegrationReceiptReconciler({ runtime: agentRuntime,
      onError: (_operationId, _error) => console.error('[Integration] Original effect receipt requires attention') }),
    continueRun: (runId, signal) => threads.continueLaunch(runId, { signal }), recoverLaunches: signal => threads.recover(signal),
    workingStates: createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter), prepareContext: threadContext,
    onError: (operationId, _error) => console.error('[Collaboration] Preparation or delivery requires attention:', operationId ?? 'discovery'),
  });
  void collaboration.recover();
  const refreshThreadPersonalization = () => threads.refreshPersonalization();
  void refreshThreadPersonalization().catch(() => console.error('[Thread] Personalization refresh requires attention'));
  void contextService.recover().catch(() => console.error('[Thread] Saved context job discovery requires attention'));
  registerThreadRoutes(app, threads, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  registerRuntimeMaintenanceRoutes(app, agentRuntime, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  registerHarnessThreadRoutes(app, {
    registry: threadRegistry,
    runtime: threadRuntime,
    sendToThread: createUserThreadSendAdapter(() => harnessServiceHost, threadRuntime!),
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerHarnessExperimentRoutes(app, {
    runtime: threadRuntime,
    registry: threadRegistry,
    experiments: experimentService,
    resources: resourceService,
    sources: sourceService,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerHarnessFollowUpRoutes(app, {
    runtime: threadRuntime,
    registry: threadRegistry,
    followUps: followUpService,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerBotRoutes(app, {
    bots: botService,
    memory: memoryService,
    computers: computerService,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerComputerRoutes(app, {
    computers: computerService,
    hostId,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  const desktopMedia = attachDesktopMedia({ server, hostId, computers: computerService,
    authenticate: async (request) => Boolean(await uiAuthController?.ensureSessionToken(request, { setHeader: () => undefined })),
    originAllowed: isRequestOriginAllowed,
  });
  // Target side of `environment.forward`: authenticated coordinator Hosts
  // bridge a WebSocket onto a TCP address resolved on THIS machine.
  const serviceForward = attachServiceForward({ server, hostId,
    authenticate: async (request) => Boolean(await uiAuthController?.ensureSessionToken(request, { setHeader: () => undefined })),
    originAllowed: isRequestOriginAllowed,
  });
  registerConnectionRoutes(app, connections, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  const connectionProxy = attachConnectionProxy({
    app, server, settings: connections.settingsStore,
    requireAuth: uiAuthController?.requireAuth ?? ((_request, _response, next) => next()),
    authenticateUpgrade: async (request) => Boolean(await uiAuthController?.ensureSessionToken(request, { setHeader: () => undefined })),
    originAllowed: isRequestOriginAllowed,
  });
  void connections.restore().catch((error) => console.error('[HostConnections]', errorMessage(error)));
  registerManagedRemoteRoutes(app, {
    service: managedRemoteExecution,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
    ...(uiAuthController?.resolveAuthContext ? { resolveAuthContext: uiAuthController.resolveAuthContext } : {}),
  });
  registerHarnessContextRoutes(app, {
    getStore: getKnowledgeStoreForSession,
    getBranchEntryIds: branchEntryIdsForSession,
    getUserStore: getUserKnowledgeStore,
    memoryService,
    memoryOwnerForSession: (sessionId) => memoryService.ownerForSession(sessionId),
    onKnowledgeChanged: (sessionId, scope) => {
      broadcastGlobalUiEvent?.({
        type: 'varin:harness-knowledge-changed',
        properties: { sessionId, scope },
      });
    },
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerAgentPersonalizationRoutes(app, agentPersonalization, uiAuthController?.requireAuth ?? ((_req, _res, next) => next()));
  registerSelectionMemoryRoutes(app, {
    agentPersonalization,
    memory: memoryService,
    entries: async (sessionId) => (await piRuntimeBroker.previewSessionEntries(sessionId, undefined, 'branch')).entries,
    narrate: (scopeId, system, prompt, signal) => memoryOrganizer.extractSelection(scopeId, system, prompt, signal),
    requireAuth: uiAuthController?.requireAuth ?? ((_request, _response, next) => next()),
  });
  registerWebSearchCredentialRoutes(app, {
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerPdfMaterialRoutes(app, {
    readDocument: createUserMaterialReadAdapter(() => harnessServiceHost, threadRuntime, harnessPathAuthority),
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  piRuntimeBroker.setSessionDeleteCoordinator(async ({ sessionId, summary }) => {
    const rootScope = await threadRuntime!.rootScopeForSession(sessionId);
    if (rootScope) {
      const roots = (await threadRegistry.listThreads(
        rootScope.scopeId,
        { kind: 'session', id: sessionId },
        true,
      )).filter((thread) => isAttachedRootPurpose(thread.purpose) && thread.purpose !== 'bot-root');
      if (roots.length) {
        await researchRootRuntime.cancelSession(sessionId, 'user session deleted');
        await agentRootRuntime.cancelSession(sessionId, 'user session deleted');
        for (const root of roots) await threadRuntime!.kill(root.id, false, rootScope.scopeId);
      }
    }
    // A Bot entry chat is disposable: deleting it cancels the attached Run and
    // releases the entry binding, but the Bot's work Threads are owned by the
    // `bot:<id>` scope — they are never cascade-killed with the conversation.
    const entryBot = await botService.botForSession(sessionId).catch(() => null);
    if (entryBot) {
      await botRootRuntime.cancelSession(sessionId, 'bot entry session deleted');
      await botService.releaseEntry(sessionId);
    }
    await threadRegistry.archiveThreadsForDeletedSessionAcrossWorkspaces(sessionId);
    // Session deletion is a target-gone event: every durable wait bound to the
    // session closes instead of outliving its delivery authority.
    for (const followUpWorkspaceId of await followUpService.definitionWorkspaces()) {
      // The broker deletes the session only after this coordinator resolves.
      // Propagate settlement failures so a retry still has the session summary
      // and delivery authority needed to close durable waits.
      await followUpService.settleTarget(followUpWorkspaceId, { kind: 'session', id: sessionId });
    }
    if (summary.workspace?.kind !== 'workspace') return;
    const workspaceId = summary.workspace.authorityId ?? summary.workspace.id;
    await threadRegistry.cancelAllForParent(
      workspaceId,
      { kind: 'session', id: sessionId },
      async (thread) => { await threadRuntime!.kill(thread.id, false, workspaceId); },
    );
  });
  void threadRuntime.resumePendingDeletions().catch((error) => {
    console.error('[HarnessThreads] Pending deletion recovery failed:', errorMessage(error));
  });

  void threadRuntime.resumeCodeSubmissions().catch((error) => {
    console.error('[HarnessThreads] Code submission recovery failed:', errorMessage(error));
  });
  const catalogScan = {
    start(_workspaceId: string): void {},
  };
  async function getKnowledgeStoreForScope(scopeId: string): Promise<KnowledgeStore> {
    // HR0: scope ids are either project workspace ids or `session:<id>`; only
    // the persisted store key differs — records keep their real scope. BC0
    // adds `bot:<id>` scopes that resolve to the Bot's own memory store.
    const scope = isBotScopeId(scopeId) ? 'bot' as const
      : isSessionScopeId(scopeId) ? 'session' as const
        : 'workspace' as const;
    const assertMemoryOwner = async () => {
      if (scope !== 'bot') return;
      const bot = await botService.get(botIdFromScopeId(scopeId));
      if (!bot || bot.deletion) throw new Error('Bot memory is unavailable during or after deletion');
    };
    await assertMemoryOwner();
    const storeKey = knowledgeStoreKeyForScope(scopeId);
    const existing = knowledgeStores.get(storeKey);
    if (existing) return existing;
    const pending = knowledgeStoreLoads.get(storeKey);
    if (pending) return pending;
    const loading = openWorkspaceKnowledge({
      dataDir: VARIN_DATA_DIR,
      hostId,
      workspaceId: storeKey,
      scope,
      embedding: null, // Authority .tdb stays placeholder-dim; knowledge vectors are derived (D-196)
      onKnowledgeChanged: (ids) => {
        const store = knowledgeStores.get(storeKey);
        if (!store || !knowledgeVectors) return;
        knowledgeVectors.notify(store, scope, scopeId, scopeId, ids);
      },
      onBlocksChanged: (sessionId) => {
        broadcastGlobalUiEvent?.({
          type: 'varin:harness-blocks-changed',
          properties: { workspaceId: scopeId, sessionId },
        });
      },
    }).then(async (store) => {
      try { await assertMemoryOwner(); }
      catch (error) { await store.close(); throw error; }
      knowledgeStores.set(storeKey, store);
      catalogScan.start(scopeId);
      if (scope === 'bot') knowledgeVectors?.scheduleReconcile(store, scope, scopeId, scopeId);
      if (scope === 'bot' && userKnowledgeStore) knowledgeVectors?.scheduleReconcile(userKnowledgeStore, 'user', 'user', scopeId);
      return store;
    });
    knowledgeStoreLoads.set(storeKey, loading);
    try {
      return await loading;
    } finally {
      knowledgeStoreLoads.delete(storeKey);
    }
  }

  function snapshotKnowledgeWorkspaceId(sessionId: string): string | null {
    const workspace = recordOf(sessionSnapshots.get(sessionId)?.workspace);
    if (workspace.kind !== 'workspace') return null;
    if (typeof workspace.authorityId === 'string' && workspace.authorityId.trim()) return workspace.authorityId;
    return typeof workspace.id === 'string' && workspace.id.trim() ? workspace.id : null;
  }

  async function owningKnowledgeScopeIdForSession(
    sessionId: string,
    fallback: string | null = null,
  ): Promise<string | null> {
    const bot = await botService.botForSession(sessionId) ?? await consultBotForSession(sessionId);
    if (bot) return `bot:${bot.id}`;
    // RR4/E07: durable owner resolution. The active-run binding only exists
    // while the run is live; the catalog scan still answers after the run
    // settled or the Host restarted, without guessing from UI snapshots.
    // A broken/unreadable catalog is an owner-resolution failure, not evidence
    // that this session has no durable owner. Let it reach the caller instead
    // of falling through to an execution workspace or a partial UI snapshot.
    return resolveKnowledgeScopeOwner(
      () => threadRegistry.resolveSessionOwner(sessionId),
      fallback,
      snapshotKnowledgeWorkspaceId(sessionId),
    );
  }

  async function getKnowledgeStoreForSession(sessionId: string): Promise<KnowledgeStore | null> {
    // HR0: a session's durable owner is its binding/catalog scope; an unbound
    // chat falls back to its own session scope, never a guessed directory.
    const scopeId = await owningKnowledgeScopeIdForSession(sessionId) ?? sessionScopeId(sessionId);
    return getKnowledgeStoreForScope(scopeId);
  }

  async function getUserKnowledgeStore(): Promise<KnowledgeStore> {
    if (userKnowledgeStore) return userKnowledgeStore;
    if (!userKnowledgeStoreLoad) {
      userKnowledgeStoreLoad = openUserKnowledgeStore({
        onPlanChanged: change => broadcastGlobalUiEvent?.({ type: 'varin:plan-changed', properties: { ...change } }),
        dataDir: VARIN_DATA_DIR,
        hostId,
        embedding: null,
        onKnowledgeChanged: (ids) => {
          if (!userKnowledgeStore || !knowledgeVectors) return;
          knowledgeVectors.notify(userKnowledgeStore, 'user', 'user', undefined, ids);
        },
      }).then((store) => {
        userKnowledgeStore = store;
        for (const workspaceId of knowledgeStores.keys()) {
          knowledgeVectors?.scheduleReconcile(store, 'user', 'user', workspaceId);
        }
        return store;
      });
    }
    try {
      return await userKnowledgeStoreLoad;
    } finally {
      userKnowledgeStoreLoad = null;
    }
  }

  // BC3: a consult session (kind:"discussion" + bot) belongs to the named Bot
  // — persona instructions and the `bot:<id>` memory scope resolve through the
  // Thread record, not the session's owning catalog scope.
  const consultBotForSession = async (sessionId: string) => {
    const binding = await threadRegistry.resolveSessionOwner(sessionId);
    if (!binding) return null;
    const thread = await threadRegistry.getThreadById(binding.owningScopeId, binding.threadId);
    if (!thread?.consultBotId) return null;
    const bot = await botService.get(thread.consultBotId);
    if (!bot) throw new Error(`Consulted Bot is missing: ${thread.consultBotId}`);
    return bot;
  };

  const knowledgeStoreExistsForScope = (scopeId: string): Promise<boolean> => (
    fsPromises.access(path.join(VARIN_DATA_DIR, 'knowledge', hostId, `${knowledgeStoreKeyForScope(scopeId)}.tdb`))
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })
  );

  // BC3: a memory's work association is the session's bound Thread plus its
  // ancestor chain (obligations the work inherited) and its follow-up
  // Threads/Runs (obligations the work produced) — not merely the one
  // threadId/runId of the current session binding.
  const workAssociationForSession = async (sessionId: string): Promise<MemoryRecallAssociation> => {
    const sessionIds = new Set<string>([sessionId]);
    const threadIds = new Set<string>();
    const runIds = new Set<string>();
    const binding = await threadRegistry.resolveSessionOwner(sessionId);
    if (!binding) return { sessionIds: [...sessionIds] };
    const scopeId = binding.owningScopeId;
    const includeThread = async (threadId: string): Promise<void> => {
      if (threadIds.has(threadId)) return;
      threadIds.add(threadId);
      for (const run of await threadRegistry.listRuns(scopeId, threadId)) {
        runIds.add(run.id);
        if (run.sessionId) sessionIds.add(run.sessionId);
      }
    };
    await includeThread(binding.threadId);
    let cursor = await threadRegistry.getThreadById(scopeId, binding.threadId);
    while (cursor?.parent.kind === 'thread' && !threadIds.has(cursor.parent.id)) {
      const ancestorId = cursor.parent.id;
      await includeThread(ancestorId);
      cursor = await threadRegistry.getThreadById(scopeId, ancestorId);
    }
    const pending = [binding.threadId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const child of await threadRegistry.listThreads(scopeId, { kind: 'thread', id: current }, true)) {
        if (threadIds.has(child.id)) continue;
        await includeThread(child.id);
        pending.push(child.id);
      }
    }
    return { sessionIds: [...sessionIds], threadIds: [...threadIds], runIds: [...runIds] };
  };

  const knowledgeContextRuntime = createKnowledgeContextRuntime({
    recallEnabled: async (sessionId) => isBotScopeId(await owningKnowledgeScopeIdForSession(sessionId) ?? ''),
    getStore: getKnowledgeStoreForScope,
    getUserStore: getUserKnowledgeStore,
    resolveScope: async (sessionId) => await owningKnowledgeScopeIdForSession(sessionId) ?? sessionScopeId(sessionId),
    getSessionStore: async (sessionId) => await knowledgeStoreExistsForScope(sessionScopeId(sessionId))
      ? getKnowledgeStoreForScope(sessionScopeId(sessionId)) : null,
    goalForSession: async (sessionId) => {
      const binding = await threadRegistry.resolveSessionOwner(sessionId);
      if (!binding) return undefined;
      const thread = await threadRegistry.getThreadById(binding.owningScopeId, binding.threadId);
      return thread?.brief.trim() || undefined;
    },
    // BC3: one selection service backs automatic recall and the `recall`
    // tool — work-associated rows first, then scope-labeled text/vector hits,
    // finally an optional memory-recall fast-decision pass. Retrieval never
    // depends on the fast decision being configured or reachable.
    recall: async ({ workspaceId, store, sessionId, query, goal, signal }) => {
      const associated = await workAssociationForSession(sessionId);
      const sources: MemoryRecallSource[] = [{
        authority: store,
        scope: scopeOfScopeId(workspaceId),
        scopeId: workspaceId,
      }];
      const ownScopeId = sessionScopeId(sessionId);
      if (ownScopeId !== workspaceId && await knowledgeStoreExistsForScope(ownScopeId)) {
        const sessionStore = await getKnowledgeStoreForScope(ownScopeId);
        if (sessionStore) sources.push({ authority: sessionStore, scope: 'session', scopeId: ownScopeId });
      }
      const userStore = await getUserKnowledgeStore();
      if (userStore) sources.push({ authority: userStore, scope: 'user', scopeId: 'user' });
      const semantic = semanticRuntimeHolder.current;
      const executionWorkspaceId = snapshotKnowledgeWorkspaceId(sessionId);
      const { results } = await recallMemories({
        sources,
        query,
        k: 5,
        ...(knowledgeVectors ? { vectors: knowledgeVectors } : {}),
        workspaceId,
        // A Bot or session scope without an execution workspace still judges
        // through the shared global inference binding — recall never depends
        // on a document workspace existing.
        judgeWorkspaceId: executionWorkspaceId ?? workspaceId,
        associated,
        ...(goal !== undefined ? { goal } : {}),
        ...(semantic ? {
          fastDecision: {
            status: semantic.fastDecisionStatus,
            decide: semantic.fastDecision,
          },
        } : {}),
        ...(signal ? { signal } : {}),
      });
      return results;
    },
    onError: (error) => console.error('[HarnessKnowledge] Observer failed:', errorMessage(error)),
  });
  const catalogFileSearch = createFsSearchRuntimeFactory({ compute: kernelCompute });
  // A grammar catalog must not be able to stop the Host from starting: an
  // unreadable manifest means "nothing is installable", not "no server".
  let grammarManifest = EMPTY_GRAMMAR_PACK_MANIFEST;
  try {
    grammarManifest = loadCommittedGrammarPackManifest();
  } catch (error) {
    console.error('[LanguageSupport] Grammar pack manifest is unusable:', errorMessage(error));
  }
  const grammarStore = createGrammarStore(VARIN_DATA_DIR);
  const grammarInstaller = createGrammarInstaller({
    store: grammarStore,
    manifest: grammarManifest,
    minAbi: GRAMMAR_MIN_ABI,
    maxAbi: GRAMMAR_MAX_ABI,
    inspectAbi: createGrammarAbiInspector((fileName) => resolveStructureRuntimeFile(fileName)),
  });
  const languageSupportRuntime = createLanguageSupportRuntime({
    searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
    inspectWorkspace: async (workspaceId) => documentsAuthority.getWorkspace(workspaceId),
    manifest: grammarManifest,
    store: grammarStore,
    installer: grammarInstaller,
    prepareServer: (languageId, root, signal) => managedLanguageServers.ensure(languageId, root, signal),
    serverInfo: (languageId) => {
      const bundled = VARIN_BUNDLED_LANGUAGE_SERVERS.find((server) => server.languageIds.includes(languageId));
      if (bundled) return { status: 'bundled', name: bundled.name };
      const { status, name, message } = managedLanguageServers.inspect(languageId);
      return { status, ...(name ? { name } : {}), ...(message ? { message } : {}) };
    },
  });
  const structureSource = createStructureSource([
    createTreeSitterStructureProvider({
      compute: kernelCompute,
      onLanguageRequest: (languageId, workspaceId) => languageSupportRuntime.noteRequest(languageId, workspaceId),
      resolveInstalled: (fileName) => grammarStore.pathForGrammarFile(fileName),
      resolveInstalledLanguage: (languageId) => languageSupportRuntime.installedStructureSpec(languageId),
    }),
    createLspStructureProvider({
      documents: documentsAuthority,
      supervisor: languageSupervisor,
      readSource: sourceViewRuntime.readSource,
      resolveTarget: sourceViewRuntime.resolveLanguageTarget,
    }),
  ]);
  const projectDirectories = (settings: { projects?: unknown }) => (sanitizeProjects(settings.projects) ?? []).flatMap(projectFolders);
  const languagePrewarm = createLanguagePrewarm({
    documents: documentsAuthority, languages: languageSupportRuntime, supervisor: languageSupervisor,
    onError: error => console.error('[LanguagePrewarm]', errorMessage(error)),
  });
  const prewarmSessions = new Map<string, { cwd: string }>();
  const releaseSessionPrewarm = (sessionId: string): void => {
    prewarmSessions.delete(sessionId);
    languagePrewarm.releaseOwner(`session:${sessionId}`);
  };
  const prewarmSession = (sessionId: string, cwd: unknown, refresh = false): void => {
    if (typeof cwd !== 'string' || !cwd) { releaseSessionPrewarm(sessionId); return; }
    if (prewarmSessions.get(sessionId)?.cwd === cwd && !refresh) return;
    const entry = { cwd };
    prewarmSessions.set(sessionId, entry);
    void documentsAuthority.resolveWorkspace({ path: cwd }).then(workspace => {
      if (prewarmSessions.get(sessionId) !== entry) return;
      languagePrewarm.setWorkspace(`session:${sessionId}`, workspace.workspaceId);
      if (refresh) languagePrewarm.refreshWorkspace(workspace.workspaceId);
    }).catch(error => {
      if (prewarmSessions.get(sessionId) === entry) {
        releaseSessionPrewarm(sessionId);
        console.error('[LanguagePrewarm]', errorMessage(error));
      }
    });
  };
  let prewarmProjectGeneration = 0;
  let prewarmProjectOwners = new Set<string>();
  const prewarmProject = (settings: { projects?: unknown; activeProjectId?: unknown }): void => {
    const generation = ++prewarmProjectGeneration;
    const project = (sanitizeProjects(settings.projects) ?? []).find(entry => entry.id === settings.activeProjectId);
    void Promise.all((project ? projectFolders(project) : []).map(async directory => ({
      owner: `project:${directory}`, workspace: await documentsAuthority.resolveWorkspace({ path: directory }),
    }))).then(entries => {
      if (generation !== prewarmProjectGeneration) return;
      const next = new Set(entries.map(entry => entry.owner));
      for (const owner of prewarmProjectOwners) if (!next.has(owner)) languagePrewarm.releaseOwner(owner);
      for (const entry of entries) languagePrewarm.setWorkspace(entry.owner, entry.workspace.workspaceId);
      prewarmProjectOwners = next;
    }).catch(error => console.error('[LanguagePrewarm]', errorMessage(error)));
  };
  prewarmProject(await readSettingsFromDisk());
  const projectIndexScope = createProjectIndexScope([],
    [path.join(await fsPromises.realpath(VARIN_DATA_DIR), 'bots')]);
  const symbolGraphRuntime = createSymbolGraphRuntime({
    getIndexScope: projectIndexScope.get,
    getStore: getKnowledgeStoreForScope,
    documents: documentsAuthority,
    supervisor: languageSupervisor,
    structureSource,
    searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
    isIndexablePath: async (id, resourceId, signal) => catalogFileSearch.isSearchableFile(
      (await documentsAuthority.inspectWorkspace(id)).root, resourceId, signal,
    ),
    onError: (error) => console.error('[HarnessKnowledge] Symbol graph observer failed:', errorMessage(error)),
  });
  const semanticIndexManagement = createSemanticIndexManagement(VARIN_DATA_DIR, hostId);
  const semanticIndexLoad = await semanticIndexManagement.load().catch((error: unknown) => ({
    config: DEFAULT_SEMANTIC_INDEX_CONFIGURATION, error: errorMessage(error),
  }));
  if (semanticIndexLoad.error) console.error('[HarnessKnowledge] Index settings need repair:', semanticIndexLoad.error);
  const semanticIndexConfig = semanticIndexLoad.config;
  const makeLocalEmbedder = () => createLocalSemanticEmbedder({ dataDir: VARIN_DATA_DIR,
    cpu: { mode: semanticIndexConfig.localCpuMode ?? 'auto', maxThreads: semanticIndexConfig.localCpuThreads ?? null } });
  const semanticRuntimeHolder: { current?: ReturnType<typeof createWorkspaceSemanticRuntime> } = {};
  const localSemanticComponent = createLocalSemanticComponentManager({
    dataDir: VARIN_DATA_DIR,
    version: VARIN_VERSION,
    onEnabled: () => semanticRuntimeHolder.current?.refreshLocalSemantic(makeLocalEmbedder()),
  });
  const localEmbedder = makeLocalEmbedder();
  const semanticScheduler = createEmbedScheduler({
    concurrency: semanticIndexConfig.concurrentRequests,
    backgroundIntervalMs: semanticIndexConfig.requestIntervalMs,
  });
  const semanticVectorCache = createVectorCache();
  const semanticInference = createSemanticInference(hostCredentialAuthority, {
    readGlobalSettings: () => hostCredentialAuthority.readGlobalInferenceSettings(),
  }, { ledger: createSemanticInferenceLedger({ dataDir: VARIN_DATA_DIR, hostId }) });
  const semanticRuntime = createWorkspaceSemanticRuntime({
    runtimeInference: semanticInference,
    dataDir: semanticIndexConfig.storageDirectory ?? VARIN_DATA_DIR,
    hostId,
    // HR3: one shared worker serves settings/inference for every resource root;
    // indexing no longer spawns a workspace worker per directory.
    configCwd: VARIN_DATA_DIR,
    documents: documentsAuthority,
    readDraft: async (sessionId, context, resourceId, workspaceId) => {
      const source = await sourceViewRuntime.readSource(sessionId, context, resourceId, workspaceId);
      if (source.status !== 'working-branch') return source;
      if (source.message || source.missing || source.base64 === undefined) {
        return { status: 'unavailable', message: source.message ?? 'The working-branch source is missing' };
      }
      return {
        status: 'ready',
        content: Buffer.from(source.base64, 'base64').toString('utf8'),
        revision: source.revision,
        source: 'working-branch',
      };
    },
    structureSource,
    searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
    isIndexablePath: async (id, resourceId, signal, options) => catalogFileSearch.isSearchableFile(
      (await documentsAuthority.inspectWorkspace(id)).root, resourceId, signal, options,
    ),
    embedder: localEmbedder,
    vectorCache: semanticVectorCache,
    scheduler: semanticScheduler,
    getIndexScope: projectIndexScope.get,
    includeIgnoredDirectories: semanticIndexConfig.includeIgnoredDirectories ?? [],
    getBroker: getReadyPiRuntimeBroker,
    executionViews: threadExecutionViews,
    workingBranches: workingBranchLookups,
    onBindingChanged: (workspaceId) => queueMicrotask(() => {
      // The shared inference state publishes global binding changes; every
      // knowledge scope resolves its embedder through it, so refresh all.
      if (workspaceId === GLOBAL_INFERENCE_SCOPE) knowledgeVectors?.refreshAll();
      else knowledgeVectors?.refreshWorkspace(workspaceId);
    }),
    onError: (error) => console.error('[HarnessKnowledge] Semantic runtime failed:', errorMessage(error)),
  });
  semanticRuntimeHolder.current = semanticRuntime;
  const retrievalComposition = createRetrievalComposition(extensionRuntime, {
    structure: structureSource,
    prepareSemantic: async (scope, signal) => {
      const query = scope.query;
      if (!query) throw new Error('Native semantic retrieval requires its Run identity');
      const active = signal ?? new AbortController().signal;
      const relative = (value: string): string => {
        if (value.includes('\\') || value.startsWith('/') || value.includes(':') || value.includes('\0')
          || value.split('/').includes('..')) throw new Error('Invalid native semantic root');
        return value.split('/').filter(part => part && part !== '.').join('/');
      };
      const grant = kernelClient.retrievalGrant(query);
      const roots = (query.paths ?? grant.pathScopes).map(relative);
      const authorize = async (requestSignal: AbortSignal): Promise<void> => {
        requestSignal.throwIfAborted();
        await liveSources.validate(query, requestSignal);
        const current = kernelClient.retrievalGrant(query);
        const granted = current.pathScopes.map(relative);
        if (!roots.length || roots.some(root => !granted.some(parent => !parent || root === parent || root.startsWith(`${parent}/`)))) {
          throw new Error('Native semantic roots are outside the Run grant');
        }
      };
      await authorize(active);
      return semanticRuntime.acquireQuery({ workspaceId: query.workspaceId, threadId: query.threadId,
        runId: query.runId, invocation: query.invocation, roots, signal: active, authorize,
        assertAuthorized: () => { kernelClient.retrievalGrant(query); } });
    },
  });
  kernelClient.setRetrievalOwner(createRetrievalOwner({ documents: documentsAuthority, kernel: kernelClient,
    validateSource: liveSources.validate,
    preparePipeline: (query, signal) => retrievalComposition.prepare({ threadId: query.threadId, query,
      workspaceId: query.liveRoot.canonicalRoot, ...(query.projectId ? { projectId: query.projectId } : {}) }, signal),
  }));

  const indexDirectories = createIndexDirectoryManager({
    dataDir: VARIN_DATA_DIR,
    resolve: async (directory) => {
      const { workspaceId } = await documentsAuthority.resolveWorkspace({ path: directory });
      const { root } = await documentsAuthority.inspectWorkspace(workspaceId);
      if (excludedFromIndex(projectIndexScope.get(), root)) throw new Error('Bot private directories cannot be indexed');
      return { path: root, workspaceId };
    },
    apply: async (entries) => {
      if (!projectIndexScope.update(entries.filter((entry) => entry.state === 'active').map((entry) => entry.path),
        entries.filter((entry) => entry.state === 'paused').map((entry) => entry.path),
        entries.filter((entry) => entry.state === 'deleting' || entry.state === 'removed').map((entry) => entry.path))) return;
      symbolGraphRuntime.refreshIndexScope();
      await semanticRuntime.refreshIndexScope();
    },
    check: async (entry, requestSignal, { manual }) => {
      const scope = projectIndexScope.get();
      const signal = AbortSignal.any([scope.signal, requestSignal]);
      signal.throwIfAborted();
      await Promise.all([
        symbolGraphRuntime.scanWorkspace(entry.workspaceId, { signal, manual }),
        semanticRuntime.scanWorkspace(entry.workspaceId, { signal, manual, forceContentVerification: manual }),
      ]);
      signal.throwIfAborted();
      const progress = semanticRuntime.indexStatuses().find((status) => status.workspaceId === entry.workspaceId)?.progress;
      if (progress?.phase === 'failed') throw new Error(progress.error ?? 'Index update failed');
    },
    purge: async (directory) => semanticIndexManagement.withCacheMaintenance(async () => {
      const saved = await semanticIndexManagement.read();
      const caches = [...new Set([semanticIndexManagement.activeDirectory(), ...saved.retainedDirectories])];
      const scope = projectIndexScope.get();
      const preserved = [...scope.directories, ...(scope.pausedDirectories ?? [])]
        .filter((candidate) => insideDirectory(directory, candidate) && indexPathAllowed(scope, candidate, true));
      for (const resource of await documentsAuthority.listWorkspaceRegistrations()) {
        if (!insideDirectory(directory, resource.canonicalPath) && !insideDirectory(resource.canonicalPath, directory)) continue;
        if (preserved.some((candidate) => insideDirectory(candidate, resource.canonicalPath))) continue;
        await semanticRuntime.withIndexMaintenance(resource.workspaceId, async () => {
          for (const semanticDirectory of caches) await purgeSemanticWorkspaceCache({ semanticDirectory,
            workspaceId: resource.workspaceId, resourceRoot: resource.canonicalPath, removedDirectory: directory, preserveDirectories: preserved });
        });
        const storeFile = path.join(VARIN_DATA_DIR, 'knowledge', hostId, `${knowledgeStoreKeyForScope(resource.workspaceId)}.tdb`);
        if (fs.existsSync(storeFile)) await symbolGraphRuntime.purgeDirectory(resource.workspaceId, directory, resource.canonicalPath, preserved);
      }
    }),
    cached: async () => {
      const saved = await semanticIndexManagement.read();
      const caches = [...new Set([semanticIndexManagement.activeDirectory(), ...saved.retainedDirectories])];
      const result: Array<{ path: string; workspaceId: string }> = [];
      for (const resource of await documentsAuthority.listWorkspaceRegistrations()) {
        if (caches.some((cache) => fs.existsSync(path.join(cache, 'workspace', resource.workspaceId)))) {
          result.push({ path: resource.canonicalPath, workspaceId: resource.workspaceId });
        }
      }
      return result;
    },
    onError: (error) => console.error('[ProjectIndex]', errorMessage(error)),
  });
  const unsubscribeProjectIndex = settingsRuntime.subscribe((settings) => {
    prewarmProject(settings);
    void indexDirectories.syncProjects(projectDirectories(settings).filter((directory) =>
      !excludedFromIndex(projectIndexScope.get(), directory))).catch((error) => {
      console.error('[ProjectIndex] Scope refresh failed:', errorMessage(error));
    });
  });
  researchDecideDeps.fastDecisionStatus = semanticRuntime.fastDecisionStatus;
  researchDecideDeps.fastDecision = semanticRuntime.fastDecision;
  registerLocalSemanticComponentRoutes(app, {
    manager: localSemanticComponent,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerSemanticIndexRoutes(app, {
    management: semanticIndexManagement,
    runtime: semanticRuntime,
    directories: indexDirectories,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  knowledgeVectors = createKnowledgeVectorRuntime({
    dataDir: VARIN_DATA_DIR,
    hostId,
    scheduler: semanticScheduler,
    cache: semanticVectorCache,
    resolveEmbedder: semanticRuntime.resolveKnowledgeEmbedder,
  });
  catalogScan.start = (workspaceId: string): void => {
    // Session-owned stores have no resource root to index; callers pass either
    // the scope id or its hashed store key depending on the loop they run in.
    if (isSessionScopeId(workspaceId) || isSessionStoreKey(workspaceId)
      || isBotScopeId(workspaceId) || isBotStoreKey(workspaceId)) return;
    queueMicrotask(() => {
      void symbolGraphRuntime.scanWorkspace(workspaceId).catch((error) => {
        console.error('[HarnessKnowledge] Catalog scan failed:', errorMessage(error));
      });
      void semanticRuntime.scanWorkspace(workspaceId)
        .catch((error) => {
          console.error('[HarnessKnowledge] Semantic scan failed:', errorMessage(error));
        });
    });
  };
  for (const storeKey of knowledgeStores.keys()) {
    // Store keys may be hashed session scopes — only real resource roots index.
    if (isSessionStoreKey(storeKey) || isBotStoreKey(storeKey)) continue;
    catalogScan.start(storeKey);
  }
  await indexDirectories.load();
  await indexDirectories.syncProjects(projectDirectories(await readSettingsFromDisk()).filter((directory) =>
    !excludedFromIndex(projectIndexScope.get(), directory)));
  const observeKnowledgeGitStatus = createGitStatusObserver({
    resolveWorkspaceId: (scope) => documentsAuthority.resolveScopeId(scope),
    observe: (event) => knowledgeContextRuntime.observeGitStatus(event),
    onError: (error) => console.error('[HarnessKnowledge] Git status observer failed:', errorMessage(error)),
  });
  observeKnowledgeDocumentMutation = (event) => {
    languageSupervisor.observeDocumentMutation(event);
    knowledgeContextRuntime.observeDocumentMutation(event);
    symbolGraphRuntime.observeDocumentMutation(event);
    semanticRuntime.observeDocumentMutation(event);
  };
  const knowledgeLanguageSubscriptions = new Map<string, { close(): void }>();
  const bindKnowledgeSession = (sessionId: string, scopeId: string): void => {
    knowledgeContextRuntime.bindSession(sessionId, scopeId);
    // Language subscriptions are workspace-addressed; session- and bot-owned
    // scopes have no workspace LSP to observe.
    if (isSessionScopeId(scopeId) || isBotScopeId(scopeId) || knowledgeLanguageSubscriptions.has(scopeId)) return;
    const workspaceId = scopeId;
    knowledgeLanguageSubscriptions.set(workspaceId, languageSupervisor.subscribe(workspaceId, (value) => {
      const event = recordOf(value);
      if (event.kind !== 'diagnostics' || typeof event.resourceId !== 'string') return;
      // Zone 2 reports diagnostics that follow a user edit, so only the editor
      // view qualifies; the agent view's answers are the agent's own feedback.
      if (event.view !== SURFACE_LANGUAGE_VIEW) return;
      const diagnostics = Array.isArray(event.items)
        ? event.items.map(recordOf).filter((item) => item.severity === 'error' || item.severity === 'warning')
        : [];
      if (diagnostics.length === 0) return;
      knowledgeContextRuntime.observeDiagnostics({
        workspaceId,
        sessionId: 'lsp',
        path: event.resourceId,
        count: diagnostics.length,
        worst: diagnostics.some((item) => item.severity === 'error') ? 'error' : 'warning',
      });
    }));
  };
  bindThreadKnowledgeSession = (sessionId, workspaceId) => {
    bindKnowledgeSession(sessionId, workspaceId);
    prewarmSession(sessionId, sessionSnapshots.get(sessionId)?.cwd, true);
  };

  const terminalCommandProjector = createTerminalCommandProjector({
    resolveWorkspaceId: (cwd) => documentsAuthority.resolveScopeId(cwd),
    observe: createTerminalCommandObserveAdapter(knowledgeContextRuntime),
    drain: () => knowledgeContextRuntime.drain(),
    listBoundSessions: (workspaceId) => knowledgeContextRuntime.listBoundSessions(workspaceId),
    inspectCwd: (terminalId) => terminalRuntime?.inspectSession(terminalId)?.cwd,
    onError: (error) => {
      console.error('[HarnessKnowledge] Terminal command projection failed:', errorMessage(error));
    },
  });

  // Zone 2 provider — assembles material from the knowledge store
  async function zone2Provider(request: Parameters<typeof knowledgeContextRuntime.zone2Material>[0]) {
    return knowledgeContextRuntime.zone2Material(request);
  }

  // Todo deps provider
  async function todoDepsProvider(sessionId: string): Promise<TodoToolDeps> {
    const store = await getKnowledgeStoreForSession(sessionId);
    if (!store) throw new Error('No knowledge store for session');
    return {
      store,
      sessionId,
    };
  }

  // Recall deps provider
  async function recallDepsProvider(sessionId: string, workspaceId: string | null): Promise<RecallToolDeps> {
    const owningWorkspaceId = await owningKnowledgeScopeIdForSession(sessionId, workspaceId)
      ?? sessionScopeId(sessionId);
    const workspaceStore = await getKnowledgeStoreForScope(owningWorkspaceId);
    const ownScopeId = sessionScopeId(sessionId);
    const sessionStore = ownScopeId !== owningWorkspaceId && await knowledgeStoreExistsForScope(ownScopeId)
      ? await getKnowledgeStoreForScope(ownScopeId)
      : null;
    return {
      workspaceStore,
      userStore: await getUserKnowledgeStore(),
      ...(sessionStore ? { sessionStore } : {}),
      sessionId,
      workspaceId: owningWorkspaceId,
      associated: await workAssociationForSession(sessionId),
      ...(knowledgeVectors ? { vectors: knowledgeVectors } : {}),
    };
  }

  // D-240: one collector serves both entry points — lsp.* navigation writes its
  // already-obtained resolutions back, and related.query deliberately resolves
  // around its anchor. Both persist only against already-open stores.
  const relationCollector = createRelationCollector({
    documents: documentsAuthority,
    supervisor: languageSupervisor,
    getStore: (workspaceId) => knowledgeStores.get(knowledgeStoreKeyForScope(workspaceId)) ?? null,
  });

  const discoveredShells = discoverShells();
  const shellPathResolver = createShellPathResolver({
    interpreter: (sessionId) => harnessServiceHost.getInterpreter(sessionId),
    spawn: kernelProcesses.spawn,
  });
  const harnessServiceHost = createHarnessServiceHost({
    agentPersonalization,
    discoveredShells,
    memoryService,
    computerService,
    sessionInstructionsFor: async (sessionId) => (
      (await botService.botForSession(sessionId) ?? await consultBotForSession(sessionId))?.instructions ?? null
    ),
    bots: { get: (botId) => botService.get(botId) },
    pathLockService: kernelPathLockService,
    verification: verificationCoordinator,
    experimentService,
    resourceService,
    sourceService,
    settingsService,
    followUpService,
    scheduledTaskService,
    managedRemoteTargets,
    readExploreFile: createExploreFileReader(
      documentsAuthority,
      harnessPathAuthority,
      (sessionId, resourceId, workspaceId) => workingBranchLookups.exploreFile(sessionId, resourceId, workspaceId),
      sourceViewRuntime.readExploreSource,
    ),
    storeRetrievalArtifact: retrievalArtifacts.storeArtifact,
    readRetrievalArtifact: retrievalArtifacts.readArtifact,
    readRetrievalArtifactSlice: retrievalArtifacts.readArtifactSlice,
    protectRetrievalEvidence: async (input) => {
      const current = await threadRegistry.getThreadById(input.workspaceId, input.threadId);
      if (!current || current.activeRunId !== input.runId || current.pendingEvidence === undefined) {
        if (current) await retrievalArtifacts.syncThreadEvidence(input.workspaceId, current);
        throw new Error(`Retrieval evidence run is no longer active: ${input.runId}`);
      }
      await retrievalArtifacts.promotePendingEvidence(input);
      const latest = await threadRegistry.getThreadById(input.workspaceId, input.threadId);
      if (latest) await retrievalArtifacts.syncThreadEvidence(input.workspaceId, latest);
    },
    lookupWebFetchReceipt: retrievalArtifacts.lookupReceipt,
    releaseRetrievalTemporaryArtifacts: retrievalArtifacts.releaseTemporaryArtifacts,
    releaseWebFetchReceipts: async (sessionId, fallbackWorkspaceId) => {
      const binding = await threadRegistry.getSessionBinding(sessionId).catch(() => null);
      const workspaceId = binding?.owningScopeId ?? fallbackWorkspaceId ?? sessionScopeId(sessionId);
      await retrievalArtifacts.releaseReceiptAuthority(workspaceId, {
        owningWorkspaceId: workspaceId,
        sessionId,
        ...(binding ? { threadId: binding.threadId, runId: binding.runId } : {}),
      });
    },
    pinWorkingBranchQuery: (sessionId, pinOptions) => workingBranchLookups.pinQuery(sessionId, pinOptions),
    agentInputDraftPaths: (sessionId, context, workspaceId) => documentsAuthority.agentInputDraftPaths(sessionId, context, workspaceId),
    documentReadSource: sourceViewRuntime.readSource,
    documentPathOverlay: sourceViewRuntime.pathOverlay,
    documentWriteGuard: sourceViewRuntime.writeGuard,
    documentSurfaceWrite: sourceViewRuntime.surfaceWrite,
    documentBranchWrite: sourceViewRuntime.branchWrite,
    workingBranchEnsureMaterialized: (sessionId, signal) => {
      if (!threadRuntime) {
        return Promise.resolve({ status: "failed" as const, message: "Thread runtime is unavailable for materialization" });
      }
      return threadRuntime.materializeExecutionView(sessionId, signal);
    },
    commitAgentInputContext: sourceViewRuntime.commitContext,
    releaseAgentInputContext: sourceViewRuntime.releaseContext,
    dropAgentInputContexts: (sessionId) => documentsAuthority.dropAgentInputSnapshots(sessionId),
    search: async (request, options) => workspaceContentSearch.searchContent({
      query: request.query,
      workspaceId: request.workspaceId,
      maxResults: request.maxResults,
      ...(request.before === undefined ? {} : { before: request.before }),
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.paths === undefined ? {} : { paths: request.paths }),
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.excludeResourceIds === undefined ? {} : { excludeResourceIds: request.excludeResourceIds }),
      ...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
      ...(request.fixedStrings === undefined ? {} : { fixedStrings: request.fixedStrings }),
    }, options),
    resolveWorkspaceRoot: async (workspaceId) => {
      try {
        const workspace = await documentsAuthority.getWorkspace(workspaceId);
        return workspace.root;
      } catch {
        return null;
      }
    },
    resolveScopeRoot: async (canonicalPath) => {
      try {
        const mapping = await documentsAuthority.ensureResourceRoot(canonicalPath, 'directory');
        return { workspaceId: mapping.workspaceId, root: mapping.canonicalPath };
      } catch {
        return null;
      }
    },
    pathAuthority: harnessPathAuthority,
    defaultExplorePaths: async (actor) => {
      const workspace = recordOf(sessionSnapshots.get(actor.sessionId)?.workspace);
      if (workspace.kind !== 'workspace' || typeof workspace.id !== 'string') return [];
      if (await botService.botForSession(actor.sessionId)) return [];
      const projects = sanitizeProjects((await readSettingsFromDisk()).projects) ?? [];
      const project = projects.find((entry) => entry.id === workspace.id);
      // Isolated worktrees keep their execution view; project folder edits do
      // not redirect an already-running isolated task back to the source tree.
      if (!project || !actor.cwd || !projectContainsPath(project, actor.cwd)) return [];
      const authorized = await Promise.all(projectFolders(project).map((directory) =>
        harnessPathAuthority.resolve(actor, directory, { allowMissing: false })));
      return authorized.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    },
    createTerminalSession: async (input) => {
      const runtime = terminalRuntime;
      if (!runtime?.createTerminalSession) {
        throw new Error("Terminal runtime is not available");
      }
      return runtime.createTerminalSession(input);
    },
    registerWriter: async (sessionId, workspaceRoot) => {
      const writer = await documentsAuthority.registerWriterForScope(
        workspaceRoot,
        { kind: 'harness-bash', id: sessionId },
        { mode: 'process', purpose: 'harness-bash' },
      );
      if (!writer) throw new Error('Harness shell has no workspace writer authority');
      return { close: async () => { await writer.close(); } };
    },
    diagnosticsProvider: createLanguageSupervisorDiagnosticsProvider(languageSupervisor, {
      documents: documentsAuthority,
      readSource: sourceViewRuntime.readSource,
      resolveTarget: sourceViewRuntime.resolveLanguageTarget,
    }),
    lspNavigationServices: createLspNavigationServices({
      documents: documentsAuthority,
      supervisor: languageSupervisor,
      readSource: sourceViewRuntime.readSource,
      resolveTarget: sourceViewRuntime.resolveLanguageTarget,
      // Write-behind (D-240): a disk-bound lsp.references/lsp.definition answer
      // becomes graph rows so later related/explore queries reuse the
      // resolution instead of re-asking the language view.
      recordRelations: async (input) => {
        const owningWorkspaceId = await owningKnowledgeScopeIdForSession(input.sessionId, input.workspaceId);
        // A child execution view may contain unpublished branch text. It can use
        // LSP answers in that view, but those rows must not enter the owning
        // workspace graph as committed facts.
        if (!owningWorkspaceId || owningWorkspaceId !== input.workspaceId) return { recorded: 0 };
        const root = (await documentsAuthority.inspectWorkspace(input.workspaceId)).root;
        if (!indexPathAllowed(projectIndexScope.get(), path.resolve(root, input.anchor.path))) return { recorded: 0 };
        return relationCollector.record(owningWorkspaceId, { ...input,
          sites: input.sites.filter((site) => indexPathAllowed(projectIndexScope.get(), path.resolve(root, site.path))) });
      },
    }),
    structureSource,
    // Reading relations must not open a database or start a catalog scan, so
    // this consults an already-open store and reports "not answered" otherwise.
    // The session's own knowledge work opens it (D-112).
    graphRecall: async (sessionId, executionWorkspaceId) => {
      const resourceStore = knowledgeStores.get(knowledgeStoreKeyForScope(executionWorkspaceId));
      if (resourceStore) return {
        workspaceId: executionWorkspaceId,
        store: resourceStore,
        directFactsCompatible: true,
      };
      const owningWorkspaceId = await owningKnowledgeScopeIdForSession(sessionId, executionWorkspaceId)
        ?? sessionScopeId(sessionId);
      if (!owningWorkspaceId) return null;
      const store = knowledgeStores.get(knowledgeStoreKeyForScope(owningWorkspaceId));
      return store ? {
        workspaceId: owningWorkspaceId,
        store,
        directFactsCompatible: owningWorkspaceId === executionWorkspaceId,
      } : null;
    },
    // Bounded live resolution for related.query — one references +
    // call-hierarchy pass per exact-match definition (D-240).
    relationCollector,
    semanticRecall: semanticRuntime.semanticRecall,
    harnessSettings: semanticRuntime.harnessSettings,
    rerankExploreViews: semanticRuntime.rerankExploreViews,
    fastDecisionStatus: semanticRuntime.fastDecisionStatus,
    fastDecision: semanticRuntime.fastDecision,
    permissionAudit: (record) => {
      broadcastGlobalUiEvent?.({
        type: 'varin:harness-permission-decision',
        properties: record,
      });
    },
    fileRelations: async (workspaceId, resourceId) => {
      const store = knowledgeStores.get(knowledgeStoreKeyForScope(workspaceId));
      if (!store) throw new Error(`knowledge store is not open for workspace ${workspaceId}`);
      const relations = await store.getFileRelations(resourceId);
      if (!relations) return null;
      if (
        relations.imports.length === 0
        && relations.connections.length === 0
        && relations.associations.length === 0
        && relations.references.length === 0
        && relations.calls.length === 0
      ) {
        return null;
      }
      return {
        path: relations.path,
        documentRevision: relations.documentRevision,
        incomplete: relations.linksIncomplete,
        imports: relations.imports.map(({ specifier, line }) => ({ specifier, line })),
        connections: relations.connections.map(({ callee, literal, line }) => ({ callee, literal, line })),
        associations: relations.associations.map(({ callee, literal, line }) => ({ callee, literal, line })),
        references: relations.references.map((record) => ({
          value: record.value,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          ...(record.targetPath !== undefined ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
        calls: relations.calls.map((record) => ({
          callee: record.targetName ?? record.value,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          ...(record.targetPath !== undefined ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
      };
    },
    // Web services — fetch is always available (SSRF-guarded); read and search
    // depend on reader model / search provider configuration, wired later.
    webFetchService,
    documentReader,
    documentReadingSettings: async (sessionId) => {
      const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {});
      return resolveHarnessDocumentReadingSettings(recordOf(snapshot.global.harness).documentReading);
    },
    materialWebPolicy: async (sessionId) => {
      const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {});
      const domains = resolveHarnessWebBinding(snapshot).settings?.domains;
      return { ...(domains?.allow === undefined ? {} : { allow: domains.allow }), block: domains?.block ?? [] };
    },
    readAuthorizedDiskFile: (ctx, authorized) => harnessPathAuthority.readAuthorizedFile(
      ctx.actor,
      authorized,
      ctx.signal,
    ),
    readAuthorizedDiskPage: (ctx, authorized, page) => harnessPathAuthority.readAuthorizedPage(ctx.actor, authorized, page, ctx.signal),
    readMaterialFile: async (ctx, authorized) => {
      ctx.signal.throwIfAborted();
      const before = await harnessPathAuthority.resolve(ctx.actor, authorized.inputPath, { allowMissing: true });
      if (!before || before.canonicalResourceId !== authorized.canonicalResourceId) throw new Error('Document path changed before reading');
      const source = await harnessServiceHost.documentReadSource!(ctx.sessionId, ctx.inputContext ?? { source: 'disk' }, authorized.resourceId, authorized.workspaceId);
      let bytes: Buffer;
      if (source.status === 'working-branch') {
        if (source.message || source.missing || source.base64 === undefined) throw new Error(source.message ?? 'Document is unavailable in the working branch');
        bytes = Buffer.from(source.base64, 'base64');
      } else if (source.status === 'ready') {
        bytes = encodeDocumentText(source);
      } else if (source.status === 'unavailable') {
        throw new Error(source.message);
      } else {
        bytes = await harnessPathAuthority.readAuthorizedFile(ctx.actor, authorized, ctx.signal);
      }
      const after = await harnessPathAuthority.resolve(ctx.actor, authorized.inputPath, { allowMissing: true });
      ctx.signal.throwIfAborted();
      if (!after || after.canonicalResourceId !== authorized.canonicalResourceId) throw new Error('Document path changed while reading');
      return bytes;
    },
    ...(webSearchService ? { webSearchService } : {}),
    networkDiagnostics: { diagnose: (url, override) => egressRuntime.diagnose(url, override) },
    researchSearchService,
    researchDecideService,
    materialCollectionsService,
    // Phase 2: knowledge, memory, zone2, compaction, todo, recall
    zone2Provider,
    onShellStarted: (sessionId, event) => knowledgeContextRuntime.observeShellStarted(sessionId, event).then(() => undefined),
    onShellOutput: (sessionId, event) => knowledgeContextRuntime.observeShellOutput(sessionId, event).then(() => undefined),
    onShellCompleted: (sessionId, event) => knowledgeContextRuntime.observeShellCompletion(sessionId, event).then(() => undefined),
    onSessionCompacted: (sessionId) => knowledgeContextRuntime.resetSessionObservationBaselines(sessionId),
    todoDepsProvider,
    recallDepsProvider,
    threadRegistry,
    threadCaptureDraftBaseline: (sessionId, workspaceId, context) => threadRuntime!.captureDraftBaseline(sessionId, workspaceId, context),
    threadPrepareIsolatedBranch: (input) => threadRuntime!.prepareIsolatedBranch(input),
    threadDiscardPreparation: async (scopeId, parent, threadId) => {
      // Use durable deletion so a failed cleanup keeps its branch/directory
      // ownership and can resume after restart.
      await threadRuntime!.deleteUser(scopeId, parent, threadId);
    },
    agentInputSurfaceOwner: documentsAuthority.agentInputSurfaceOwner,
    threadTranscriptReader,
    threadSpawnSession: (input) => threadRuntime!.spawn(input),
    threadKillSession: (threadId: string, keepWorktree?: boolean, workspaceId?: string) => (
      threadRuntime!.kill(threadId, keepWorktree, workspaceId)
    ),
    requireThreadMergeJournal: true,
    threadApplyWorktreeDiff: (workspaceId, parent, threadId, resultRevision, executionId, extras) => (
      threadRuntime!.merge(workspaceId, parent, threadId, resultRevision, executionId, extras)
    ),
    threadUpdateBaseline: (workspaceId, parent, threadId, resultRevision, extras) => (
      threadRuntime!.updateBaseline(workspaceId, parent, threadId, resultRevision, extras)
    ),
    threadSubmitCode: (...args) => threadRuntime!.submitCode(...args),
    threadSendToSession: async (sessionId, message, meta) => {
      if (!piRuntimeBroker.activeSessionIds.includes(sessionId)) await piRuntimeBroker.openSession({ sessionId });
      await threadRuntime!.send(sessionId, message, meta);
    },
    threadCaptureInputContext: (input) => threadRuntime!.captureInputContext(input.sessionId),
    threadHistoryEntries: (sessionId) => piRuntimeBroker.previewSessionEntries(sessionId, undefined, "branch"),
    runCompactionTask: (actor, spec, signal) => piRuntimeBroker.runCompactionTask(actor.sessionId, spec, {
      signal,
      registerWorker: (workerId) => harnessServiceHost.registerAuxiliaryActor(actor, workerId, spec.fixedLeafEntryId),
      dropWorker: (workerId) => {
        harnessRouter.cancelWorker(workerId);
        harnessServiceHost.dropAuxiliaryActor(workerId);
      },
    }),
    threadContinueRun: (input) => threadRuntime!.continueRun(input),
    threadResumeLost: (workspaceId, parent) => threadRuntime!.resumeLostForParent(workspaceId, parent),
  });
  harnessShellActivity.hasActiveCommandAtDirectory = (directory) => (
    harnessServiceHost.hasActiveCommandAtDirectory(directory)
  );
  harnessShellActivity.closeSessionShell = harnessServiceHost.closeSessionShell;
  const harnessSessionRegistration = createHarnessSessionRegistration({
    host: harnessServiceHost,
    readSettings: async ({ actor }) => {
      const broker = getReadyPiRuntimeBroker();
      if (!broker) throw new Error('Pi settings are unavailable');
      return broker.requestForSession(actor.sessionId, 'settings.get', {});
    },
    resolveWorkspaceRoot: async (workspaceId) => {
      try {
        const workspace = await documentsAuthority.inspectWorkspace(workspaceId);
        return workspace.root;
      } catch {
        return null;
      }
    },
  });
  const unregisterMaterialToolCapability=extensionRuntime.capabilities.register(MATERIAL_SNAPSHOT_CAPABILITY,createMaterialToolOwner(webMaterials));
  const unregisterChildIntegrationCapability = extensionRuntime.capabilities.register(CHILD_INTEGRATION_CAPABILITY,
    createIntegrationToolOwner({ runtime: agentRuntime, coordinator: threadIntegrationCoordinator,
      onCleanupError: (_operationId, _error) => console.error('[Integration] Source grant cleanup requires attention'),
      openTarget: createIntegrationTargetOpener({ kernel: kernelClient, runtime: agentRuntime, storage: kernelStorageAdapter,
        recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore, resolveLiveSource: liveSources.validate,
        documents: documentsAuthority }) }));
  const unregisterDocumentsCapability = extensionRuntime.capabilities.register(
    'workspace.documents',
    createDocumentsCapabilityHandler(documentsAuthority),
  );
  const unregisterWorkspaceRecoveryCapability = extensionRuntime.capabilities.register(
    'workspace.recovery-primitives',
    createWorkspaceRecoveryCapabilityHandler(recoveryEngineForOwner),
  );
  const unregisterSearchCapability = extensionRuntime.capabilities.register(
    'workspace.search',
    createWorkspaceSearchCapabilityHandler(workspaceContentSearch),
  );
  const unregisterLanguageCapability = extensionRuntime.capabilities.register(
    'workspace.language',
    createLanguageCapabilityHandler(languageSupervisor),
  );
  const runRuntime = createRunRuntime({
    documents: documentsAuthority,
    spawn: kernelProcesses.spawn,
    pathModule: path,
    env: process.env,
    isTrusted: workspaceRootGuard,
  });
  const unregisterTasksCapability = extensionRuntime.capabilities.register(
    'workspace.tasks',
    createWorkspaceTasksCapabilityHandler(runRuntime.tasks),
  );
  const unregisterDebugCapability = extensionRuntime.capabilities.register(
    'workspace.debug',
    createWorkspaceDebugCapabilityHandler(runRuntime.debug),
  );
  const unregisterTestCapability = extensionRuntime.capabilities.register(
    'workspace.test',
    createWorkspaceTestCapabilityHandler(runRuntime.tests),
  );
  const unregisterPiRuntimeCapability = extensionRuntime.capabilities.register('pi-runtime', async (method, value) => {
    if (method !== 'request' || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('The pi-runtime capability expects a request object');
    }
    const request = value;
    const target = request.target && typeof request.target === 'object' && !Array.isArray(request.target)
      ? request.target
      : {};
    const hostMethod = typeof request.method === 'string' ? request.method : '';
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    let result;
    if (target.kind === 'catalog') result = await piRuntimeBroker.requestCatalogDynamic(hostMethod, params);
    else if (target.kind === 'workspace' && typeof target.cwd === 'string') {
      result = await piRuntimeBroker.requestForWorkspaceDynamic(target.cwd, hostMethod, params);
    } else if (target.kind === 'session' && typeof target.sessionId === 'string') {
      result = await piRuntimeBroker.requestForSessionDynamic(target.sessionId, hostMethod, params);
    } else throw new Error('The pi-runtime capability target is invalid');
    return toJsonValue(result ?? null);
  });
  await extensionRuntime.start().catch((error) => {
    console.warn('[Varin Extensions] Host reconciliation failed:', error?.message || error);
  });
  const unregisterWorkbenchLayoutService = await registerBuiltinWorkbenchLayoutService(extensionRuntime);
  // Scheduled runs report the real session outcome, not the dispatch receipt:
  // the executor waits on the Pi event stream until the run settles (D-307).
  const sessionSettleTracker = createSessionSettleTracker();
  scheduledTasksRuntime.setExecutor(createPiScheduledTaskExecutor({
    broker: piRuntimeBroker,
    awaitCompletion: (sessionId) => sessionSettleTracker.waitForSettled(sessionId),
    forgetCompletion: (sessionId) => sessionSettleTracker.forget(sessionId),
  }));
  const sessionNames = new Map<string, string>();
  recoveryTurnCoordinator = createRecoveryTurnCoordinator({
    documents: documentsAuthority,
    getSessionSnapshot: (sessionId) => sessionSnapshots.get(sessionId) ?? null,
    invokeService: (request) => extensionRuntime.invokeService(request),
    respondMutation: async (request, accepted) => {
      await piRuntimeBroker.requestForSession(
        request.sessionId,
        'workspace.mutation.respond',
        { accepted, requestId: request.requestId, sessionId: request.sessionId },
      );
    },
    observeToolWrite: async (workspaceId, absolutePath) => {
      await documentsAuthority.observeAgentWrite(workspaceId, absolutePath);
      const workspace = await documentsAuthority.getWorkspace(workspaceId);
      languageSupervisor.observeDocumentMutation({ workspaceId, resourceId: path.relative(workspace.root, absolutePath), kind: 'modified' });
      await semanticRuntime.observeToolWrite(workspaceId, absolutePath);
    },
    writerTracker: piWriterTracker,
  });
  // ── Harness router ─────────────────────────────────────────────────
  // Consumes harness.request events from the broker stream (same
  // subscription as recovery turn coordinator) and dispatches to the
  // registered harness services.
  const harnessRouter = createHarnessRouter({
    onRequestDiagnostic: (event) => {
      console.error('[HarnessDeadline]', JSON.stringify({ ...event, storage: knowledgeStorageActivity() }));
    },
    assertExecution: assertBotSessionExecution,
    resolveWorkTarget: async (sessionId) => (await threadRegistry.threadEnvironmentForSession(sessionId))?.environment?.workTarget,
    // Route by the requesting worker, not by session: a session's internal
    // compaction worker is pinned for identity but is not the session worker.
    respond: async (identity, requestId, outcome) => {
      const delivered = await piRuntimeBroker.requestForWorker(
        identity.workerId,
        'harness.respond',
        buildHarnessRespondParams(identity.sessionId, requestId, outcome),
      );
      if (!delivered.accepted) throw new Error('Harness response was no longer accepted by its worker');
    },
    resolveActor: (identity, signal) => harnessSessionRegistration.resolveActor(identity, signal),
    authorizeWorkspacePath: (actor, candidate, options) => harnessPathAuthority.resolve(actor, candidate, options),
    cancelExploreQuery: (actor, queryId) => harnessServiceHost.exploreQueryStore.cancel(actor, queryId),
  });
  registerHarnessServices(harnessRouter, harnessServiceHost);
  const mcpHarness = createMcpHarnessServices(mcpAuthority, async ctx => {
    // Read the existing session authority so one-session trust is not mistaken for denial.
    // Unlike settings.get (which reloads files), this scope cut is read-only and out-of-band.
    const settings = await piRuntimeBroker.requestForSession(ctx.sessionId, 'settings.context', {});
    const configCwd = ctx.actor.cwd ?? ctx.actor.authorityRoot ?? mcpAgentDir;
    if (path.resolve(settings.cwd) !== path.resolve(configCwd)) throw new Error('MCP session configuration scope changed');
    return {
      agentDir: mcpAgentDir, configCwd, executionCwd: ctx.actor.cwd ?? mcpAgentDir,
      // MCP remains a Host-owned capability. A remote shell placement does not relocate it.
      environmentId: ctx.workspaceId ? `${hostId}:${ctx.workspaceId}` : `${hostId}:global`,
      executionScope: ctx.workspaceId ? 'workspace' : 'global',
      projectTrusted: settings.projectTrusted, sessionId: ctx.sessionId,
    };
  });
  harnessRouter.register('mcp.owner', mcpHarness.services['mcp.owner']);
  botLifecycleRuntime = createBotLifecycleRuntime({
    hostId, registry: threadRegistry, runtime: threadRuntime, broker: piRuntimeBroker, computers: computerService,
    stopSessionProcesses: harnessServiceHost.closeSessionShell,
    stopRoot: (sessionId) => botRootRuntime.cancelSession(sessionId, 'Bot sleeping'),
    stopMemory: (scopeId) => memoryOrganizer.suspendScope(scopeId),
    resumeMemory: (scopeId) => memoryOrganizer.resumeScope(scopeId),
    stopRemoteScope: (scopeId) => managedRemoteTargets.setScopeSleeping(scopeId, true),
    resumeRemoteScope: (scopeId) => managedRemoteTargets.setScopeSleeping(scopeId, false),
    remoteMachineOwners: (hostId) => managedRemoteTargets.ownersForMachine(`managed:${hostId}`),
    wakeFollowUps: (scopeId) => followUpService.resumeScope(scopeId),
  });
  interface SessionNotificationRequest extends DesktopNotificationPayload {
    body: string;
    kind: 'completion' | 'error';
    sessionId: string;
    tag: string;
    title: string;
  }
  const sendPiSessionNotification = async ({
    body,
    kind,
    sessionId,
    tag,
    title,
  }: SessionNotificationRequest): Promise<void> => {
    const settings = await readSettingsFromDisk().catch(() => null);
    if (settings?.notifyOnCompletion === false) return;
    const payload = { body, kind, sessionId, tag, title };
    const desktopDelivered = getIsWindowFocused() && settings?.notificationMode !== 'always'
      ? false
      : emitDesktopNotification(payload);
    broadcastUiNotification(payload, { desktopNotificationDelivered: desktopDelivered });
    const pushPayload = {
      ...payload,
      data: { type: 'session', sessionId, url: `/?session=${encodeURIComponent(sessionId)}` },
    };
    await Promise.allSettled([
      sendPushToAllUiSessions(pushPayload, { requireNoSse: true }),
      isAnyInteractiveClientVisible() ? Promise.resolve() : sendMobilePushToAllDevices(pushPayload),
      sendApnsToAllUiSessions(pushPayload),
    ]);
  };
  const piSessionTitles = createPiSessionTitleRuntime({
    broker: piRuntimeBroker,
    getSmallModelService: () => import('./lib/small-model/index.js'),
  });
  const piSessionAutomation = createPiSessionAutomationRuntime({
    broker: piRuntimeBroker,
    getSmallModelService: () => import('./lib/small-model/index.js'),
    readSettings: readSettingsFromDisk,
    onGoalSettled: async ({ goal, sessionId }) => {
      const complete = goal.status === 'complete';
      const statusLabel = goal.status === 'budgetLimited' ? 'budget reached' : goal.status;
      await sendPiSessionNotification({
        body: goal.note || goal.statusReason || (complete
          ? 'The active goal was completed and independently verified.'
          : `The active goal stopped: ${statusLabel}.`),
        kind: complete ? 'completion' : 'error',
        sessionId,
        tag: `pi-goal-${sessionId}`,
        title: sessionNames.get(sessionId) || (complete ? 'Varin goal complete' : 'Varin goal needs attention'),
      });
    },
  });
  // Recovery can open stores and inference consumers, so start only after
  // their owners and catalog observers have been assembled.
  memoryOrganizer.start();
  const brokerUnsubscribe = piRuntimeBroker.subscribe((event) => {
    semanticRuntime.processEvent(event);
    piSessionAutomation.processBrokerEvent(event);
    piSessionTitles.processBrokerEvent(event);
    sessionRuntime.processBrokerEvent(event);
    sessionSettleTracker.processEvent(event);
    void piWriterTracker.processEvent(event);
    void recoveryTurnCoordinator.processEvent(event);
    void botRootRuntime.processEvent(event, async () => {
      await researchRootRuntime.processEvent(event, async () => {
        await agentRootRuntime.processEvent(event, async () => {
          await harnessRouter.processEvent(event);
          threadRuntime.processEvent(event);
        });
      });
    }).catch((error) => {
      console.error('[ResearchRoot] Event routing failed:', errorMessage(error));
    });
    if (event?.kind === 'worker.exit') {
      // An auxiliary worker (a session's compaction worker) shares the
      // session identity but is not the session worker; its exit must not
      // tear down session registrations.
      if (event.role === 'compaction') return;
      if (event.sessionId) {
        const ownsRegisteredSession = !event.actor || harnessSessionRegistration.hasActor(event.actor);
        harnessSessionRegistration.dropSession(event.sessionId, event.actor);
        void kernelStorageAdapter.revokeSession(event.sessionId);
        kernelSessionActors.delete(event.sessionId);
        // A worker exit still leaves durable source material behind — let the
        // organizer cover whatever the session wrote before it went away.
        memoryOrganizer.noteSessionSettled(event.sessionId);
        if (ownsRegisteredSession) {
          mcpHarness.disposeSession(event.sessionId);
          releaseSessionPrewarm(event.sessionId);
          clientSurfaceBridge.dropSession(event.sessionId);
          sessionSnapshots.delete(event.sessionId);
          sessionNames.delete(event.sessionId);
          knowledgeContextRuntime.dropSession(event.sessionId);
        }
      }
      return;
    }
    if (event?.kind !== 'host' || event.envelope?.kind !== 'event') return;
    const envelope = event.envelope;
    const envelopeData = recordOf(envelope.data);
    const sessionId = event.sessionId ?? '';
    if (envelope.event === 'session.closed' && sessionId) {
      const ownsRegisteredSession = !event.actor || harnessSessionRegistration.hasActor(event.actor);
      harnessSessionRegistration.dropSession(sessionId, event.actor);
      void kernelStorageAdapter.revokeSession(sessionId);
      kernelSessionActors.delete(sessionId);
      memoryOrganizer.noteSessionSettled(sessionId);
      if (ownsRegisteredSession) {
        mcpHarness.disposeSession(sessionId);
        releaseSessionPrewarm(sessionId);
        clientSurfaceBridge.dropSession(sessionId);
        knowledgeContextRuntime.dropSession(sessionId);
      }
      return;
    }
    if (envelope.event === 'session.snapshot' && sessionId) {
      if (event.actor) kernelSessionActors.set(sessionId, event.actor);
      const snapshot = mergeSessionSnapshotForKnowledgeOwner(sessionSnapshots.get(sessionId), envelopeData);
      sessionSnapshots.set(sessionId, snapshot);
      const name = typeof envelopeData.name === 'string' ? envelopeData.name.trim() : '';
      if (name) sessionNames.set(sessionId, name);
      // HR0: harness sessions register on session identity — a bound project
      // workspace is classification, not an admission requirement. An unbound
      // (no-project) chat registers with `workspaceId: null`; its durable
      // owner scope is the session itself.
      const workspace = recordOf(snapshot.workspace);
      const harnessWorkspaceId = workspace?.kind === 'workspace'
        ? typeof workspace.authorityId === 'string' && workspace.authorityId.trim()
          ? workspace.authorityId
          : typeof workspace.id === 'string' && workspace.id.trim()
            ? workspace.id
            : ''
        : '';
      prewarmSession(sessionId, snapshot.cwd);
      if (event.actor && typeof envelopeData.cwd === 'string' && envelopeData.cwd) {
        void owningKnowledgeScopeIdForSession(sessionId, harnessWorkspaceId || null).then((scopeId) => {
          bindKnowledgeSession(
            sessionId,
            scopeId ?? sessionScopeId(sessionId),
          );
        }).catch((error) => {
          console.error('[HarnessKnowledge] Session knowledge bind failed:', errorMessage(error));
        });
        const activeTools = Array.isArray(snapshot.activeTools)
          ? snapshot.activeTools.filter((entry): entry is string => typeof entry === 'string')
          : [];
        void harnessSessionRegistration.register({
          actor: event.actor,
          workspaceId: harnessWorkspaceId || null,
          workspaceRoot: envelopeData.cwd,
          grantedCapabilities: deriveHarnessCapabilities(activeTools, {
            documentRead: true,
            documentPathOverlay: true,
            threadRuntime: Boolean(harnessServiceHost.threadRegistry && harnessServiceHost.threadSpawnSession),
            experiments: Boolean(harnessServiceHost.experimentService),
            settings: Boolean(harnessServiceHost.settingsService),
            followUps: Boolean(harnessServiceHost.followUpService),
            scheduledTasks: Boolean(harnessServiceHost.scheduledTaskService),
            computer: Boolean(harnessServiceHost.computerService),
          }),
        }).catch((error) => {
          console.error('[Harness] Failed to register session shell:', errorMessage(error));
        });
        void (async () => {
          const binding = await threadRegistry.getSessionBinding(sessionId);
          await threadRuntime.resumeLostForParent(
            binding?.owningScopeId ?? harnessWorkspaceId ?? sessionScopeId(sessionId),
            binding
              ? { kind: 'thread', id: binding.threadId }
              : { kind: 'session', id: sessionId },
          );
        })().catch((error) => {
          console.error('[HarnessThreads] Failed to resume child runs:', errorMessage(error));
        });
      }
      return;
    }
    if (envelope.event !== 'agent.event' || !sessionId) return;
    if (threadRuntime.isThreadSession(sessionId)) return;
    const agentEvent = recordOf(envelopeData.event);
    if (agentEvent?.type === 'agent_settled') return;
    if (agentEvent?.type !== 'agent_end' || agentEvent.willRetry === true) return;
    memoryOrganizer.noteSessionSettled(sessionId);
    void (async () => {
      const features = recordOf(sessionSnapshots.get(sessionId)?.features);
      const goal = recordOf(features.goal);
      if (goal.status === 'active') return;
      const body = extractAssistantText(agentEvent.messages) || 'Pi finished the current task.';
      const title = sessionNames.get(sessionId) || 'Varin task complete';
      await sendPiSessionNotification({
        title,
        body,
        tag: `pi-session-${sessionId}`,
        kind: 'completion',
        sessionId,
      });
    })();
  });
  void threadWaitRuntime.reconcile().catch(error => console.error('[ThreadWait] Reconcile failed:', errorMessage(error)));
  const piRuntimeGateway = createPiRuntimeGateway({
    server,
    broker: piRuntimeBroker,
    getBroker: getReadyPiRuntimeBroker,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  });

  tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port);
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  const relayService = createRelayService({
    crypto,
    readSettingsFromDisk,
    updateSettingsOnDisk,
    getLocalPort: () => tunnelRuntimeContext.getActivePort(),
    hostLock: createRelayHostLock({
      lockFilePath: path.join(VARIN_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    hasRelayDemand: async () => {
      // A failed store read is unknown demand, not evidence that no device uses
      // the relay. Keep the current lifecycle state until both stores can be
      // read reliably; either affirmative result still wins immediately.
      const [pending, paired] = await Promise.allSettled([
        clientPairingRuntime.hasActiveRelaySession(),
        remoteClientAuthRuntime.hasActiveRelayClients(),
      ]);
      if (pending.status === 'fulfilled' && pending.value) return true;
      if (paired.status === 'fulfilled' && paired.value) return true;
      if (pending.status === 'rejected') throw pending.reason;
      if (paired.status === 'rejected') throw paired.reason;
      return false;
    },
  });
  relayServiceInstance = relayService;
  relayService.registerRoutes(app);

  await platformRoutesRuntime.registerRoutes(app, {
    crypto,
    os,
    path,
    process,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn: platformEnvironmentRuntime.resolveGitBinaryForSpawn,
    fileSearch: catalogFileSearch,
    contentSearch: workspaceContentSearch,
    varinDataDir: VARIN_DATA_DIR,
    varinUserConfigRoot: VARIN_USER_CONFIG_ROOT,
    varinVersion: VARIN_VERSION,
    runtimeName: process.env.VARIN_RUNTIME || 'web',
    serverStartedAt,
    remoteClientAuthRuntime,
    __dirname,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    readCustomThemesFromDisk,
    formatSettingsResponse,
    readSettingsFromDisk,
    persistSettings,
    sanitizeProjects,
    buildAugmentedPath: platformEnvironmentRuntime.buildAugmentedPath,
    projectConfigRuntime,
    scheduledTasksRuntime,
    scheduledTaskService,
    piRuntimeBroker,
    getPiRuntimeBroker: getReadyPiRuntimeBroker,
    piRuntimeLifecycle,
    ...(typeof options.pickPiPackageRoot === 'function' ? { pickPiPackageRoot: options.pickPiPackageRoot } : {}),
    ...(typeof options.openFilesystemPath === 'function' ? { openFilesystemPath: options.openFilesystemPath } : {}),
    getVarinEventClients: () => uiVarinEventClients,
    writeSseEvent,
    surfaceBridge: clientSurfaceBridge,
    resolveAuthContext: uiAuthController.resolveAuthContext,
    resolveSurfaceSession: async (sessionId) => (
      (await piRuntimeBroker.listSessions()).some((session) => session.id === sessionId)
    ),
    extensionCatalog,
    extensionPackages,
    extensionRuntime,
    uiAuthController,
    documents: documentsAuthority,
    fileResources: kernelFileResources,
    onGitStatus: observeKnowledgeGitStatus,
    languageSupervisor,
    languageSupport: languageSupportRuntime,
    runRuntime,
    reloadRuntimeConfiguration: async () => { await piRuntimeLifecycle.ensureActiveBroker(); },
  });

  const previewProxyRuntime = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor });
  previewProxyRuntime.attach(app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  });
  const staticRoutesRuntime = createStaticRoutesRuntime({
    fs,
    path,
    process,
    __dirname,
    express,
    listRecentSessions: () => getReadyPiRuntimeBroker()?.listSessions?.() ?? [],
    readSettingsFromDisk,
    normalizePwaAppName,
    normalizePwaOrientation,
  });
  const startupResult = await startupPipelineRuntime.run({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath: platformEnvironmentRuntime.buildAugmentedPath,
    searchPathFor: platformEnvironmentRuntime.searchPathFor,
    isExecutable: platformEnvironmentRuntime.isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    loadPtyProvider: async () => kernelProcesses.ptyProvider,
    inspectNativeProcesses: (cwd) => kernelProcesses.list(cwd),
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDisk,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => { signalsAttached = value; },
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    ...(host ? { host } : {}),
    port,
    startupTunnelRequest,
    ...(onTunnelReady ? { onTunnelReady } : {}),
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(VARIN_USER_CONFIG_ROOT, 'speech-models'),
    documents: documentsAuthority,
  });
  terminalRuntime = startupResult.terminalRuntime;
  await botService.reconcile();
  const terminalCommandSubscription = terminalRuntime.subscribeCommands((record) => {
    void terminalCommandProjector.project(record);
  });
  dictationRuntime = startupResult.dictationRuntime;
  await scheduledTasksRuntime.start().catch((error) => {
    console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error);
  });
  void relayService.reconcile();
  const relayReconcileTimer = setInterval(() => void relayService.reconcile(), 60_000);
  relayReconcileTimer.unref?.();

  return {
    expressApp: app,
    connections,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: () => ({
      tunnel: { active: Boolean(tunnelService.getPublicUrl()) },
      scheduledTasks: scheduledTasksRuntime.getStatus(),
    }),
    isReady: () => Boolean(currentPiRuntimeHandshake()),
    stop: async (shutdownOptions: { exitProcess?: boolean | undefined } = {}) => {
      // Stop timer/watcher producers before their runtime and storage
      // dependencies begin shutting down.
      runObservers.stop();
      collaboration.stop();
      scheduledTasksRuntime.stop();
      await botService.dispose();
      followUpService.dispose();
      piSessionAutomation.stop();
      piSessionTitles.stop();
      experimentService.detachObservers();
      brokerUnsubscribe();
      harnessRouter.dispose();
      await harnessSessionRegistration.dispose();
      await unregisterWorkbenchLayoutService();
      if (ownsExtensionRuntime) await extensionRuntime.stop();
      unregisterPiRuntimeCapability();
      unregisterMaterialToolCapability();
      unregisterChildIntegrationCapability();
      unregisterDocumentsCapability();
      unregisterWorkspaceRecoveryCapability();
      unregisterSearchCapability();
      unregisterLanguageCapability();
      unregisterTasksCapability();
      unregisterDebugCapability();
      unregisterTestCapability();
      terminalCommandSubscription.dispose();
      for (const subscription of knowledgeLanguageSubscriptions.values()) subscription.close();
      knowledgeLanguageSubscriptions.clear();
      // Semantic and graph observers still read Documents and use the kernel/Pi
      // services. Stop them while those owners are alive; otherwise each late
      // document event can race a disposed mutation authority during shutdown.
      catalogScan.start = () => undefined;
      unsubscribeProjectIndex();
      prewarmProjectGeneration += 1;
      prewarmSessions.clear();
      await languagePrewarm.dispose();
      projectIndexScope.dispose();
      await indexDirectories.dispose();
      observeKnowledgeDocumentMutation = () => undefined;
      await semanticRuntime.dispose();
      await semanticInference.close();
      await symbolGraphRuntime.dispose();
      // Stop producers and drain their receipts while process grants are valid.
      // One refused exit must not prevent the other domains from shutting down.
      await memoryOrganizer.dispose();
      const processShutdown = await Promise.allSettled([
        threadWaitRuntime?.dispose(), agentRootRuntime.dispose(), researchRootRuntime.dispose(), botRootRuntime.dispose(), threadRuntime.dispose(), terminalRuntime?.shutdown(), languageSupervisor.dispose(), managedLanguageServers.dispose(), runRuntime.dispose(),
        // Release every supervised native driver so no synthesized input is
        // left held down when the Host exits.
        computerService.dispose(),
        connections.shutdownAll(),
      ]);
      const processShutdownErrors = processShutdown.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      await languageToolProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); });
      await documentProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); });
      await kernelProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); });
      for (const error of processShutdownErrors) console.error('[VarinKernel] Native process shutdown incomplete:', errorMessage(error));
      await piRuntimeGateway.stop();
      mcpHarness.dispose();
      mcpCompositions.close();
      await mcpAuthority.close();
      await recoveryTurnCoordinator.dispose();
      await piWriterTracker.dispose();
      await documentsAuthority.dispose();
      await Promise.allSettled([...workspaceRecoveryEngines.values()].map((engine) => engine.dispose()));
      workspaceRecoveryEngines.clear();
      await localSemanticComponent.dispose();
      await kernelCompute.dispose();
      await kernelStorageAdapter.dispose().catch((error) => console.error('[VarinKernel] Failed to revoke storage grants:', errorMessage(error)));
      await kernelClient?.close();
      await knowledgeVectors?.close();
      if (ownsPiRuntimeBroker) await piRuntimeLifecycle.dispose();
      await knowledgeContextRuntime.dispose();
      await Promise.allSettled([...knowledgeStoreLoads.values()]);
      const knowledgeShutdown = await Promise.allSettled([...knowledgeStores].map(async ([workspaceId, store]) => {
        await store.close();
        // A failed native close retains its writer for a retry, not an orphaned
        // handle hidden by clearing the whole map after allSettled.
        if (knowledgeStores.get(workspaceId) === store) knowledgeStores.delete(workspaceId);
      }));
      for (const result of knowledgeShutdown) {
        if (result.status !== 'rejected') continue;
        processShutdownErrors.push(result.reason);
        console.error('[KnowledgeStore] Shutdown incomplete:', errorMessage(result.reason));
      }
      if (userKnowledgeStoreLoad) await userKnowledgeStoreLoad.catch(() => null);
      try {
        await userKnowledgeStore?.close();
        userKnowledgeStore = null;
      } catch (error) {
        processShutdownErrors.push(error);
        console.error('[KnowledgeStore] User-store shutdown incomplete:', errorMessage(error));
      }
      await harnessServiceHost.dispose();
      try {
        await egressRuntime.close();
      } catch (error) {
        processShutdownErrors.push(error);
        console.error('[HarnessEgress] Shutdown incomplete:', errorMessage(error));
      }
      await threadRegistry.dispose();
      realtimeProxyRuntime.stop();
      connectionProxy.stop();
      desktopMedia.stop();
      serviceForward.stop();
      clearInterval(relayReconcileTimer);
      relayService.stop();
      dictationRuntime?.stop?.();
      const stopped = await gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false });
      if (processShutdownErrors.length) throw new AggregateError(processShutdownErrors, 'Native process shutdown requires attention');
      return stopped;
    },
  };
}

runCliEntryIfMain({
  process,
  currentFilename: __filename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => { exitOnShutdown = value; },
  startServer: main,
});

export {
  gracefulShutdown,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
  resolveVarinDataDir,
  clearAppImageArgv0FromProcessEnv,
  pathLooksUserConfigured,
  mergePathValues,
  mintOutsideFileGrant,
};
