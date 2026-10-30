import { createLocalSemanticEmbedder } from './lib/knowledge/semantic/local-embedder.js';
import { isDeepStrictEqual } from 'node:util';
import { permissionService } from './lib/kernel/permission-service.js';
import { createPermissionPersistence } from './lib/kernel/permission-persistence.js';
import { createLocalSemanticComponentManager } from './lib/knowledge/semantic/local-component.js';
import { registerLocalSemanticComponentRoutes } from './lib/knowledge/semantic/local-component-routes.js';
import { createKnowledgeEmbeddingOwner } from './lib/knowledge/vectors/embedding-owner.js';
import { createStorageService } from './lib/storage/service.js';
import { registerStorageRoutes } from './lib/storage/routes.js';
import { createStorageCoordinator } from './lib/storage/coordinator.js';
import { readHostConnections } from './lib/connections/hosts.js';
import { createResourceManagement } from './lib/agent-resources/management.js';
import { registerResourceManagementRoutes } from './lib/agent-resources/management-routes.js';
import { createModelTextService } from './lib/model-text/service.js';
import { createThreadTitleService } from './lib/model-text/thread-titles.js';
import { createNextStepService } from './lib/model-text/next-step.js';
import { createSourceGitInventory } from './lib/kernel/source-git-inventory.js';
import { createThreadNotificationRuntime } from './lib/notifications/thread-runtime.js';
import { createContentMaintenance } from './lib/kernel/content-maintenance.js';
import { createContextCompaction } from './lib/kernel/context-compaction.js';
import { createThreadRecoveryNavigation, createThreadRecoveryFileResolver } from './lib/recovery/thread-navigation.js';
import { createCheckpointLifecycle } from './lib/recovery/checkpoint-lifecycle.js';
import { createFileRecoveryService } from './lib/recovery/file-recovery-service.js';
import { createManagedRecoveryCoordinator, type ManagedRecoveryPort } from './lib/recovery/managed-recovery-coordinator.js';
import { createManagedRecoveryService } from './lib/kernel/managed-recovery-service.js';
import { createManagedScheduleService, createManagedScheduleOwner, createKernelManagedScheduleReceipts, createManagedScheduleReconciler } from './lib/kernel/managed-schedule-service.js';
import { createBotMemoryOwner } from './lib/kernel/bot-memory-owner.js';
import { createBotHistory } from './lib/memory/bot-history.js';
import { createBotRecallContext } from './lib/memory/bot-recall-context.js';
import { normalizePathIdentity } from './lib/workspace/path-safety.js';
import { createThreadMemory } from './lib/memory/thread-memory.js';
import { registerThreadMemoryRoutes } from './lib/memory/thread-memory-routes.js';
import { createMemoryInference } from './lib/memory/memory-inference.js';
import { createExtensionPackageOwner, VARIN_EXTENSION_PACKAGES_CAPABILITY } from "./lib/kernel/extension-package-owner.js";

import { createImageRuntime, IMAGES_CAPABILITY } from './lib/kernel/image-runtime.js';
import { createMediaResourceStore } from './lib/harness/media-resources.js';
import { createResearchDiscoveryRuntime, RESEARCH_DISCOVERY_CAPABILITY } from './lib/kernel/research-discovery.js';
import { ModelsExtensionOwner } from './lib/models/extensions.js';
import { ModelsService } from './lib/models/service.js';
import { registerModelRoutes } from './lib/models/routes.js';
import { registerModelTestRoute } from './lib/models/test-route.js';
import { createWebRuntime, WEB_CAPABILITY } from './lib/kernel/web-runtime.js';
import { createOfficeRuntime, OFFICE_CAPABILITY } from './lib/kernel/office-runtime.js';
import { createBrowserRuntime, BROWSER_CAPABILITY } from './lib/kernel/browser-runtime.js';
import { createOfficeReader } from './lib/office/reader.js';
import { createOfficeRenderer } from './lib/office/renderer.js';
import { createBinaryFileOwner } from './lib/kernel/binary-file-owner.js';
import { createMaterialReceiptReconciler } from './lib/kernel/material-receipts.js';
import { createDocumentSources } from './lib/kernel/document-sources.js';
import { createMaterialStorageAccess } from './lib/kernel/material-storage.js';
import { createThreadMaterialLifetime } from './lib/kernel/thread-material-lifetime.js';
import { createScriptRuntime, SCRIPT_CAPABILITY } from './lib/kernel/script-runtime.js';
import { createNestedToolOwner, VARIN_RUNTIME_TOOLS_CAPABILITY } from './lib/kernel/nested-tool-owner.js';
import { createRuntimeContractOwner } from './lib/kernel/runtime-contract-owner.js';
import { VARIN_RUNTIME_CONTRACTS_CAPABILITY } from '@varin/extension-contract';
import { DocumentsFileObservationOwner } from './lib/kernel/file-observation-owner.js';
import { FileObservationService } from './lib/kernel/file-observation-service.js';
import { createScheduleToolOwner, SCHEDULE_CAPABILITY } from './lib/kernel/schedule-tool-owner.js';
import { CalendarOwner } from './lib/scheduled-tasks/calendar-owner.js';
import { createChildProjectSourcePreparer } from './lib/kernel/child-project-source.js';
import { createChildProfilePreparer } from './lib/kernel/child-profiles.js';
import { createCodeExchangeOwner, CODE_EXCHANGE_CAPABILITY } from './lib/kernel/code-exchange.js';
import { createManagedCodeExchangeService } from './lib/kernel/managed-code-exchange.js';
import { createPlanOwner } from './lib/kernel/plan-owner.js';
import { PlanService } from './lib/kernel/plan-service.js';
import { createPersonalizationContextResolver } from './lib/memory/personalization-context.js';
import { createMemoryOwner } from './lib/kernel/memory-owner.js';
import { ContextService } from './lib/kernel/context-service.js';
import { createContextBudget } from './lib/kernel/context-budget.js';
import { readContextPolicy } from './lib/kernel/context-settings.js';
import { ThreadCollaboration } from './lib/kernel/thread-collaboration.js';
import { createSemanticInferenceLedger } from './lib/knowledge/semantic/inference-ledger.js';
import { createSemanticInference } from './lib/knowledge/semantic/runtime-inference.js';
import { createLanguageOwner } from './lib/kernel/language-owner.js';
import { createSourceQueryOwner } from './lib/kernel/source-query.js';
import { createLiveSourceOwner } from './lib/kernel/live-source.js';
import { createNativeWorkspaceOwner, type NativeWorkspaceOwner } from './lib/kernel/native-workspaces.js';
import { registerNativeWorkspaceRoutes } from './lib/workspace/native-workspace-routes.js';
import { createThreadSourcePreparer, createThreadSourceAdmission, createThreadSourceDirectory } from './lib/kernel/thread-sources.js';
import { createManagedSourceConsumers } from './lib/kernel/managed-source-consumers.js';
import { createSourceQueryService } from './lib/kernel/source-query-service.js';
import { createManagedMcpService } from './lib/harness/managed-mcp-service.js';
import { createManagedMcpProcesses } from './lib/kernel/managed-mcp-processes.js';
import { createManagedMcpLease } from './lib/kernel/managed-mcp-lease.js';
import { createManagedMcpInteractions } from './lib/kernel/managed-mcp-interactions.js';
import { createManagedMcpPreparer, selectMcpServers } from './lib/kernel/managed-mcp-preparation.js';
import { createManagedSourceService } from './lib/harness/managed-source-service.js';
import { createManagedChildSourceService } from './lib/kernel/managed-source-collaboration.js';
import { createManagedIntegrationService, createManagedIntegrationOwner } from './lib/kernel/managed-source-integration.js';
import { createThreadIntegrations, createUserIntegrationService } from './lib/kernel/thread-integrations.js';
import { createThreadCodeExchangeReader, createManagedCodeExchangeReader } from './lib/kernel/thread-code-exchange.js';
import { createThreadContext } from './lib/kernel/thread-context.js';
import { createThreadResourceScope } from './lib/kernel/thread-resource-scope.js';
import { createThreadSkillInputPreparer } from './lib/kernel/thread-skill-input.js';
import { createResourceOwner } from './lib/kernel/resource-owner.js';
import { createInteractiveUiRuntime } from './lib/interactive-ui/runtime.js';
import { registerInteractiveUiRoutes } from './lib/interactive-ui/routes.js';
import { INTERACTIVE_UI_CAPABILITY } from '@varin/extension-builtins';
import { readAgentResourceConfiguration } from './lib/agent-resources/packages.js';
import { ProjectTrustService, registerProjectTrustRoutes } from './lib/models/project-trust.js';
import { createMcpSourceProcessAdmission } from './lib/kernel/mcp-process-admission.js';
import { createContextComposition } from './lib/kernel/context-composition.js';
import { createPolicyModelPreparer } from './lib/kernel/policy-models.js';
import { createAgentPolicy } from './lib/kernel/agent-policy.js';
import { RunObservers } from './lib/kernel/run-observers.js';

import { McpAuthority, McpCompositions, composeMcpAuthorityLeases, StdioTransport, type McpCompositionScope } from './lib/mcp/authority.js';
import { createMcpProcessTransport } from './lib/kernel/mcp-process-transport.js';
import { createMcpSettings } from './lib/mcp/settings.js';
import { createMcpInteractionRuntime } from './lib/kernel/mcp-interaction-runtime.js';
import { createMcpResourceRuntime } from './lib/kernel/mcp-resource-runtime.js';
import { createMcpResourceRecovery } from './lib/kernel/mcp-resource-recovery.js';
import { createMcpTaskRuntime } from './lib/kernel/mcp-task-runtime.js';
import { createMcpTaskRecovery } from './lib/kernel/mcp-task-recovery.js';
import { createMcpLease } from './lib/kernel/mcp-owner.js';
import { createChildMcpPreparer } from './lib/kernel/mcp-child-preparation.js';
import { createManagedChildMcpPreparer } from './lib/kernel/managed-child-mcp-preparation.js';
import { createExtensionTools, configuredToolAvailability } from './lib/kernel/extension-tool-owner.js';
import { MATERIAL_SNAPSHOT_CAPABILITY } from './lib/kernel/material-tool-owner.js';
import { createIntegrationToolOwner, createIntegrationTargetOpener, createFileEffectReceiptReconciler, CHILD_INTEGRATION_CAPABILITY } from './lib/kernel/integration-tool-owner.js';

import { AgentRuntimeClient } from './lib/kernel/agent-runtime-client.js';
import { createThreadProcesses } from './lib/kernel/thread-processes.js';
import { createResearchRuntime, createResearchSourceAuthority, RESEARCH_CAPABILITY } from './lib/kernel/research-runtime.js';
import { ThreadAdapter } from './lib/kernel/thread-adapter.js';
import { registerThreadRoutes } from './lib/kernel/thread-routes.js';
import { ExternalAgentsService } from './lib/external-agents/service.js';
import { createExternalSourceOwner } from './lib/external-agents/source.js';
import { registerExternalAgentRoutes } from './lib/external-agents/routes.js';
import { createSettingsToolOwner, SETTINGS_CAPABILITY } from './lib/kernel/settings-tool-owner.js';
import { createEnvironmentForwardRuntime } from './lib/harness/environment-forwards.js';
import { createAgentProfilesAPI } from './lib/kernel/agent-profiles.js';
import { createContextAgent } from './lib/kernel/context-agent.js';
import { registerAgentProfileRoutes } from './lib/kernel/agent-profile-routes.js';
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
import { ApplicationExtensionCatalog, ApplicationExtensionRuntime, ExtensionPackageManager } from '@varin/extension-host';
import { VARIN_BUNDLED_LANGUAGE_SERVERS } from '@varin/extension-builtins';
import { createDocumentAuthority, type DocumentAuthority, type DocumentMutationObservation } from './lib/documents/authority.js';

import { createKernelProcessService } from './lib/kernel/process-service.js';
import { createKernelProcessIdentityResolver } from './lib/kernel/process-identity.js';
import { registerBuiltinWorkbenchLayoutService } from './lib/extensions/workbench-layout-service.js';

import { createDocumentsCapabilityHandler } from './lib/documents/capability.js';
import { createWorkspaceRecoveryEngine, type RecoverySessionNavigation, type WorkspaceRecoveryEngine } from './lib/recovery/engine.js';
import { createWorkspaceRecoveryCapabilityHandler } from './lib/recovery/capability.js';

import { createLanguageSupervisor } from './lib/lsp/supervisor.js';
import { createManagedLanguageServers } from './lib/lsp/managed-servers.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './lib/workspace/path-safety.js';
import { createLanguageCapabilityHandler, createWorkspaceSearchCapabilityHandler } from './lib/lsp/capability.js';
import { createRunRuntime } from './lib/run/runtime.js';
import { createWorkspaceDebugCapabilityHandler, createWorkspaceTasksCapabilityHandler, createWorkspaceTestCapabilityHandler } from './lib/run/capability.js';
import { createWorkspaceContentSearch } from './lib/search/content.js';
import { createDocumentRootGuard } from './lib/documents/allowed-roots.js';
import { createWorkspaceConfig } from './lib/workspace/workspace-config.js';

import { openWorkspaceKnowledge, type KnowledgeStore } from './lib/knowledge/store.js';

import { createKnowledgeContextRuntime } from './lib/knowledge/context-runtime.js';
import { createContextObservationPublication } from './lib/knowledge/context-publication.js';
import { createGitStatusObserver } from './lib/knowledge/git-status-runtime.js';
import { projectContainsPath } from '@varin/application-client';
import { createEmbeddingRequestSettings, DEFAULT_EMBEDDING_REQUEST_CONFIGURATION, registerEmbeddingRequestRoutes } from './lib/knowledge/vectors/request-settings.js';
import { createEmbedScheduler } from './lib/knowledge/semantic/embed-scheduler.js';
import { createVectorCache } from './lib/knowledge/semantic/vector-cache.js';
import { createKnowledgeVectorRuntime } from './lib/knowledge/vectors/index.js';
import type { KnowledgeVectorRuntime, MemoryRecallSource } from './lib/knowledge/vectors/index.js';
import { recallMemories } from './lib/memory/memory-recall.js';

import { openUserKnowledgeStore } from './lib/harness/recall-tool.js';

import { threadScopeId, isThreadScopeId, threadIdFromScopeId, isBotScopeId, botIdFromScopeId, botScopeId, knowledgeStoreKeyForScope, scopeOfScopeId } from './lib/harness/owner-scope.js';
import { createMemoryService } from './lib/memory/memory-service.js';
import { createMemoryOrganizer } from './lib/memory/memory-organizer.js';

import { createAgentPersonalization } from './lib/memory/agent-personalization.js';
import { registerAgentPersonalizationRoutes } from './lib/memory/agent-personalization-routes.js';
import { createPromptToolCatalog } from './lib/memory/prompt-tool-catalog.js';

import { createBotService } from './lib/bots/bot-service.js';
import { createBotLifecycleRuntime } from './lib/bots/bot-lifecycle-runtime.js';
import { registerBotRoutes } from './lib/bots/bot-routes.js';
import { createComputerService } from './lib/computer/computer-service.js';
import { ComputerError } from './lib/computer/computer-error.js';
import { createComputerRuntime, COMPUTER_CAPABILITY } from './lib/kernel/computer-runtime.js';
import { createEnvironmentForwardJobRuntime, ENVIRONMENT_FORWARD_CAPABILITY } from './lib/kernel/environment-forward-runtime.js';

import { HostSshManager } from './lib/connections/ssh-manager.js';
import { registerConnectionRoutes } from './lib/connections/connection-routes.js';
import { attachConnectionProxy } from './lib/connections/host-proxy.js';
import { configuredVmProviders } from './lib/computer/vm-provider.js';
import { registerComputerRoutes } from './lib/computer/computer-routes.js';
import { attachDesktopMedia } from './lib/computer/desktop-media.js';
import { attachServiceForward } from './lib/harness/environment-forward-server.js';
import { createVmGuestRegistration } from './lib/computer/vm-guest-register.js';

import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter } from './lib/kernel/storage-adapter.js';
import { KernelFileResourceBackend } from './lib/kernel/file-resource-backend.js';

import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from './lib/kernel/kernel-recovery-store.js';
import { createWebMaterialStore, type WebMaterialStore } from './lib/harness/web-materials.js';
import { createMaterialCollections as createMaterialCollectionsService } from './lib/harness/material-collections.js';

import { IntegrationCoordinator } from './lib/harness/working-state/integration-coordinator.js';
import { createThreadFileTargetResolver } from './lib/kernel/thread-file-target.js';

import { THINKING_LEVELS, resolveMessageTimeSettings } from '@varin/protocol';
import { createSettingsService, settingsDocumentRevision } from './lib/harness/settings-service.js';

import { createClientSurfaceBridge } from './lib/harness/client-surfaces.js';
import { createSettingsActionRegistry } from './lib/harness/settings-actions.js';
import { createKernelSettingsActionOperationStore } from './lib/harness/settings-operation-store.js';
import * as gitIdentityStorage from './lib/git/identity-storage.js';
import { getGitHubAuth, getGitHubAuthAccounts, isGhCliActive, isGhCliDisabled } from './lib/github/auth.js';
import { getGhCliToken } from './lib/github/gh-cli-credential.js';
import { resolvePrimaryWorktreeRoot } from './lib/git/service.js';

import { createKernelClient, KernelClientError, type KernelClient } from './lib/kernel/kernel-client.js';

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

import { createResearchSearchService } from './lib/harness/research-search.js';
import { registerWebSearchCredentialRoutes } from './lib/harness/web-search-routes.js';

import { checkDesktopHttpUrl, checkSsrf, isSameHost } from './lib/harness/ssrf-policy.js';
import { createEgressRuntime } from './lib/harness/egress.js';
import { readEgressHostConfiguration } from './lib/harness/egress-settings.js';
import { registerEgressRoutes } from './lib/harness/egress-routes.js';
import { createServiceCredentialStore } from './lib/service-credentials/store.js';

import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import { TUNNEL_MODE_MANAGED_LOCAL, TUNNEL_MODE_MANAGED_REMOTE, TUNNEL_MODE_QUICK, TUNNEL_PROVIDER_CLOUDFLARE, TunnelServiceError, isSupportedTunnelMode, normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider, normalizeTunnelStartRequest, type TunnelController } from './lib/tunnels/types.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import { getInvalidBindHostErrorMessage, getUnauthenticatedLanErrorMessage, isNetworkExposedBindHost, isUnsafeUnauthenticatedLanAllowed, normalizeBindHost } from './lib/security/bind-host.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createTerminalCommandObserveAdapter, createTerminalCommandProjector } from './lib/knowledge/terminal-projection.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { mintOutsideFileGrant } from './lib/fs/routes.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createGlobalUiEventBroadcaster, createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createMobileDeviceStore } from './lib/mobile/device-store.js';
import { createMobilePairingRuntime } from './lib/mobile/pairing-runtime.js';
import { createMobilePushRuntime } from './lib/mobile/push-runtime.js';
import { registerMobileRoutes } from './lib/mobile/routes.js';
import { createGracefulShutdownRuntime, createShutdownCollector } from './lib/shutdown-runtime.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { createPreviewProxyRuntime } from './lib/preview/proxy-runtime.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { attachObservations } from './lib/observations.js';
import { createRelayService } from './lib/relay/service.js';
import { resolveRelayEndpoint } from './lib/relay/endpoint.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';

import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createScheduledTaskService, readScheduledProjects } from './lib/scheduled-tasks/service.js';

import { createServerBootstrapRuntime } from './lib/platform/bootstrap-runtime.js';
import { parseServeCliOptions } from './lib/platform/cli-options.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './lib/platform/core-routes.js';
import { createPlatformEnvironmentRuntime } from './lib/platform/environment-runtime.js';
import { createExecutionEnvironmentRuntime } from './lib/platform/execution-environment.js';
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

import { createStaticRoutesRuntime } from './lib/platform/static-routes-runtime.js';
import { createStartupPipelineRuntime } from './lib/platform/startup-pipeline-runtime.js';
import { createThemeRuntime } from './lib/platform/theme-runtime.js';
import { createTunnelAuth } from './lib/platform/tunnel-auth.js';
import { createTunnelWiringRuntime } from './lib/platform/tunnel-wiring-runtime.js';
import type { StartWebUiServerOptions, WebUiServerController } from './public-contract.js';
export type * from './public-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CLIENT_RELOAD_DELAY_MS = 800;
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
  '/api/threads/observe',
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
let isNativeThreadLive: (identity: { threadId: string; branchId: string }) => Promise<boolean> = async () => false;
const clientSurfaceBridge = createClientSurfaceBridge({
  writeSseEvent,
  isThreadLive: identity => isNativeThreadLive(identity),
});
broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  writeSseEvent,
});

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: VARIN_PROJECTS_CONFIG_DIR,
});
let botCalendarScopes: () => Promise<Array<{ id: string; path: string }>> = async () => [];
const scheduledScopes = async () => [...await readScheduledProjects(readSettingsFromDisk, sanitizeProjects), ...await botCalendarScopes()];
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  listProjects: scheduledScopes,
  logger: console,
});
const scheduledTaskService = createScheduledTaskService({
  additionalProjects: () => botCalendarScopes(),
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
let stopHostResources: WebUiServerController['stop'] | undefined;
const gracefulShutdown: typeof gracefulShutdownRuntime.gracefulShutdown = (options = {}) =>
  stopHostResources
    ? stopHostResources({ exitProcess: options.exitProcess ?? exitOnShutdown })
    : gracefulShutdownRuntime.gracefulShutdown(options);
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
  type RelayService = ReturnType<typeof createRelayService>;
  type TunnelRuntimeContext = ReturnType<ReturnType<typeof createTunnelWiringRuntime>['initialize']>;
  let relayServiceInstance: RelayService | null = null;
  let tunnelRuntimeContext: TunnelRuntimeContext | null = null;
  let kernelClient: KernelClient | null = null;
  let realtimeProxyRuntime: Pick<ReturnType<typeof attachRealtimeProxy>, 'stop'> = { stop: () => {} };
  let dictationRuntime: ReturnType<typeof createDictationRuntime> | null = null;

  const activePort = () => tunnelRuntimeContext?.getActivePort() || port;
  // Anywhere pairing needs an operator-configured relay (VARIN_RELAY_URL); there is no built-in one.
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
    return { local, lan, relayAvailable: resolveRelayEndpoint().state === 'configured' };
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
      return {
        apiOnly,
        ...(process.env.VARIN_RELEASE_ID?.trim()
          ? { releaseId: process.env.VARIN_RELEASE_ID.trim() }
          : {}),
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
    setPushInitialized,
    fs,
    path,
    server,
    __dirname,
    varinDataDir: VARIN_DATA_DIR,
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
  const observations = attachObservations({
    server,
    authenticate: async (request) => Boolean(await uiAuthController?.resolveWebSocketAuthContext(request)),
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
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
  const scopeDirectory = async (scopeId: string): Promise<string> => { if (isBotScopeId(scopeId)) return botScopeRoot(scopeId); return (await documentsAuthority.inspectWorkspace(scopeId)).root; };
  const scopeDocumentWorkspace = async (scopeId: string): Promise<string> => isBotScopeId(scopeId) ? (await documentsAuthority.resolveWorkspace({ path: await scopeDirectory(scopeId) })).workspaceId : scopeId;
  const recoveryCoordinatorWorkspace = `recovery-coordinator:${extensionRuntime.services.hostId}`;
  const kernelStorageAdapter = new KernelStorageAdapter({
    client: kernelClient,
    hostId: extensionRuntime.services.hostId,
    storageRoot: path.join(VARIN_DATA_DIR, 'kernel', extensionRuntime.services.hostId),
    recoveryCoordinatorWorkspace,
    resolveWorkspaceRoot: async (workspaceId) => isBotScopeId(workspaceId) ? scopeDirectory(workspaceId)
      : (await documentsAuthority.admitWorkspaceRegistration(workspaceId)).canonicalPath,
  });
  const resolveKernelExecutionRoot = async (canonicalRoot: string, _owningWorkspaceId: string) => { const resolved = await documentsAuthority.resolveWorkspace({ path: canonicalRoot }); const workspace = await documentsAuthority.getWorkspace(resolved.workspaceId); return { workspaceId: resolved.workspaceId, canonicalRoot: workspace.root }; };
  kernelStorageAdapter.bindFileRootResolver(resolveKernelExecutionRoot);
  const kernelFileResources = new KernelFileResourceBackend(kernelStorageAdapter, {
    resolveExecutionRoot: resolveKernelExecutionRoot,
  });
  const kernelRecoveryFileResources = new KernelFileResourceBackend(kernelStorageAdapter, {
    resolveExecutionRoot: resolveKernelExecutionRoot,
    authorityPurpose: 'recovery-maintenance',
    authorityCapabilities: ['recovery.maintenance'],
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
  // eslint-disable-next-line prefer-const -- Deferred port: early document callbacks must observe undefined until wiring completes.
  let nativeWorkspaces:NativeWorkspaceOwner|undefined;
  let requestSourceMaintenance=()=>{};
  let releaseSourcePreparations=async(_threads:readonly string[])=>{};
  const documentsAuthority = createDocumentAuthority({
    hostId: extensionRuntime.services.hostId,
    dataDir: VARIN_DATA_DIR,
    maxReadBytes: workspaceConfig.maxReadBytes,
    isAllowedRoot: workspaceRootGuard,
    isTrusted: workspaceRootGuard,
    nativeWorkspaces:{resolveId:(id,signal,reference)=>nativeWorkspaces?.resolveId(id,signal,reference)??Promise.resolve(undefined),
      resolvePath:(value,containing)=>nativeWorkspaces?.resolvePath(value,containing)??Promise.resolve(undefined),
      retainReference:(source,key)=>nativeWorkspaces!.retainReference(source,key),releaseReference:key=>nativeWorkspaces!.releaseReference(key)},
    onSourceRetentionChanged:()=>requestSourceMaintenance(),
    onMutation: (event) => observeKnowledgeDocumentMutation(event),
    onIntegrationParentChanged: (workspaceId, resourceIds) => observeThreadIntegrationParentChange(workspaceId, resourceIds),
    ...(dirtyBarrierTimeoutMs !== undefined ? { dirtyBarrierTimeoutMs } : {}),
  });
  activeDocumentsAuthority = documentsAuthority;
  nativeWorkspaces=createNativeWorkspaceOwner({kernel:kernelClient,documents:documentsAuthority,
    projects:async()=>sanitizeProjects((await readSettingsFromDisk()).projects)??[],
    update:async(id,value)=>{await updateSettingsOnDisk(current=>{
      const projects=sanitizeProjects(current.projects)??[];
      if(!projects.some(project=>project.id===id))throw new Error('The original project was removed');
      return {...current,projects:projects.map(project=>project.id===id?{...project,versionedWorkspace:value}:project)};
    });},
  });
  kernelClient.nativeWorkspaces=nativeWorkspaces;
  registerNativeWorkspaceRoutes(app,nativeWorkspaces,uiAuthController.requireAuth);
  const workspaceRecoveryEngines = new Map<string, WorkspaceRecoveryEngine>();
  // eslint-disable-next-line prefer-const -- Deferred port: early recovery callbacks must observe undefined until wiring completes.
  let recoveryFileTargetResolver:((target:import('@varin/extension-contract').RecoveryFileTarget)=>Promise<import('@varin/extension-contract').RecoveryFileTarget>)|undefined;
  let threadRecoveryReady = false;
  const managedRecoveryOwner: { current?: ManagedRecoveryPort } = {};
  const recoverySessionNavigation: RecoverySessionNavigation = { ready: () => threadRecoveryReady, commit: input => threadRecoveryNavigation.commit(input), commitLeaf: input => threadRecoveryNavigation.commitLeaf(input), prepare: input => threadRecoveryNavigation.prepare(input), prepareLeaf: input => threadRecoveryNavigation.prepareLeaf(input) };
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
        resolveFileTarget:target=>{if(!recoveryFileTargetResolver)throw new Error('Recovery file source is not ready');return recoveryFileTargetResolver(target);},
        resolveDirectoryApplyContext,
        fileStore: kernelRecoveryContentStore,
        coordinatorWorkspaceId: recoveryCoordinatorWorkspace,
        resolveCoordinatorIdentity: async workspaceId => workspaceId === recoveryCoordinatorWorkspace
          ? { authorityId: extensionRuntime.services.hostId, workspaceId, canonicalRoot: '', filesystemProfile: 'metadata' } : null,
        listCoordinatorWorkspaces: async () => [{ workspaceId: recoveryCoordinatorWorkspace }],
        get managedRecovery() { return managedRecoveryOwner.current; },
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
      { mode: 'shared', purpose: 'document-workspace-edit', create: true },
      (context) => operation(context),
    )
  ));
  try {
    await foundationalRecoveryEngine.fenceUnfinishedOperations();
    await foundationalRecoveryEngine.resumeWorkspaceOperations();
  } catch (error) {
    console.error('[WorkspaceRecovery] Startup workspace recovery requires attention:', errorMessage(error));
  }
  extensionRuntime.workbench.setWorkspaceScopeResolver((scopeId: unknown) => documentsAuthority.resolveScopeId(scopeId));
  const kernelProcesses = createKernelProcessService({ client: kernelClient, resolveIdentity: createKernelProcessIdentityResolver({ documents: documentsAuthority }), onError: error => console.error('[VarinProcess]', error.message) });
  const externalAgentDirectory = path.join(VARIN_DATA_DIR, 'external-agents');
  const externalAgentIdentity = createKernelProcessIdentityResolver({ documents: documentsAuthority });
  const externalAgentProcesses = createKernelProcessService({ client: kernelClient, resolveIdentity: async cwd => {
    const canonicalRoot = await canonicalizePathIdentity(externalAgentDirectory);
    const canonicalCwd = await canonicalizePathIdentity(cwd);
    if (isPathWithinRoot(canonicalCwd, canonicalRoot)) {
      const workspaceId = `external-agents:${extensionRuntime.services.hostId}`;
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
    }
    return externalAgentIdentity(cwd);
  } });
  const externalAgents = new ExternalAgentsService({ kernel: kernelClient, spawn: externalAgentProcesses.spawn, spawnAdmitted: externalAgentProcesses.spawnAdmitted, directory: externalAgentDirectory,
    onError: operationId => console.error('[ExternalAgents] Execution or resource cleanup needs reconciliation:', operationId),
    resolveWorkspace: async cwd => {
      const canonicalRoot = await canonicalizePathIdentity(externalAgentDirectory);
      const canonicalCwd = await canonicalizePathIdentity(cwd);
      if (isPathWithinRoot(canonicalCwd, canonicalRoot)) return { workspaceId: `external-agents:${extensionRuntime.services.hostId}`, root: canonicalCwd };
      const identity = await externalAgentIdentity(cwd);
      return { workspaceId: identity.workspaceId, root: identity.canonicalRoot };
    },
  });
  registerExternalAgentRoutes(app, externalAgents, uiAuthController.requireAuth);
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
    spawnAdmitted: kernelProcesses.spawnAdmitted,
    releaseAdmittedContext: kernelProcesses.releaseContext,
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
  const kernelCompute = createKernelComputeService({ client: kernelClient, resolveIdentity: createKernelProcessIdentityResolver({ documents: documentsAuthority }) });
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
    storageAvailable: true,
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
    onSourceReachable: (owner) => {
      managedMcpOwner.current?.sourceReached(owner);
      managedMcpInteractionsOwner.current?.wake();
      mcpTaskRuntimeOwner.current?.sourceReached();
      mcpResourceRuntimeOwner.current?.sourceReached();
      collaborationOwner.current?.sourceReached();
      void scriptRuntimeOwner.current?.recoverSource(owner).catch(() => console.error("[Script] Original target stop remains pending"));
      void agentRuntime.reconcileSourceCleanup().catch((error: unknown) => {
        console.error("[VarinManagedTarget] Original source cleanup remains pending:", errorMessage(error));
      });
    },
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
    sourceAuthority: createResearchSourceAuthority({ kernel: kernelClient, runtime: () => agentRuntime,
      resolveLiveSource: (source, signal) => liveSources.validate(source, signal) }),
    onError: (error) => console.error("[VarinExperiment]", error.message),
    onAttemptChanged: (workspaceId) => broadcastResearchFacts(workspaceId, 'attempt'),
    resolveBackend: (ctx, machineId, machine, caller) => managedRemoteTargets!.resolveBackend(ctx, machineId, machine, caller),
  });
  // Agent tools and user settings surfaces share the same native owners and CAS.
  const settingsActionRegistry = createSettingsActionRegistry({
    embeddingRequests: () => embeddingRequestSettings,
    models: () => modelsService,
    modelFetch: (input, init) => egressRuntime.fetch(input, init),
    mcpSettings: () => mcpSettings,
    agentProfiles: () => agentProfiles,
    extensionPackages: () => extensionPackages,
    resolveWorkspaceRoot: async (workspaceId) => (
      await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null)
    )?.root ?? null,
    extensionRuntime: () => extensionRuntime,
    tunnel: () => tunnelRuntimeContext?.tunnelService ?? null,
    remoteClients: () => remoteClientAuthRuntime,
    languageSupport: () => languageSupportRuntime,
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
  const settingsActionOperations = createKernelSettingsActionOperationStore({ kernel: kernelClient, storage: kernelStorageAdapter });
  const settingsService = createSettingsService({
    readAppSettings: () => readSettingsFromDisk(),
    persistAppSettings: (changes, removals, expectedRevision) => settingsRuntime.persistSettingsCas(
      changes,
      removals,
      expectedRevision,
      settingsDocumentRevision,
    ),
    agentSettings: () => modelsService.settings,
    resolveWorkspaceRoot: async (workspaceId) => (
      await documentsAuthority.inspectWorkspace(workspaceId).catch(() => null)
    )?.root ?? null,
    actions: settingsActionRegistry,
    actionOperations: settingsActionOperations,
    clientSurfaces: clientSurfaceBridge,
    resolveOptions: async (source) => {
      if (source === 'thinking-levels') {
        return THINKING_LEVELS.map((level) => ({ value: level }));
      }
      if (source === 'models') return (await modelsService.listModels()).map(model => ({ value: model.modelId, label: `${model.name} (${model.providerId})` }));
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
  const serviceCredentials = createServiceCredentialStore(VARIN_DATA_DIR);
  const ssrfPolicy: SsrfPolicy = { check: options.desktopNetworkFetch ? checkDesktopHttpUrl : checkSsrf, isSameHost };
  // Single outbound egress authority: proxy/NO_PROXY policy + connect-path
  // SSRF classification shared by web.fetch and web.search providers.
  const egressRuntime = createEgressRuntime({
    allowLocalTargets: Boolean(options.desktopNetworkFetch),
    ...(options.desktopNetworkFetch ? { systemFetch: options.desktopNetworkFetch } : {}),
    getHostConfiguration: async () => {
      const document = await readSettingsFromDisk();
      const network = document.outboundNetwork as { mode?: unknown } | undefined;
      return readEgressHostConfiguration(document, network?.mode === 'proxy' ? serviceCredentials.read() : {});
    },
  });
  registerEgressRoutes(app, {
    requireAuth: uiAuthController.requireAuth,
    readSettings: readSettingsFromDisk,
    readAuth: serviceCredentials.read,
    saveAuth: serviceCredentials.save,
    removeAuth: serviceCredentials.remove,
    egress: egressRuntime,
  });
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
  const officeRenderer = createOfficeRenderer({ spawn: documentProcesses.spawn, temporaryRoot: documentReadingDirectory,
    command: () => process.env.VARIN_LIBREOFFICE_COMMAND });
  const officeReader = createOfficeReader({ materials: materialStore, pdf: documentReader, renderer: officeRenderer });
  const webFetchService = createWebFetch({
    ssrf: ssrfPolicy,
    egress: egressRuntime,
    documentReader,
    ...(options.renderWebPage ? { renderer: options.renderWebPage } : {}),
    materials: materialStore,
  });
  // Scholarly APIs share the same egress authority — proxies and SSRF
  // classification apply identically to every outbound consumer.
  const researchSearchService = createResearchSearchService({ fetch: egressRuntime.fetch });
  // ── Phase 2: Knowledge store, memory agent, observers ────────────
  // Knowledge stores are opened lazily per workspace and cached.
  const knowledgeStores = new Map<string, KnowledgeStore>();
  const knowledgeStoreLoads = new Map<string, Promise<KnowledgeStore>>();
  let userKnowledgeStore: KnowledgeStore | null = null;
  let userKnowledgeStoreLoad: Promise<KnowledgeStore> | null = null;
  let knowledgeVectors: KnowledgeVectorRuntime | null = null;
  const hostId = extensionRuntime.services.hostId;
  const computerServiceRef: { current?: ReturnType<typeof createComputerService> } = {};
  const memoryOrganizerRef: { current?: ReturnType<typeof createMemoryOrganizer> } = {};
  let botAdmissionReady = false;
  let botLifecycleRuntime: ReturnType<typeof createBotLifecycleRuntime> | null = null;
  const canExecuteBotScope = async (scopeId: string): Promise<boolean> => !isBotScopeId(scopeId)
    || (botAdmissionReady && await botService.canExecute(botIdFromScopeId(scopeId)));
  // BC0: durable Bot identity. The profile record lives in the kernel catalog;
  // the Bot's work is ordinary Threads under the `bot:<id>` owner scope, and
  // its entry conversation is a native Thread and branch.
  const botService = createBotService({
    client: kernelClient,
    hostId,
    dataDir: VARIN_DATA_DIR,
    agent: {
      ensureEntry: async bot => {
        if (bot.entry.runtime !== 'agent') throw new Error('Agent Bot identity is required');
        await agentRuntime.createBotThread(bot.id, bot.entry.threadId, bot.entry.branchId);
        return bot.entry;
      },
      model: bot => botAgentModel(bot),
      listWork: async (bot, includeEntry) => {
        const scope = await agentRuntime.botScope(bot.id);
        const matters = (await agentRuntime.botMatters(bot.id)).filter(matter => !matter.archived);
        const associated = new Map(matters.flatMap(matter => matter.threads.map(link => [link.threadId, link] as const)));
        const owned = new Map(scope.threads.map(thread => [thread.thread_id, thread] as const));
        const sessions = new Set(scope.sessions);
        // Delegated work belongs to the session whose execution ancestry dispatched it.
        const sessionOf = (threadId: string): string | null => {
          const seen = new Set<string>();
          for (let current: string | null = threadId; current && !seen.has(current); current = owned.get(current)?.parent_thread_id ?? null) {
            if (sessions.has(current)) return current;
            seen.add(current);
          }
          return null;
        };
        const followed = await Promise.all([...associated.keys()].filter(thread => !owned.has(thread)).map(thread => agentRuntime.thread(thread).catch(error => {
          if (error instanceof KernelClientError && error.code === 'not-found') return null;
          throw error;
        })));
        return [...scope.threads, ...followed.filter((thread): thread is NonNullable<typeof thread> => thread !== null && thread.deleted_at_ms === null)].flatMap(thread => thread.branches.flatMap(branch => {
          const entry = bot.entry.runtime === 'agent' && bot.entry.threadId === thread.thread_id && bot.entry.branchId === branch.branch_id;
          if (entry && !includeEntry) return [];
          const matterIds = matters.filter(matter => matter.threads.some(link => link.threadId === thread.thread_id && link.branchId === branch.branch_id)).map(matter => matter.id);
          if (!owned.has(thread.thread_id) && !matterIds.length) return [];
          const purpose = entry ? 'bot-root' as const : sessions.has(thread.thread_id) ? 'session' as const : owned.has(thread.thread_id) ? 'work' as const : 'followed' as const;
          return [{ runtime: 'agent' as const, identity: { runtime: 'agent' as const, threadId: thread.thread_id, branchId: branch.branch_id }, thread,
            activeRun: branch.latest_run, matterIds, purpose, sessionThreadId: owned.has(thread.thread_id) ? sessionOf(thread.thread_id) : null }];
        }));
      },
      listSessions: async bot => {
        const scope = await agentRuntime.botScope(bot.id, undefined, true);
        const threads = new Map(scope.threads.map(thread => [thread.thread_id, thread] as const));
        return scope.sessions.flatMap(threadId => {
          const thread = threads.get(threadId);
          return thread && thread.deleted_at_ms === null ? [{ identity: { runtime: 'agent' as const, threadId, branchId: thread.main_branch_id }, thread, primary: threadId === bot.entry.threadId }] : [];
        });
      },
      createSession: async (bot, identity) => {
        await agentRuntime.createBotThread(bot.id, identity.threadId, identity.branchId);
        const thread = await agentRuntime.thread(identity.threadId);
        return { identity: { runtime: 'agent' as const, threadId: thread.thread_id, branchId: thread.main_branch_id }, thread, primary: false };
      },
      applyProfile: async bot => {
        if (bot.entry.runtime !== 'agent') return;
        const scope = await agentRuntime.botScope(bot.id);
        await threads.refreshPersonalization(scope.threads.flatMap(thread => thread.branches.map(branch => ({ runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id }))));
        const model = await botAgentModel(bot);
        if (!model) return;
        // Every Bot conversation follows the profile model; delegated work keeps its own selection.
        const sessions = new Set(scope.sessions);
        const profileRevision = (await botService.executionGate(bot.id)).profileRevision;
        for (const thread of scope.threads.filter(thread => sessions.has(thread.thread_id))) {
          for (const branch of thread.branches) {
            const run = branch.latest_run;
            if (!run || run.cancel_requested) continue;
            const selected = await agentRuntime.modelSelections(run.id);
            const configuration = (selected.desired?.configuration ?? run.configuration) as { providerId?: string; model?: string };
            if (configuration.providerId !== model.providerId || configuration.model !== model.modelId) await threads.selectModel({ runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id, runId: run.id,
              key: `bot-profile:${bot.id}:${profileRevision}:${branch.branch_id}`, model });
          }
        }
      },
    },
    publishExecutionGate: (gate) => kernelClient.agentRuntimeRequest<void, 'runtime.bot.gate.publish'>('runtime.bot.gate.publish', gate),
    lifecycle: () => {
      if (!botLifecycleRuntime) throw new Error('Bot lifecycle is not ready');
      return botLifecycleRuntime;
    },
    onChange: (bot) => broadcastGlobalUiEvent?.({ type: 'varin:bot-changed', properties: { botId: bot.id } }),
    onDeleted: (botId) => broadcastGlobalUiEvent?.({ type: 'varin:bot-changed', properties: { botId } }),
    removeData: createBotDataCleanup({
      dataDir: VARIN_DATA_DIR, hostId,
      deleteAgentScope: async bot => {
        const gate = await botService.executionGate(bot.id);
        if (!gate.activityOperationId) throw new Error('Bot deletion requires the original Sleep intent');
        const scope = await agentRuntime.botScope(bot.id);
        for (const thread of scope.threads) await agentRuntime.cancelTree({ kind: 'thread', thread_id: thread.thread_id });
        await collaboration.releaseCancelledThreads(new Set(scope.threads.map(thread => thread.thread_id)));
        for (const run of scope.runs) await agentRuntime.retireSourceGrants(run.runId);
        await kernelClient.agentRuntimeRequest('runtime.bot.scope.remove', { botId: bot.id, profileRevision: gate.profileRevision, activityOperationId: gate.activityOperationId });
      },
      releaseRemoteScope: (scopeId) => managedRemoteTargets.releaseScope(scopeId),
      closeMemory: async (scopeId, storeKey) => {
        await knowledgeVectors?.releaseScope(scopeOfScopeId(scopeId), scopeId);
        const loading = knowledgeStoreLoads.get(storeKey);
        if (loading) await Promise.allSettled([loading]);
        await knowledgeStores.get(storeKey)?.close();
        knowledgeStores.delete(storeKey);
      },
      files: new KernelFileResourceBackend(kernelStorageAdapter, { authorityPurpose: 'bot-data-cleanup' }),
    }),
    onError: (error) => {
      console.error('[VarinBots]', errorMessage(error));
    },
  });
  kernelClient.subscribeReady(() => {
    botAdmissionReady = false;
    void botService.publishExecutionGates().then(() => { botAdmissionReady = true; }, error => {
      console.error('[VarinBots] Execution gates could not be republished', errorMessage(error));
    });
  });
  await botService.publishExecutionGates();
  botCalendarScopes = async () => (await botService.list()).filter(bot => !bot.deletion).map(bot => ({ id: botScopeId(bot.id), path: bot.homeDir }));
  botAdmissionReady = true;
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
  const managedMcpInteractionsOwner: { current?: ReturnType<typeof createManagedMcpInteractions> } = {};
  const managedMcpOwner: { current?: ReturnType<typeof createManagedMcpPreparer> } = {};
  const mcpTaskRuntimeOwner: { current?: ReturnType<typeof createMcpTaskRuntime> } = {};
  const mcpResourceRuntimeOwner: { current?: ReturnType<typeof createMcpResourceRuntime> } = {};
  const scriptRuntimeOwner: { current?: ReturnType<typeof createScriptRuntime> } = {};
  const collaborationOwner: { current?: ThreadCollaboration } = {};
  const computerRuntimeOwner: { current?: ReturnType<typeof createComputerRuntime> } = {};
  const imageRuntimeOwner: { current?: ReturnType<typeof createImageRuntime> } = {};
  const extensionConfigurationListeners = new Set<() => void>();
  const researchDiscoveryOwner: { current?: ReturnType<typeof createResearchDiscoveryRuntime> } = {};
  const webRuntimeOwner: { current?: ReturnType<typeof createWebRuntime> } = {};
  const officeRuntimeOwner: { current?: ReturnType<typeof createOfficeRuntime> } = {};
  const browserRuntimeOwner: { current?: ReturnType<typeof createBrowserRuntime> } = {};
  const resolveComputerWork = async (work: import('@varin/protocol').ComputerWorkRef) => {
    if (!computerRuntimeOwner.current) throw new ComputerError('computer-owner-unavailable', 'The Agent Computer identity owner is unavailable');
    return computerRuntimeOwner.current.resolve(work);
  };
  const computerService = createComputerService({
    localControlHolder: options.onComputerControlsReady ? desktopControlHolder : undefined,
    resolveActor: async work => (await resolveComputerWork(work))?.actor ?? null,
    resolveScope: async work => (await resolveComputerWork(work))?.scope ?? null,
    cancelExecutor: async (actor, desktopIds) => {
      if (!scriptRuntimeOwner.current) throw new ComputerError('computer-owner-unavailable', 'The original script executor is unavailable');
      await scriptRuntimeOwner.current.cancelComputer(actor.execution.runId, desktopIds);
    },
    onAutomationInvalidated: (event) => broadcastGlobalUiEvent?.({ type: 'varin:computer-automation-invalidated', properties: event }),
    onAutomationChange: (state) => {
      // A previous Run can finish releasing input after the next one has started. Project the
      // registry's current root execution, never publish that old cleanup as the new round's state.
      void computerServiceRef.current?.automation.snapshot(state.rootWork).then(current => {
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
    resolveWork: async (work) => {
      const thread = await agentRuntime.thread(work.threadId).catch(error => {
        if (error instanceof KernelClientError && error.code === 'not-found') return null;
        throw error;
      });
      if (!thread) return null;
      if (!thread.branches.some(branch => branch.branch_id === work.branchId)) return null;
      return { scopeId: thread.bot_id ? botScopeId(thread.bot_id) : threadScopeId(thread.thread_id), threadId: thread.thread_id };
    },
    onControlEventCancel: async (command) => {
      if (!computerRuntimeOwner.current) throw new ComputerError('computer-owner-unavailable', 'The Agent Computer input owner is unavailable');
      await computerRuntimeOwner.current.cancelControlEvents(command);
    },
    onControlEvent: async (event) => {
      if (!computerRuntimeOwner.current) throw new ComputerError('computer-owner-unavailable', 'The Computer input owner is unavailable; the original fact remains pending');
      await computerRuntimeOwner.current.acceptControlEvent(event);
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
    threadStoreIfPresent: async threadId => await knowledgeStoreExistsForScope(threadScopeId(threadId)) ? getKnowledgeStoreForScope(threadScopeId(threadId)) : null,
    ownerForThread: async threadId => {
      const thread = await agentRuntime.thread(threadId);
      if (!thread.bot_id) throw new Error('Thread is not bound to a Bot');
      return { scope: 'bot', ownerId: thread.bot_id };
    },
    associationForThread: threadId => workAssociationForThread(threadId),
    readHistorySource: async (botId, span) => (await botHistory.read(botId, span)).text,
    vectors: () => knowledgeVectors,
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
  const agentPersonalization = createAgentPersonalization({ client: kernelClient, context: createPersonalizationContextResolver({ runtime: () => personalizationRuntime }), onChanged: () => { broadcastGlobalUiEvent?.({ type: 'varin:agent-personalization-changed', properties: {} }); void refreshThreadPersonalization().catch(() => console.error('[Thread] Personalization refresh requires attention')); } });
  // Bot background memory organizer reads durable session/run sources.
  // filters them with the memory-organization fast decision when bound, and
  // narrates proposals through the models.memoryOrganizer slot on the original
  // native inference owner. All commits go through memoryService, so inferred output
  // keeps suggested/accepted semantics, dedupe, and correction CAS.
  const memoryOrganizer = createMemoryOrganizer({
    getInference: () => memoryInference,
    hasNativeSources: scopeId => botHistory.hasSources(botIdFromScopeId(scopeId)),
    nativeMaterials: async (scopeId, afterHeads, sourceChars) => {
      if (!isBotScopeId(scopeId)) return { materials: [], heads: {} };
      const bot = await botService.get(botIdFromScopeId(scopeId));
      return bot?.entry.runtime === 'agent' ? botHistory.botBatch(bot.id, afterHeads, undefined, sourceChars) : { materials: [], heads: {} };
    },
    readNativeSource: async (scopeId, span) => (await botHistory.read(botIdFromScopeId(scopeId), span)).text,
    scopeForThread: async threadId => { const botId = (await agentRuntime.thread(threadId)).bot_id; return botId ? botScopeId(botId) : null; },
    storeForScopeId: getKnowledgeStoreForScope,
    hasStoreForScope: async (scopeId) => {
      const storePath = path.join(VARIN_DATA_DIR, 'knowledge', hostId, `${knowledgeStoreKeyForScope(scopeId)}.tdb`);
      return fsPromises.access(storePath).then(() => true, () => false);
    },
    listScopeIds: async () => {
      return (await botService.list()).map((bot) => botScopeId(bot.id)).sort();
    },
    canExecuteScope: canExecuteBotScope,
    // A Bot scope with no dedicated organizer slot inherits the Bot's own
    // model — Bot memory keeps organizing without a second configuration.
    organizerModelForScope: async (scopeId) => {
      if (!isBotScopeId(scopeId)) return null;
      const bot = await botService.get(botIdFromScopeId(scopeId));
      if (!bot || bot.archived) return null;
      if (bot.model) return bot.model;
      return botAgentModel(bot);
    },
    memory: memoryService,
    onError: (error) => console.error('[VarinMemoryOrganizer]', errorMessage(error)),
  });
  memoryOrganizerRef.current = memoryOrganizer;
  const inspectSourceInventory = createSourceGitInventory({ spawn: kernelProcesses.spawn, gitBinary: platformEnvironmentRuntime.resolveGitBinaryForSpawn(), env: { ...process.env, PATH: platformEnvironmentRuntime.buildAugmentedPath() } });
  const harnessWorkingStates = createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter, foundationalRecoveryEngine, kernelRecoveryStore, scopeDocumentWorkspace);
  const materialWriteSettled: { current?: (scope: string, threadId: string) => Promise<void> } = {};
  const materialStorage = createMaterialStorageAccess({ kernel: kernelClient, storage: kernelStorageAdapter,
    onMutationSettled: async (scope, threadId) => materialWriteSettled.current?.(scope, threadId),
    onCleanupError: () => console.error('[Materials] Original material cleanup requires attention') });
  const mediaResources = createMediaResourceStore(materialStorage);
  const webMaterials = createWebMaterialStore(materialStorage);
  webMaterialAccess.put = webMaterials.put;
  webMaterialAccess.read = webMaterials.read;
  webMaterialAccess.findAnalysis = webMaterials.findAnalysis;
  webMaterialAccess.findAnalysisConfig = webMaterials.findAnalysisConfig;
  const materialCollectionsService = createMaterialCollectionsService(materialStorage, { materials: webMaterials });
  const threadIntegrationCoordinator = new IntegrationCoordinator({ readIntegrationOperation: (workspaceId, operationId) => kernelRecoveryStore.getOperation(workspaceId, operationId), resolveDocumentWorkspaceId: scopeDocumentWorkspace, workingStates: harnessWorkingStates, inspectDirtyBuffers: workspaceId => documentsAuthority.inspectDirtyBuffers(workspaceId), beginDirtyStateBarrier: (workspaceId, paths) => documentsAuthority.beginDirtyStateBarrier(workspaceId, paths), requestSurfaceOperation: (request, options) => documentsAuthority.requestSurfaceOperation(request, options), resolveDirectoryApplyContext });
  observeThreadIntegrationParentChange = (workspaceId, resourceIds) => {
    threadIntegrationCoordinator.invalidateWorkspace(workspaceId, resourceIds);
  };
  void computerService.reconcileControlEvents().catch((error) => {
    console.error('[Computer] Handback delivery will retry:', errorMessage(error));
  });
  const projectTrust = new ProjectTrustService(VARIN_DATA_DIR, (id, signal) => documentsAuthority.admitWorkspaceRegistration(id, signal));
  registerProjectTrustRoutes(app, projectTrust, uiAuthController.requireAuth);
  const modelsService = new ModelsService(VARIN_DATA_DIR, { projectTrusted: cwd => projectTrust.trusted(cwd), fetch: egressRuntime.fetch as typeof globalThis.fetch });
  const executionEnvironment = createExecutionEnvironmentRuntime({ platform: platformEnvironmentRuntime,
    preference: async () => (await modelsService.settings.harness()).shell });
  app.get('/api/execution-environment', uiAuthController.requireAuth, async (req, res) => {
    try { const { searchPath: _searchPath, ...visible } = await executionEnvironment.snapshot(req.query.refresh === 'true'); res.json(visible); }
    catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  const stopModelDirectory = modelsService.startDirectory(egressRuntime.fetch as typeof globalThis.fetch);
  const resourceManagement = createResourceManagement({ dataDirectory: VARIN_DATA_DIR, documents: documentsAuthority, settings: modelsService.settings,
    promptTools: (context, signal) => promptToolCatalog(context, signal),
    resolveProjectRoot: async projectId => {
      const projects = sanitizeProjects((await readSettingsFromDisk()).projects) ?? [];
      const project = projects.find(entry => entry.id === projectId);
      return project?.path ?? null;
    },
  });
  registerResourceManagementRoutes(app, resourceManagement, uiAuthController.requireAuth);
  const modelExtensions = new ModelsExtensionOwner(extensionRuntime, modelsService, {
    publish: input => kernelClient.publishModelAdapters(input), revoke: bindingId => kernelClient.revokeModelAdapter(bindingId),
    retain: (bindingId, leaseId) => kernelClient.retainModelAdapter(bindingId, leaseId), release: leaseId => kernelClient.releaseModelAdapter(leaseId),
  }, egressRuntime.fetch as typeof globalThis.fetch);
  kernelClient.setModelProtocolOwner({ protocol: (bindingId, call, signal) => modelExtensions.protocol(bindingId, call, signal),
    release: bindingId => modelExtensions.release(bindingId), disconnected: () => modelExtensions.kernelDisconnected() });
  const unsubscribeModelKernel = kernelClient.subscribeReady(() => {
    void kernelClient.modelProtocolDisconnected().then(() => modelExtensions.kernelReady()).catch(() => {});
  });
  // Extension discovery owns its preparation; unrelated settings, MCP and builtins may start now.
  void modelExtensions.start().catch(() => { /* The owner publishes an unavailable issue; no partial candidate is selected. */ });
  const agentMcpDir = VARIN_DATA_DIR;
  permissionService(kernelClient).setPersistence(createPermissionPersistence(modelsService.settings, async runId => {
    const launch = await kernelClient.agentRuntimeRequest<import('./lib/kernel/protocol.generated.js').LaunchIntent | null, 'runtime.launch.inspect'>('runtime.launch.inspect', { runId });
    const workspace = launch?.selection.source?.resource_owner.kind === 'local'
      ? await documentsAuthority.admitWorkspaceRegistration(launch.selection.source.workspace_id) : undefined;
    return workspace && await projectTrust.trusted(workspace.canonicalPath) ? workspace.canonicalPath : undefined;
  }));
  const agentMcpPolicy = async (cwd: string, trusted: boolean) => {
    const harness = await modelsService.settings.harness(trusted ? cwd : undefined);
    return { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] };
  };
  const globalMcpProcesses = createKernelProcessService({ client: kernelClient, resolveIdentity: async () => {
    const canonicalRoot = await canonicalizePathIdentity(agentMcpDir);
    const workspaceId = `mcp-host:${hostId}`;
    return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
  } });
  registerModelRoutes(app, modelsService, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()), egressRuntime.fetch as typeof globalThis.fetch, kernelClient);
  const unsubscribeModelSettings = modelsService.settings.subscribe((scope, _cwd, revision) => {
    for (const listener of extensionConfigurationListeners) listener();
    for (const client of uiVarinEventClients) {
      try { writeSseEvent(client, { type: 'varin:settings-changed', properties: { owner: 'agent-settings', scope, revision, ids: [] } }); }
      catch { uiVarinEventClients.delete(client); }
    }
  });
  const unsubscribeProjectTrust = projectTrust.subscribe(revision => {
    for (const listener of extensionConfigurationListeners) listener();
    for (const client of uiVarinEventClients) {
      try { writeSseEvent(client, { type: 'varin:settings-changed', properties: { owner: 'agent-settings', scope: 'host', revision, ids: ['project-trust'] } }); }
      catch { uiVarinEventClients.delete(client); }
    }
  });
  let modelCatalogRevision = 0;
  const unsubscribeModels = modelsService.subscribe(kind => {
    if (kind === 'channels') void modelsService.tokenizers.collect();
    for (const listener of extensionConfigurationListeners) listener();
    const revision = String(++modelCatalogRevision), ids = [kind === 'authorization' ? 'model-authorization' : kind === 'credentials' ? 'model-credentials' : 'model-channels'];
    for (const client of uiVarinEventClients) {
      try { writeSseEvent(client, { type: 'varin:settings-changed', properties: { owner: 'agent-settings', scope: 'host', revision, ids } }); }
      catch { uiVarinEventClients.delete(client); }
    }
  });
  const mcpAuthority = new McpAuthority({
    reportDirectoryError: () => console.error('[MCP] Capability directory could not be persisted'),
    providerCredentialFiles: (_scope, providers) => providers.length ? [modelsService.credentialPath] : [],
    fetch: egressRuntime.fetch as typeof globalThis.fetch,
    adaptTransport: (scope, transport) => scope.resourceOwner.kind === 'managed_host'
      ? targetMcpService.adaptTransport(scope, transport) : transport instanceof StdioTransport
        ? createMcpProcessTransport(transport.options, (options, signal) =>
          (scope.admitProcess ? kernelProcesses.spawnAdmitted.bind(null, scope.admitProcess) : (scope.executionScope === 'global' ? globalMcpProcesses : kernelProcesses).spawn)(options.command, options.args ?? [], {
            cwd: options.cwd ?? scope.executionCwd, signal, stdio: 'pipe',
            env: options.inheritEnv === false ? { ...options.env } : { ...process.env, ...options.env },
          }), { child: null }) : transport,
    interactions: (input, scope) => scope.resourceOwner.kind === 'managed_host'
      ? targetMcpService.receiveInteraction(scope, input) : mcpInteractionRuntime.receiver(input),
    sampling: (input, scope) => scope.resourceOwner.kind === 'managed_host'
      ? targetMcpService.receiveSampling(scope, input) : mcpInteractionRuntime.samplingReceiver(input),
    interactionErrors: (input, scope) => scope.resourceOwner.kind === 'managed_host'
      ? targetMcpService.receiveInteractionError(scope, input) : mcpInteractionRuntime.errorReceiver(input),
    providerToken: async (_scope, provider) => modelsService.mcpBearerToken(provider),
    credentialScope: async (_scope, provider) => modelsService.currentScope(provider),
  });
  let mcpSettingsRevision = 0;
  const resolveMcpSettingsScope = async (cwd: string | undefined, signal: AbortSignal): Promise<import('./lib/mcp/authority.js').McpAuthorityScope> => {
    const workspace = cwd ? await documentsAuthority.resolveWorkspace({ path: cwd }) : undefined;
    signal.throwIfAborted();
    const root = workspace ? (await documentsAuthority.admitWorkspaceRegistration(workspace.workspaceId, signal)).canonicalPath : agentMcpDir;
    return { resourceOwner: { kind: 'local' }, agentDir: agentMcpDir, configCwd: root, executionCwd: root,
      environmentId: workspace ? `${hostId}:${workspace.workspaceId}` : `${hostId}:global`,
      executionScope: workspace ? 'workspace' : 'global', projectTrusted: !!workspace && await projectTrust.trusted(root), sessionId: 'mcp-settings' };
  };
  const mcpSettings = createMcpSettings({ authority: mcpAuthority,
    resolveScope: resolveMcpSettingsScope,
    changed: () => {
      const revision = String(++mcpSettingsRevision);
      for (const client of uiVarinEventClients) {
        try { writeSseEvent(client, { type: 'varin:settings-changed', properties: { owner: 'agent-settings', scope: 'host', revision, ids: ['mcp'] } }); }
        catch { uiVarinEventClients.delete(client); }
      }
    },
  });
  mcpSettings.register(app, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  const mcpCompositions = new McpCompositions(mcpAuthority, (code, reference) => { console.error('[MCP]', code, reference); });
  const agentMcpScopes = new Map<string, { identity: string; ready: Promise<McpCompositionScope> }>();
  const releaseAgentMcpScope = (runId: string) => {
    managedMcpOwner.current?.release(runId);
    const entry = agentMcpScopes.get(runId); agentMcpScopes.delete(runId);
    if (entry) void entry.ready.then(scope => scope.release(), () => undefined);
  };
  kernelClient.onToolReleased(releaseAgentMcpScope);
  kernelClient.subscribeExit(() => { for (const runId of agentMcpScopes.keys()) releaseAgentMcpScope(runId); });
  const prepareAgentPolicy = createAgentPolicy(extensionRuntime);
  const modelAuthority = createModelAuthority(modelsService, { retrySettings: async () => (await modelsService.readGlobalInferenceSettings()).retry, outputVisibleBytes: async () => (await modelsService.settings.harness()).output.visibleBytes });
  const botAgentModel = async (bot: import('@varin/application-client').BotSummary) => {
    const global = (await modelsService.settings.snapshot()).global;
    const selection = bot.model ?? (typeof global.defaultProvider === 'string' && typeof global.defaultModel === 'string'
      ? { providerId: global.defaultProvider, modelId: global.defaultModel } : null);
    if (selection && !(await modelAuthority.listModels()).some(model => model.providerId === selection.providerId && model.modelId === selection.modelId)) throw new Error('Bot model is no longer registered. Select an available Agent model in Bot settings.');
    return selection;
  };
  const liveSources = createLiveSourceOwner({ documents: documentsAuthority, kernel: kernelClient });
  const mcpProcessAdmission = (input: import('./lib/kernel/agent-runtime-client.js').McpPreparation) => {
    const source = input.source;
    if (!source || !input.executionCwd) throw new Error('MCP process requires its original source');
    return createMcpSourceProcessAdmission({ kernel: kernelClient, runId: input.runId, executionCwd: input.executionCwd,
      source: { resource_owner: source.resourceOwner, workspace_id: source.workspaceId, execution_workspace_id: source.executionWorkspaceId,
        branch_id: source.branchId ?? null, revision: source.revision ?? null, mode: source.mode, live_root: source.liveRoot ?? null,
        ...(source.environmentRunId ? { environment_run_id: source.environmentRunId } : {}) },
      admitWorkspaceRegistration: (id, signal) => documentsAuthority.admitWorkspaceRegistration(id, signal),
      validateLiveSource: async (selected, signal) => {
        if (selected.mode !== 'live_root' || !selected.live_root) throw new Error('MCP source is not live');
        await liveSources.validate({ workspaceId: selected.workspace_id, executionWorkspaceId: selected.execution_workspace_id, liveRoot: selected.live_root }, signal);
      },
    });
  };
  const prepareChildMcp = createChildMcpPreparer({
    processAdmission: mcpProcessAdmission,
    managed: createManagedChildMcpPreparer({ runtime: () => agentRuntime, createLease: input => createManagedMcpLease({ ...input, ...(managedMcpInteractionsOwner.current ? { interactions: managedMcpInteractionsOwner.current } : {}) }) }),
    authority: mcpAuthority, tasks:()=>mcpTaskRuntime, resources:()=>mcpResourceRuntime, kernel: kernelClient, agentDir: agentMcpDir, hostId,
    admitWorkspaceRegistration: (id, signal) => documentsAuthority.admitWorkspaceRegistration(id, signal),
    projectTrusted: cwd => projectTrust.trusted(cwd),
    currentPolicy: agentMcpPolicy,
  });
  managedMcpOwner.current = createManagedMcpPreparer({ runtime: () => agentRuntime, createLease: input => createManagedMcpLease({ ...input, ...(managedMcpInteractionsOwner.current ? { interactions: managedMcpInteractionsOwner.current } : {}) }),
    changed: runId => { void agentRuntime.refreshMcp(runId).catch(() => console.error('[MCP] Target contribution preparation requires attention')); },
    onError: () => console.error('[MCP] Target contribution is unavailable; original calls are not replayed'),
  });
  const agentRuntime: AgentRuntimeClient = new AgentRuntimeClient(kernelClient, async (input, signal) => {
    const projectMcp = input.child?.selected_profile.project_mcp;
    if (input.fixed && !input.projectDiscovery) return prepareChildMcp(input, signal);
    if (projectMcp) {
      const current = (sanitizeProjects((await readSettingsFromDisk()).projects) ?? []).find(project => project.id === projectMcp.project.id);
      if (!current || normalizePathIdentity(current.path) !== normalizePathIdentity(projectMcp.project.path))
        throw new Error('The selected project MCP configuration source changed; select the project again');
      if (!input.source || !input.executionCwd || !isDeepStrictEqual(input.source.resourceOwner, projectMcp.project.resource_owner))
        throw new Error('Project MCP requires the selected project’s admitted execution view');
    }
    // A read-only fixed branch has no executable filesystem view. Global MCP capabilities run
    // in the neutral Host scope; they must not borrow the mutable project directory.
    const workspace = input.source?.resourceOwner.kind === 'local' && input.executionCwd
      ? await documentsAuthority.admitWorkspaceRegistration(input.source.workspaceId, signal) : undefined;
    const configCwd = workspace?.canonicalPath ?? agentMcpDir;
    const scope = {
      ...(workspace ? { admitProcess: mcpProcessAdmission(input) } : {}),
      resourceOwner: { kind: 'local' as const },
      agentDir: agentMcpDir, configCwd, executionCwd: workspace ? input.executionCwd! : agentMcpDir,
      environmentId: workspace ? `${hostId}:${input.source!.executionWorkspaceId}` : `${hostId}:global`,
      executionScope: workspace ? 'workspace' as const : 'global' as const,
      projectTrusted: Boolean(workspace) && await projectTrust.trusted(configCwd),
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
    const managed = input.source?.resourceOwner.kind === 'managed_host' && input.source.mode !== 'fixed_branch';
    const localSelection = input.requiredBinding && managed
      ? selectMcpServers(input.requiredBinding, owner => owner.kind === 'local') : input.requiredBinding;
    const localLease = localSelection ? await owner.restore(localSelection, signal) : owner.snapshot();
    let lease: import('./lib/mcp/authority.js').McpAuthorityLease = localLease;
    let targetReady = false;
    let targetLease: import('./lib/kernel/managed-mcp-lease.js').ManagedMcpLease | undefined;
    if (managed) {
      try {
        targetLease = await managedMcpOwner.current!.prepare(input, signal);
        if (targetLease) {
          targetReady = true;
          const targetNames = Object.keys(targetLease.binding.provenance.servers);
          const shadowed = new Set(targetLease.binding.servers.map(server => server.name));
          lease = composeMcpAuthorityLeases([
            { lease: localLease, servers: Object.keys(localLease.binding.provenance.servers).filter(name => !shadowed.has(name)) },
            { lease: targetLease, servers: targetNames },
          ]);
        } else lease = composeMcpAuthorityLeases([{ lease: localLease, servers: Object.keys(localLease.binding.provenance.servers) }]);
      } catch (error) { localLease.release(); targetLease?.release(); throw error; }
    }
    const originalTarget = targetLease;
    try { return createMcpLease({ lease, kernel: kernelClient, tasks:mcpTaskRuntime,resources:mcpResourceRuntime,
      ...(originalTarget ? { retainChild: (binding: import('./lib/kernel/protocol.generated.js').SourceMcpChildBinding,
        selection: import('./lib/kernel/protocol.generated.js').McpBinding) => {
        const selected = selectMcpServers(selection, owner => owner.kind === 'managed_host');
        if (!Object.keys(selected.provenance.servers).length) return Promise.resolve({ release: async () => {} });
        return originalTarget.retainChild(binding, selected);
      } } : {}),
      ...(input.requiredBinding ? { selection: input.requiredBinding } : {}),
      ...(projectMcp?.tools ? { toolNames: projectMcp.tools } : {}),
      ...(input.source && !workspace && (!managed || !targetReady) ? { unavailableWorkspaceScope: {
        workspaceId: input.source.workspaceId,
        reason: managed ? 'The selected Host project MCP contribution is preparing or unavailable. Its tools are not being executed on this Host.' : 'Project MCP capabilities require a prepared execution environment matching the pinned source. Only global Host MCP capabilities are available for this read-only source.',
      } } : {}),
      currentPolicy: async () => {
        const trusted = Boolean(workspace) && await projectTrust.trusted(configCwd);
        if (scope.projectTrusted && !trusted) throw new Error('MCP project trust was revoked');
        return agentMcpPolicy(configCwd, trusted);
      },
    }); } catch (error) { lease.release(); throw error; }
  }, {
    prepare: (input, signal) => prepareAgentPolicy({ threadId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.requiredBinding ? { requiredBinding: input.requiredBinding } : {}) }, signal),
    observe: (input, changed, signal) => prepareAgentPolicy.observe({ threadId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}) }, changed, signal),
  }, createPolicyModelPreparer({ models: modelAuthority,
    // This is a user-scoped role. It does not inherit another Thread model binding.
    settings: async () => ({ global: await modelsService.readGlobalInferenceSettings() }),
  }), liveSources.validate, createExtensionTools({runtime:extensionRuntime,kernel:kernelClient,
    subscribeConfiguration: listener => { extensionConfigurationListeners.add(listener); return () => extensionConfigurationListeners.delete(listener); },
    prepareConfiguration: async (run, required) => {
    if (!scriptRuntimeOwner.current) throw new Error('Script tool preparation is unavailable');
    if (!computerRuntimeOwner.current) throw new ComputerError('computer-owner-unavailable', 'Computer tool preparation is unavailable');
    if (!webRuntimeOwner.current) throw new Error('Web tool preparation is unavailable');
    if (!researchDiscoveryOwner.current) throw new Error('Scholarly search tool preparation is unavailable');
    if (!imageRuntimeOwner.current) throw new Error('Image tool preparation is unavailable');
    if (!officeRuntimeOwner.current) throw new Error('Office tool preparation is unavailable');
    if (!browserRuntimeOwner.current) throw new Error('Browser tool preparation is unavailable');
    let configuration = await computerRuntimeOwner.current.prepareConfiguration(run, required);
    configuration = await scriptRuntimeOwner.current.prepareConfiguration(configuration, run.source);
    configuration = await webRuntimeOwner.current.prepareConfiguration(run, required, configuration);
    configuration = await researchDiscoveryOwner.current.prepareConfiguration(run, required, configuration);
    configuration = await imageRuntimeOwner.current.prepareConfiguration(run, required, configuration);
    configuration = await officeRuntimeOwner.current.prepareConfiguration(run, required, configuration);
    configuration = await browserRuntimeOwner.current.prepareConfiguration(run, required, configuration);
    if (required.length) return configuration;
    try {
      const root = run.source?.resource_owner.kind === 'local'
        ? (await documentsAuthority.admitWorkspaceRegistration(run.source.workspace_id)).canonicalPath : undefined;
      return configuredToolAvailability(await modelsService.settings.snapshot(root), configuration);
    } catch (error) { configuration.release?.(); throw error; }
  },currentPolicy:async runId=>{
    const launch=await kernelClient.agentRuntimeRequest<import('./lib/kernel/protocol.generated.js').LaunchIntent|null,'runtime.launch.inspect'>('runtime.launch.inspect',{runId});
    const workspace=launch?.selection.source?.resource_owner.kind === 'local'?await documentsAuthority.admitWorkspaceRegistration(launch.selection.source.workspace_id):undefined;
    const cwd=workspace?.canonicalPath??VARIN_DATA_DIR;
    return agentMcpPolicy(cwd,Boolean(workspace) && await projectTrust.trusted(cwd));
  }}), documentsAuthority.admitWorkspaceRegistration);
  agentRuntime.bindManagedSources(managedRemoteTargets);
  agentRuntime.executionEnvironment = () => executionEnvironment.snapshot();
  let stopTokenizerCollection: (() => Promise<void>) | undefined;
  const startTokenizerCollection = () => {
    stopTokenizerCollection ??= modelsService.tokenizers.startCollection({
      sources: async () => (await modelsService.read()).channels.flatMap(channel => channel.models.flatMap(model => model.tokenizer ? [model.tokenizer] : [])),
      durable: () => {
        if (!kernelClient.handshake) throw new Error('Runtime tokenizer references are unavailable');
        return agentRuntime.tokenizerReferences();
      },
    });
    void modelsService.tokenizers.collect();
  };
  const unsubscribeTokenizerKernel = kernelClient.subscribeReady(startTokenizerCollection);
  if (kernelClient.handshake) startTokenizerCollection();
  managedRecoveryOwner.current = createManagedRecoveryCoordinator({ coordinatorHostId: agentRuntime.coordinatorHostId,
    registry: managedRemoteTargets });
  kernelClient.setManagedSourceOwner(owner => agentRuntime.managedSource(owner), () => agentRuntime.coordinatorHostId);
  const managedSourceConsumers = createManagedSourceConsumers({ coordinatorHostId: () => agentRuntime.coordinatorHostId,
    registry: managedRemoteTargets, withRunAuthority: (runId, source, consume, signal) =>
      agentRuntime.withManagedSourceAuthority(runId, source, consume, signal) });
  kernelClient.setLanguageOwner(createLanguageOwner({ documents: documentsAuthority, supervisor: languageSupervisor,
    structure: () => structureSource,
    remote: managedSourceConsumers.query,
    sources: createSourceQueryOwner({ kernel: kernelClient, documents: documentsAuthority,
      validateLiveSource: liveSources.validate, remote: managedSourceConsumers.query }) }));
  const documentSources = createDocumentSources({ kernel: kernelClient, runtime: agentRuntime,
    resolveLiveSource: liveSources.validate, experiments: experimentService });
  const binaryFiles = createBinaryFileOwner({ kernel: kernelClient, runtime: agentRuntime, resolveLiveSource: liveSources.validate });
  browserRuntimeOwner.current = createBrowserRuntime({ browser: options.browser, runtime: agentRuntime, sources: documentSources,
    files: binaryFiles, materials: webMaterials, documents: documentReader, office: officeReader,
    settings: async source => {
      const root = source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
      return modelsService.settings.snapshot(root);
    },
  });
  officeRuntimeOwner.current = createOfficeRuntime({ runtime: agentRuntime, reader: officeReader, renderer: officeRenderer, sources: documentSources, files: binaryFiles,
    settings: async source => {
      const root = source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
      return modelsService.settings.snapshot(root);
    },
  });
  webRuntimeOwner.current = createWebRuntime({ runtime: agentRuntime, webFetch: webFetchService, documentReader, materials: webMaterials,
    alternateDocumentReader: officeReader.document,
    collections: materialCollectionsService,
    documentSources,
    fetch: egressRuntime.fetch as typeof globalThis.fetch, readAuth: serviceCredentials.read,
    settings: async source => {
      const root = source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
      return modelsService.settings.snapshot(root);
    },
  });
  researchDiscoveryOwner.current = createResearchDiscoveryRuntime({ service: researchSearchService,
    settings: async source => {
      const root = source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
      return modelsService.settings.snapshot(root);
    },
  });
  const fileObservationOwner = new DocumentsFileObservationOwner(documentsAuthority, liveSources.validate,
    receiptId => fileObservations.changed(receiptId),nativeWorkspaces);
  const fileObservations = new FileObservationService(agentRuntime, fileObservationOwner,
    () => console.error('[Followup] Original file observation requires attention'),nativeWorkspaces);
  kernelClient.setFileObservationOwner(fileObservationOwner);
  void fileObservations.recover();
  const modelText = createModelTextService({ kernel: kernelClient, runtime: agentRuntime, models: modelAuthority,
    readSettings: async () => (await modelsService.settings.read()).document,
  });
  const threadTitles = createThreadTitleService({ runtime: agentRuntime, modelText,
    botSession: async (thread, signal) => {
      const bot = thread.bot_id ? await botService.get(thread.bot_id) : null;
      if (!bot || bot.entry.threadId === thread.thread_id) return false;
      return (await agentRuntime.botScope(bot.id, signal, true)).sessions.includes(thread.thread_id);
    },
    onError: error => {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'title-generation-failed';
      console.error('[ThreadTitle] Auxiliary title generation failed; the input title is retained:', code);
    },
  });
  registerModelTestRoute(app, modelsService, modelAuthority, modelText, uiAuthController.requireAuth);
  const threadNotifications = createThreadNotificationRuntime({
    runtime: agentRuntime,
    onError: () => console.error('[Notifications] Native activity projection is unavailable'),
    send: async payload => {
      const settings = await readSettingsFromDisk();
      if (settings.notifyOnCompletion === false && payload.kind !== 'attention') return;
      const delivered = getIsWindowFocused() && settings.notificationMode !== 'always' ? false : emitDesktopNotification(payload);
      broadcastUiNotification(payload, { desktopNotificationDelivered: delivered });
      const pushPayload = { ...payload, data: { type: 'thread', threadId: payload.threadId, branchId: payload.branchId,
        url: '/?thread=' + encodeURIComponent(payload.threadId) + '&branch=' + encodeURIComponent(payload.branchId) } };
      await Promise.allSettled([sendPushToAllUiSessions(pushPayload, { requireNoSse: true }),
        isAnyInteractiveClientVisible() ? Promise.resolve() : sendMobilePushToAllDevices(pushPayload), sendApnsToAllUiSessions(pushPayload)]);
    },
  });
  const threadMaterialLifetime = createThreadMaterialLifetime({ runtime: agentRuntime, storage: materialStorage, materials: webMaterials,
    releaseSource:(source,id,signal)=>nativeWorkspaces!.retireSource(source,id,signal),
    releasePreparations:threads=>releaseSourcePreparations(threads),
    ...(options.browser ? { releaseBrowser: (threadId: string) => options.browser!.releaseThread(threadId) } : {}) });
  const contentMaintenance = createContentMaintenance({ runtime: agentRuntime,
    releaseDeletedResources: signal => threadMaterialLifetime.releaseDeleted(signal),
    onError: () => console.error('[ContentMaintenance] Deleted conversation cleanup will retry after runtime activity'),
  });
  requestSourceMaintenance=contentMaintenance.resourceIdle;
  const removeWorkspaceIdleMaintenance=kernelClient.onWorkspaceIdle(()=>contentMaintenance.resourceIdle());
  materialWriteSettled.current = async (scope, threadId) => {
    // A UI upload admitted before deletion can settle after Catalog maintenance.
    // Its original namespace still identifies the bytes, even after lineage retires.
    if ((await agentRuntime.thread(threadId)).deleted_at_ms !== null) {
      await threadMaterialLifetime.releaseLateWrite(scope, threadId);
      contentMaintenance.request();
    }
  };
  const runObservers = new RunObservers(agentRuntime, extensionRuntime, (threadId, _error) => {
    console.error('[RunObserver] Activity projection requires attention:', threadId ?? 'selection');
  });
  personalizationRuntime = agentRuntime;
  const botHistory = createBotHistory(agentRuntime);
  const botRecallContext = createBotRecallContext({ runtime: agentRuntime,
    projects: async () => sanitizeProjects((await readSettingsFromDisk()).projects) ?? [] });
  const workAssociationForThread = async (threadId: string) => {
    return (await botRecallContext({ threadId, query: '' })).associated;
  };
  const threadWorkingStates = createKernelWorkspaceWorkingStateAccess(kernelStorageAdapter);
  const threadResourceOwners: Parameters<typeof createThreadResourceScope>[0] = {
    dataDirectory: VARIN_DATA_DIR, documents: documentsAuthority, workingStates: threadWorkingStates, resolvePrimaryWorktreeRoot,
    validateLiveSource: liveSources.validate,
    resolveNativeSource:async(source,signal)=>{
      const ref={workspace_id:source.workspaceId,execution_workspace_id:source.executionWorkspaceId,branch_id:source.branchId,...(source.nativeScope?{native_scope:source.nativeScope}:{})};
      const entry=await nativeWorkspaces!.open(ref,signal);
      const actual=await nativeWorkspaces!.acquire(ref,entry.grant,signal);
      return {hostId:actual.hostId,rootId:actual.rootId,canonicalRoot:actual.path};
    },
    projectTrusted: async root => projectTrust.trusted((await nativeWorkspaces?.resolvePath(root,true))?.originalPath??root),
    configuration: (root, resources) => readAgentResourceConfiguration({ dataDirectory: VARIN_DATA_DIR, settings: modelsService.settings, ...(root ? { cwd: root } : {}), ...(resources ? { resources } : {}) }),
    withSourceRead: (input, consume) => kernelStorageAdapter.withResourceRead(input, consume),
  };
  const threadResources = createThreadResourceScope({ ...threadResourceOwners, remote: managedSourceConsumers.resources });
  const threadContext = createThreadContext({ personalization: agentPersonalization,
      botForThread: async threadId => {
        const botId = (await agentRuntime.thread(threadId)).bot_id;
        if (!botId) return null;
        const bot = await botService.get(botId);
        if (!bot) throw new Error('Bot profile is unavailable');
        return { id: bot.id, name: bot.name, instructions: bot.instructions, revision: (await botService.executionGate(bot.id)).profileRevision };
      },
      resources: threadResources,
      composition: createContextComposition(extensionRuntime),
      projectForWorkspace: async (workspaceId, source) => {
        if (source.resourceOwner.kind === 'managed_host') return undefined;
        const { canonicalPath: root } = await documentsAuthority.admitWorkspaceRegistration(workspaceId);
        const projects = sanitizeProjects((await readSettingsFromDisk()).projects) ?? [];
        return projects.find(project => projectContainsPath(project, root))?.id;
      },
    });
  const interactiveUi = createInteractiveUiRuntime({ kernel: kernelClient, runtime: agentRuntime, media: mediaResources });
  registerInteractiveUiRoutes(app, interactiveUi, uiAuthController.requireAuth);
  kernelClient.setResourceOwner(createResourceOwner({ runtime: agentRuntime, resources: threadResources, ui: interactiveUi }));
  kernelClient.setPlanOwner(createPlanOwner(getUserKnowledgeStore, agentRuntime));
  kernelClient.setMemoryOwner(createMemoryOwner({ personalization: agentPersonalization, prepareContext: threadContext,
    bot: createBotMemoryOwner({ runtime: agentRuntime, history: botHistory, memory: memoryService, prepareContext: threadContext,
      knowledge: input => knowledgeContextRuntime.knowledgeForThread(input) }) }));
  const contextCompaction = createContextCompaction(extensionRuntime);
  const contextAgent = createContextAgent({ settings: modelsService.settings, models: modelAuthority });
  const contextService=new ContextService(agentRuntime,threadContext,async(run,launch,signal)=>{
    const source=launch?.selection.source;
    const root=source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
    const admitted=await agentRuntime.contextScope(run.id,signal);
    const model=run.configuration as {providerId?:string;model:string;contextWindowTokens?:number};
    const policy=await readContextPolicy({settings:await modelsService.settings.snapshot(root),...(root?{projectRoot:root}:{}),
      ...(model.providerId?{providerId:model.providerId}:{}),modelId:model.model,contextWindowTokens:model.contextWindowTokens ?? null});
    return {policy,scope:{threadId:run.thread_id,...(admitted?.projectId?{projectId:admitted.projectId}:{}),...(root?{workspaceId:root}:{})}};
  },(runId,signal,credentialOwner)=>threads.continueLaunch(runId,{signal,...(credentialOwner?{credentialOwner}:{})}),createContextBudget(extensionRuntime));
  contextService.bindCompaction(contextCompaction);
  contextService.bindContextAgent(contextAgent);
  kernelClient.setContextOwner(contextService);
  const prepareThreadSource = createThreadSourcePreparer({
    inspectInventory: (directory, signal) => inspectSourceInventory(directory, signal),
    sourceTools: mode => agentRuntime.sourceTools(mode), documents: documentsAuthority, liveSources, nativeWorkspaces,
    workingStates: threadWorkingStates, prepareResources: threadResources.prepareSourceCapture, remote: managedSourceConsumers.threads });
  releaseSourcePreparations=threads=>prepareThreadSource.releaseDeletedThreads(threads);
  const threads = new ThreadAdapter(agentRuntime,
    modelAuthority, createThreadSourceAdmission({ documents: documentsAuthority, liveSources, nativeWorkspaces, remote: managedSourceConsumers.threads,
      withSourceRead: (input, consume) => kernelStorageAdapter.withResourceRead(input, consume), runtime: agentRuntime }), (runId, _error) => {
      // Durable launch remains inspectable/resumable. Never log credentials or provider responses.
      console.error('[Thread] Launch preparation requires attention:', runId);
    }, prepareThreadSource,
    threadContext, new PlanService(agentRuntime, getUserKnowledgeStore), createThreadSkillInputPreparer(threadResources), createThreadProcesses({ runtime: agentRuntime, kernel: kernelClient,
      terminal: () => terminalRuntime, resolveLiveSource: liveSources.validate,
      onError: () => console.error('[Thread] Original process terminal requires attention'),
    }), createChildProfilePreparer({ models: modelAuthority,
      projects: async () => (sanitizeProjects((await readSettingsFromDisk()).projects) ?? []).map(project => ({ id: project.id, name: typeof project.label === 'string' && project.label || project.path, path: project.path, resource_owner: { kind: 'local' as const } })),
      externalAgents: () => externalAgents.settings(),
      settings: () => modelsService.readGlobalInferenceSettings(),
      projectWorkFocus: async projectId => {
        const focus = (sanitizeProjects((await readSettingsFromDisk()).projects) ?? []).find(project => project.id === projectId)?.defaultWorkFocus;
        return focus === 'code' || focus === 'research' ? focus : undefined;
      },
      capabilities: signal => agentRuntime.childCapabilities(signal),
    }));
  const sourceDirectory = createThreadSourceDirectory({ documents: documentsAuthority, remote: managedSourceConsumers.threads });
  const prepareProjectSource = createChildProjectSourcePreparer({ projects: async () => sanitizeProjects((await readSettingsFromDisk()).projects) ?? [],
    inspectBackend:(projectId,signal)=>nativeWorkspaces.inspectBackend(projectId,signal),sources: sourceDirectory, prepare: prepareThreadSource });
  threads.bindBotWorkProfile(async botId => {
    const bot = await botService.get(botId);
    if (!bot || !await botService.canExecute(botId)) return null;
    const model = await botAgentModel(bot);
    return model ? { homeDir: bot.homeDir, model } : null;
  });
  threads.bindTitles(threadTitles);
  void threadTitles.recover();
  const nextSteps = createNextStepService({ runtime: agentRuntime, modelText,
    readSettings: () => modelsService.readGlobalInferenceSettings(),
    onError: code => console.error('[NextStep] Auxiliary suggestion unavailable:', code),
  });
  const unsubscribeNextStepSettings = modelsService.settings.subscribe(scope => { if (scope === 'global') void nextSteps.settingsChanged(); });
  threads.bindNextSteps(nextSteps);
  threads.bindContextPolicy((run, signal) => contextService.presentation(run, signal));
  threads.bindSourceDirectory(sourceDirectory);
  threads.bindContentMaintenance(contentMaintenance.request);
  externalAgents.bindContentMaintenance(contentMaintenance.request);
  threads.bindFileResolver(createThreadFileTargetResolver({ storageRoot: kernelClient.handshake!.storageRoot,
    documents: documentsAuthority, validateLiveSource: liveSources.validate,nativeWorkspaces }));
  threads.bindMaterials(webRuntimeOwner.current.inputMaterials);
  threads.bindMessageTime(async () => {
    const settings = await modelsService.readGlobalInferenceSettings();
    return resolveMessageTimeSettings((settings.harness as { context?: { messageTime?: unknown } } | undefined)?.context?.messageTime);
  });
  threads.bindCompaction(contextCompaction);
  threads.bindContextAgent(contextAgent);
  scheduledTaskService.bindSourceDirectory(sourceDirectory);
  const targetSourceQuery = createSourceQueryService({ kernel: kernelClient, documents: documentsAuthority,
    validateLiveSource: liveSources.validate, storage: kernelStorageAdapter,
    resourceOwners: threadResourceOwners, languageSupervisor, structureSource: () => structureSource });
  const targetChildSources = createManagedChildSourceService({ storage: kernelStorageAdapter,
    capture: { documents: documentsAuthority, prepareResources: threadResources.prepareSourceCapture,
      inspectInventory: (directory, signal) => inspectSourceInventory(directory, signal) } });
  const targetIntegrations = createManagedIntegrationService({ kernel: kernelClient, storage: kernelStorageAdapter,
    documents: documentsAuthority, recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore,
    coordinator: threadIntegrationCoordinator });
  const targetCodeExchange = createManagedCodeExchangeService({ kernel: kernelClient, storage: kernelStorageAdapter,
    documents: documentsAuthority, recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore,
    coordinator: threadIntegrationCoordinator });
  const userIntegrationOwners = { kernel: kernelClient, runtime: agentRuntime, storage: kernelStorageAdapter,
    documents: documentsAuthority, recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore,
    coordinator: threadIntegrationCoordinator, resolveLiveSource: liveSources.validate };
  const targetUserIntegrations = createUserIntegrationService(userIntegrationOwners);
  const exchangeJournalOwners = { journal: kernelRecoveryStore, files: kernelRecoveryContentStore };
  const targetExchangeReader = createManagedCodeExchangeReader(exchangeJournalOwners);
  threads.bindCodeExchangeReader(createThreadCodeExchangeReader({ ...exchangeJournalOwners, runtime: agentRuntime }));
  const userIntegrations = createThreadIntegrations({ ...userIntegrationOwners, requireIdentity: identity => threads.requireIdentity(identity),
    onError: () => console.error('[Integration] Original source cleanup requires attention') });
  const targetRecovery = createManagedRecoveryService({ kernel: kernelClient, hostId, documents: documentsAuthority,
    storage: kernelStorageAdapter, store: kernelRecoveryStore, recovery: foundationalRecoveryEngine,
    validateLiveSource: liveSources.validate });
  const targetScheduleReceipts = createKernelManagedScheduleReceipts(kernelClient,
    operationId => console.error('[Schedules] Original target receipt publication requires attention:', operationId));
  const targetSchedules = createManagedScheduleService({ hostId, service: scheduledTaskService,
    workspaceRoot: async workspaceId => (await documentsAuthority.admitWorkspaceRegistration(workspaceId)).canonicalPath,
    receipts: targetScheduleReceipts,
    onReceiptError: operationId => console.error('[Schedules] Original target receipt publication is pending:', operationId) });
  const targetMcpService = createManagedMcpService({ kernel: kernelClient, authority: mcpAuthority, compositions: mcpCompositions, agentDir: agentMcpDir, hostId,
    admitSource: async (scope, signal) => {
      await kernelClient.sourceRequest('source.service.call', { principalId: scope.principal.principalId,
        coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch,
        requestId: `mcp-validate:${crypto.randomUUID()}`, clientCapabilities: [...scope.principal.capabilities], operation: { kind: 'validate' } }, signal);
    },
    transportOwner: (scope, readmit) => createManagedMcpProcesses({ kernel: kernelClient, scope, readmit,
      onError: () => console.error('[MCP] Original target process observation is unavailable') }),
    admitWorkspaceRegistration: (id, signal) => documentsAuthority.admitWorkspaceRegistration(id, signal),
    projectTrusted: cwd => projectTrust.trusted(cwd),
  });
  kernelClient.subscribeExit(() => { void targetMcpService.close(); });
  managedRemoteExecution.setSourceOwner(createManagedSourceService({ kernel: kernelClient, hostId,
    executionEnvironment: () => executionEnvironment.snapshot(),
    documents: documentsAuthority, validateLiveSource: liveSources.validate, prepareSource: prepareThreadSource,
    recovery: targetRecovery.handle,
    readCodeExchange: targetExchangeReader,
    releaseMcpView: (scope, action) => targetMcpService.releaseView(scope, action),
    mcpTaskContinuation: (scope, action, signal) => targetMcpService.taskContinuation(scope, action, signal),
    mcpResourceContinuation: (scope, action, signal) => targetMcpService.resourceContinuation(scope, action, signal),
    mcpInteractionContinuation: (scope, action, signal) => targetMcpService.interactionContinuation(scope, action, signal),
    mcpDerivationContinuation: (scope, action, signal) => targetMcpService.derivationContinuation(scope, action, signal),
    mcpChildContinuation: (scope, action, signal) => targetMcpService.childContinuation(scope, action, signal),
    releaseSource: async (scope, retention) => {
      const [, mcp] = await Promise.all([targetSourceQuery.release(scope), targetMcpService.release(scope, retention), targetScheduleReceipts.flush(scope)]);
      return { mcpExecutorStopped: mcp.executorStopped, mcpTaskControlsDrained: mcp.taskControlsDrained };
    }, cleanupSource: async scope => { await targetScheduleReceipts.flush(scope); await targetSourceQuery.cleanup(scope); },
    serviceOperation: (scope, operation, signal) => {
      switch (operation.kind) {
        case 'mcp': return targetMcpService.request(scope, operation.action, signal);
        case 'child_refresh_capture': case 'child_prepare': case 'child_result_prepare': case 'child_result_publish': case 'child_result_read': case 'child_release': case 'child_unaccepted_release':
          return targetChildSources(scope, operation, signal);
        case 'integration': return targetIntegrations(scope, operation, signal);
        case 'code_capture': case 'code_apply': return targetCodeExchange(scope, operation, signal);
        case 'user_integration': return targetUserIntegrations(scope, operation, signal);
        case 'schedule': return targetSchedules(scope, operation, signal);
        default: return targetSourceQuery(scope, operation, signal);
      }
    },
  }));
  const threadRecoveryOwners = { threads, runtime: agentRuntime, store: kernelRecoveryStore, storage: kernelStorageAdapter, kernel: kernelClient, liveSources };
  const threadRecoveryNavigation = createThreadRecoveryNavigation(threadRecoveryOwners);
  const recoveryCheckpoints = createCheckpointLifecycle({
    settleManaged: (turns, signal) => managedRecoveryOwner.current!.settle!(turns, signal),
    runtime: agentRuntime, store: kernelRecoveryStore,
    workspaces: () => documentsAuthority.listWorkspaceRegistrations(),
    onError: (runId, _error) => console.error('[Recovery] Checkpoint settlement requires attention:', runId ?? 'workspace'),
  });
  kernelRecoveryStore.bindCheckpointRefresh(recoveryCheckpoints.refresh);
  const localRecoveryFileResolver = createThreadRecoveryFileResolver(threadRecoveryOwners);
  recoveryFileTargetResolver=async target=>targetRecovery.resolveFileTarget(target)??await localRecoveryFileResolver.resolveTarget(target);
  const fileRecoveryService = createFileRecoveryService({ runtime: agentRuntime, kernel: kernelClient,
    storage: kernelStorageAdapter, store: kernelRecoveryStore, documents: documentsAuthority, resolveFiles: localRecoveryFileResolver });
  kernelRecoveryContentStore.bindTargetResources(async identity =>
    await targetRecovery.resolveFileResources(identity) ?? localRecoveryFileResolver(identity));
  threads.bindRecoveryReader(async (identity, signal) => {
    try {
    const branch = { threadId: identity.threadId, branchId: identity.branchId };
    const sources = await agentRuntime.recoveryWorkspaces(branch, signal);
    const receipt = await agentRuntime.navigationReceipt(branch, signal);
    const workspaces = [...new Set([recoveryCoordinatorWorkspace,
      ...sources.filter(source => source.resource_owner.kind === 'local').map(source => source.workspace_id)])];
    const operations = (await Promise.all(workspaces.map(async workspaceId => {
      const result = await foundationalRecoveryEngine.listCombinedOperations(workspaceId, signal);
      if (result.status !== 'ready') throw new Error('Recovery status unavailable');
      return result.operations.map(({editorText: _text,editorImages: _images,...operation}) => operation).filter(operation => operation.conversation.kind === 'thread' && operation.conversation.threadId === identity.threadId && operation.conversation.branchId === identity.branchId);
    }))).flat();
    return { navigation: receipt && !operations.some(operation => operation.id === receipt.key) ? receipt : null, operations };
    } catch { signal?.throwIfAborted(); return {navigation:null,operations:[],unavailable:"Recovery status is unavailable; conversation history remains readable"}; }
  });
  threadRecoveryReady = true;
  await foundationalRecoveryEngine.resumeCombinedOperations();
  const reconcileScheduleReceipts = createManagedScheduleReconciler({ runtime: agentRuntime,
    onError: (_operationId, _error) => console.error('[Schedule] Original effect receipt requires attention') });
  const reconcileFileEffectReceipts = createFileEffectReceiptReconciler({ runtime: agentRuntime,
    onError: (_operationId, _error) => console.error('[Integration] Original effect receipt requires attention') });
  const reconcileMaterialReceipts = createMaterialReceiptReconciler({ runtime: agentRuntime, kernel: kernelClient, collections: materialCollectionsService,
    onError: (_operationId, _error) => console.error('[Materials] Original mutation receipt requires attention') });
  const collaboration = new ThreadCollaboration({ runtime: agentRuntime, prepareProjectSource,
    canExecuteThread: async threadId => {
      const botId = (await agentRuntime.thread(threadId)).bot_id;
      return !botId || (await botService.executionGate(botId)).permitted;
    },
    kernel: kernelClient, storageAdapter: kernelStorageAdapter, resolveLiveSource: liveSources.validate,
    sourceCaptureOwners: { documents: documentsAuthority, prepareResources: threadResources.prepareSourceCapture, inspectInventory: (directory, signal) => inspectSourceInventory(directory, signal) },
    reconcileDomainReceipts: async signal => { await Promise.all([reconcileFileEffectReceipts(signal), reconcileMaterialReceipts(signal), reconcileScheduleReceipts(signal)]); },
    continueRun: (runId, signal) => threads.continueLaunch(runId, { signal }), recoverLaunches: signal => threads.recover(signal),
    recoverColdBotWork: signal => threads.recoverBotWork(signal),
    onWorkChanged: () => broadcastGlobalUiEvent?.({ type: 'varin:bot-work-changed', properties: {} }),
    recoverCheckpoints: recoveryCheckpoints.recover, settleRunCheckpoints: recoveryCheckpoints.settle,
    prepareContext: threadContext,
    prepareMaterials: threadMaterialLifetime.prepareChild,
    prepareSkillInput: createThreadSkillInputPreparer(threadResources),
    onError: (operationId, _error) => console.error('[Collaboration] Preparation or delivery requires attention:', operationId ?? 'discovery'),
  });
  collaborationOwner.current = collaboration;
  externalAgents.startChildren(createExternalSourceOwner({ kernel: kernelClient, storage: kernelStorageAdapter, prepareProjectSource,
    capture: { documents: documentsAuthority, prepareResources: threadResources.prepareSourceCapture, inspectInventory: (directory, signal) => inspectSourceInventory(directory, signal) } }));
  void collaboration.recover();
  const refreshThreadPersonalization = () => threads.refreshPersonalization();
  void refreshThreadPersonalization().catch(() => console.error('[Thread] Personalization refresh requires attention'));
  void contextService.recover().catch(() => console.error('[Thread] Saved context job discovery requires attention'));
  const calendarOwner = new CalendarOwner({ runtime: agentRuntime,
    projects: scheduledScopes,
    prepare: (work, projectPath, signal) => threads.prepareCalendarWork(work, projectPath, signal),
    onChanged: () => { for (const client of uiVarinEventClients) { try { writeSseEvent(client, { type: 'varin:scheduled-task-changed', properties: {} }); } catch { uiVarinEventClients.delete(client); } } },
    onError: () => console.warn('[Calendar] preparation or asset synchronization requires attention'),
  });
  scheduledTasksRuntime.setCalendarOwner(calendarOwner);
  scriptRuntimeOwner.current = createScriptRuntime({ kernel: kernelClient, runtime: agentRuntime, resolveLiveSource: liveSources.validate, onError: () => console.error('[Script] Original environment requires reconciliation') });
  computerRuntimeOwner.current = createComputerRuntime({ kernel: kernelClient, runtime: agentRuntime, computers: computerService, enabled: async runId => {
    const launch = await kernelClient.agentRuntimeRequest<import('./lib/kernel/protocol.generated.js').LaunchIntent | null, 'runtime.launch.inspect'>('runtime.launch.inspect', { runId });
    const workspace = launch?.selection.source?.resource_owner.kind === 'local' ? await documentsAuthority.admitWorkspaceRegistration(launch.selection.source.workspace_id) : undefined;
    return (await modelsService.settings.harness(workspace?.canonicalPath)).tools?.computer !== false;
  } });
  const mcpInteractionRuntime = createMcpInteractionRuntime({kernel:kernelClient,runtime:agentRuntime,onError:()=>console.error('[MCP] Original user interaction requires reconciliation')});
  agentRuntime.setMcpInteractionOwner(mcpInteractionRuntime);
  const managedMcpInteractions = createManagedMcpInteractions({ kernel: kernelClient, runtime: agentRuntime, interactions: mcpInteractionRuntime,
    onError: () => console.error('[MCP] Original remote interaction delivery requires reconciliation') });
  managedMcpInteractionsOwner.current = managedMcpInteractions;
  agentRuntime.setManagedMcpInteractions(managedMcpInteractions);
  const mcpTaskRecovery = createMcpTaskRecovery({kernel:kernelClient,authority:mcpAuthority,agentDir:agentMcpDir,hostId,runtime:agentRuntime,interactions:managedMcpInteractions,
      admitWorkspaceRegistration:(id,signal)=>documentsAuthority.admitWorkspaceRegistration(id,signal),projectTrusted:cwd=>projectTrust.trusted(cwd),
      validateLiveSource:async(source,signal)=>{
        if(source.mode!=='live_root'||!source.live_root)throw new Error('MCP Task live source missing');
        await liveSources.validate({workspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id,liveRoot:source.live_root},signal);
      },
    });
  const mcpTaskRuntime = createMcpTaskRuntime({ kernel: kernelClient, runtime: agentRuntime,
    recover: mcpTaskRecovery, recoverCreation: mcpTaskRecovery.recoverCreation, cleanup: mcpTaskRecovery.cleanup,
    onError:()=>console.error('[MCP] Original task reconciliation requires attention'),
  });
  mcpTaskRuntimeOwner.current = mcpTaskRuntime;
  const mcpResourceRecovery=createMcpResourceRecovery({kernel:kernelClient,authority:mcpAuthority,agentDir:agentMcpDir,hostId,runtime:agentRuntime,interactions:managedMcpInteractions,
      admitWorkspaceRegistration:(id,signal)=>documentsAuthority.admitWorkspaceRegistration(id,signal),projectTrusted:cwd=>projectTrust.trusted(cwd),
      currentPolicy:agentMcpPolicy,
      validateLiveSource:async(source,signal)=>{if(source.mode!=='live_root'||!source.live_root)throw new Error('MCP resource original live source missing');
        await liveSources.validate({workspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id,liveRoot:source.live_root},signal);},
    });
  const mcpResourceRuntime=createMcpResourceRuntime({kernel:kernelClient,runtime:agentRuntime,
    recover:mcpResourceRecovery,recoverCreation:mcpResourceRecovery.recoverCreation,cleanup:mcpResourceRecovery.cleanup,
    onError:()=>console.error('[MCP] Original resource observation requires reconciliation'),
  });
  mcpResourceRuntimeOwner.current=mcpResourceRuntime;
  agentRuntime.setMcpResourceOwner(mcpResourceRuntime);
  const researchRuntime = createResearchRuntime({ kernel: kernelClient, runtime: agentRuntime,
    experiments: experimentService, resources: resourceService, sources: sourceService,
    onError: (_error: Error) => console.error('[Research] Original job reconciliation requires attention'),
  });
  computerRuntimeOwner.current.start(error => console.error('[Computer] Native execution cleanup is unconfirmed:', error instanceof Error ? error.message : String(error)));
  registerThreadRoutes(app, threads, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()), researchRuntime.user, computerRuntimeOwner.current.user, webRuntimeOwner.current.user, userIntegrations);
  const agentProfiles = createAgentProfilesAPI({ settings: modelsService.settings,
    capabilities: signal => agentRuntime.childCapabilities(signal),
    contextAgentDefinition: signal => agentRuntime.contextAgentDefinition(signal),
    onChanged: () => {
      for (const client of uiVarinEventClients) {
        try { writeSseEvent(client, { type: 'varin:settings-changed', properties: { owner: 'agent-settings' } }); }
        catch { uiVarinEventClients.delete(client); }
      }
    },
  });
  registerAgentProfileRoutes(app, agentProfiles, uiAuthController.requireAuth);
  threads.bindAgentProfiles(agentProfiles);
  isNativeThreadLive = async identity => {
    const thread = await agentRuntime.thread(identity.threadId);
    return thread.deleted_at_ms === null && thread.branches.some(branch => branch.branch_id === identity.branchId);
  };
  registerRuntimeMaintenanceRoutes(app, agentRuntime, uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  registerBotRoutes(app, {
    bots: botService,
    work: agentRuntime,
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
    authenticateUpgrade: (request) => uiAuthController?.resolveAuthContext(request, null, { allowClientAuth: true, allowUrlToken: true }) ?? Promise.resolve(null),
    originAllowed: isRequestOriginAllowed,
  });
  void connections.restore().catch((error) => console.error('[HostConnections]', errorMessage(error)));
  registerManagedRemoteRoutes(app, {
    service: managedRemoteExecution,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
    ...(uiAuthController?.resolveAuthContext ? { resolveAuthContext: uiAuthController.resolveAuthContext } : {}),
  });
  const promptToolCatalog = createPromptToolCatalog({ runtime: agentRuntime, extensions: extensionRuntime, mcp: mcpAuthority, mcpScope: resolveMcpSettingsScope });
  registerAgentPersonalizationRoutes(app, agentPersonalization, uiAuthController?.requireAuth ?? ((_req, _res, next) => next()), resourceManagement.prompt, resourceManagement.toolCatalog);
  registerThreadMemoryRoutes(app, createThreadMemory({ history: botHistory, memory: memoryService,
    narrate: (scopeId, system, prompt, signal, selection) => memoryOrganizer.extractSelection(scopeId, system, prompt, signal, selection) }),
    uiAuthController?.requireAuth ?? ((_request, _response, next) => next()));
  registerWebSearchCredentialRoutes(app, {
    readAuth: serviceCredentials.read, saveAuth: serviceCredentials.save, removeAuth: serviceCredentials.remove,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });

  async function getKnowledgeStoreForScope(scopeId: string): Promise<KnowledgeStore> {
    // HR0: scope ids are either project workspace ids or `session:<id>`; only
    // the persisted store key differs — records keep their real scope. BC0
    // adds `bot:<id>` scopes that resolve to the Bot's own memory store.
    const scope = isBotScopeId(scopeId) ? 'bot' as const
      : isThreadScopeId(scopeId) ? 'session' as const
        : 'workspace' as const;
    const assertMemoryOwner = async () => {
      if (isThreadScopeId(scopeId)) { if (!(await agentRuntime.thread(threadIdFromScopeId(scopeId))).bot_id) throw new Error('Thread memory has no Bot owner'); return; }
      if (scope !== 'bot') return;
      const bot = await botService.get(botIdFromScopeId(scopeId));
      if (!bot) throw new Error('Bot memory owner is unavailable');
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

    }).then(async (store) => {
      try { await assertMemoryOwner(); }
      catch (error) { await store.close(); throw error; }
      knowledgeStores.set(storeKey, store);
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

  const knowledgeStoreExistsForScope = (scopeId: string): Promise<boolean> => (
    fsPromises.access(path.join(VARIN_DATA_DIR, 'knowledge', hostId, `${knowledgeStoreKeyForScope(scopeId)}.tdb`))
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })
  );

  const contextObservationPublication = createContextObservationPublication(kernelClient, {
    onUnavailable: (error, owner) => console.error('[ContextObservations] Workspace notifications unavailable; conversation continues:',
      { workspaceId: error.workspaceId, runId: owner.runId, reason: error.reason }),
  });
  const knowledgeContextRuntime = createKnowledgeContextRuntime({
    threadSources: () => contextObservationPublication.sources(),
    onObservation: owner => contextObservationPublication.publishSource(knowledgeContextRuntime, owner),
    recallContextForThread: botRecallContext,
    goalForThread: async threadId => {
      const goals = await agentRuntime.goals(threadId);
      return goals.findLast(goal => goal.control === 'active')?.objective;
    },
    getThreadStore: async threadId => await knowledgeStoreExistsForScope(threadScopeId(threadId)) ? getKnowledgeStoreForScope(threadScopeId(threadId)) : null,
    recallForThread: async ({ workspaceId, store, threadId, query, associated, goal, signal }) => {
      const sources: MemoryRecallSource[] = [{ authority: store, scope: 'bot', scopeId: workspaceId }];
      if (await knowledgeStoreExistsForScope(threadScopeId(threadId))) sources.push({ authority: await getKnowledgeStoreForScope(threadScopeId(threadId)), scope: 'session', scopeId: threadScopeId(threadId) });
      const user = await getUserKnowledgeStore();
      if (user) sources.push({ authority: user, scope: 'user', scopeId: 'user' });
      const { results } = await recallMemories({ sources, query, k: 5, workspaceId, judgeWorkspaceId: workspaceId,
        associated: associated ?? {}, ...(knowledgeVectors ? { vectors: knowledgeVectors } : {}),
        ...(goal ? { goal } : {}), ...(signal ? { signal } : {}),
 });
      return results;
    },
    getStore: getKnowledgeStoreForScope,
    getUserStore: getUserKnowledgeStore,
    onError: (error) => console.error('[HarnessKnowledge] Observer failed:', errorMessage(error)),
  });
  contextService.bindObservations((run, signal) => contextObservationPublication.publish(knowledgeContextRuntime, run, signal));
  // Replay original persisted observations after Host restart; Catalog receipts dedupe them.
  void contextObservationPublication.recover(knowledgeContextRuntime).catch(error => {
    console.error('[ContextObservations] Original workspace observations await recovery:', errorMessage(error));
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
  const syntaxStructure = createTreeSitterStructureProvider({
      compute: kernelCompute,
      onLanguageRequest: (languageId, workspaceId) => languageSupportRuntime.noteRequest(languageId, workspaceId),
      resolveInstalled: (fileName) => grammarStore.pathForGrammarFile(fileName),
      resolveInstalledLanguage: (languageId) => languageSupportRuntime.installedStructureSpec(languageId),
    });
  const structureSource = createStructureSource([syntaxStructure]);
  const embeddingRequestSettings = createEmbeddingRequestSettings(VARIN_DATA_DIR);
  const embeddingRequestLoad = await embeddingRequestSettings.load().catch((error: unknown) => ({
    config: DEFAULT_EMBEDDING_REQUEST_CONFIGURATION, error: errorMessage(error),
  }));
  if (embeddingRequestLoad.error) console.error('[HarnessKnowledge] Embedding request settings need repair:', embeddingRequestLoad.error);
  const semanticScheduler = createEmbedScheduler({
    concurrency: embeddingRequestLoad.config.concurrentRequests,
    backgroundIntervalMs: embeddingRequestLoad.config.requestIntervalMs,
  });
  const semanticVectorCache = createVectorCache();
  const semanticInference = createSemanticInference(modelsService, {
    readGlobalSettings: () => modelsService.readGlobalInferenceSettings(),
  }, { ledger: createSemanticInferenceLedger({ dataDir: VARIN_DATA_DIR, hostId }),
    requests: { kernel: kernelClient, runtime: agentRuntime, egress: egressRuntime,
      onError: () => console.error('[Inference] Original inference receipt requires attention') } });
  const memoryInference = createMemoryInference({ kernel: kernelClient, runtime: agentRuntime, models: modelAuthority,
    authority: modelsService, decision: semanticInference, canExecuteScope: canExecuteBotScope,
    validateScope: async scopeId => {
      if (!isBotScopeId(scopeId)) throw new Error('Only a registered Bot owns memory inference');
      const bot = await botService.get(botIdFromScopeId(scopeId));
      if (!bot || bot.archived) throw new Error('The original Bot memory owner is unavailable');
    },
  });
  imageRuntimeOwner.current = createImageRuntime({ authority: modelsService, requests: semanticInference.requests!,
    egress: egressRuntime, media: mediaResources, documents: documentSources, runtime: agentRuntime,
    settings: async source => {
      const root = source?.resource_owner.kind === 'local' ? (await documentsAuthority.admitWorkspaceRegistration(source.workspace_id)).canonicalPath : undefined;
      return modelsService.settings.snapshot(root);
    } });
  app.get('/api/images/models', uiAuthController?.requireAuth ?? ((_request, _response, next) => next()), async (_request, response) => {
    try { response.json({ models: await imageRuntimeOwner.current!.models() }); }
    catch { response.status(503).json({ error: 'Image model catalog is unavailable' }); }
  });
  let localKnowledgeEmbedder: ReturnType<typeof createLocalSemanticEmbedder> | undefined;
  const localKnowledgeComponent = createLocalSemanticComponentManager({
    dataDir: VARIN_DATA_DIR, version: VARIN_VERSION,
    onEnabled: async () => {
      const previous = localKnowledgeEmbedder;
      localKnowledgeEmbedder = undefined;
      knowledgeVectors?.refreshAll();
      if (previous) {
        await Promise.all([knowledgeEmbedding.retireLocal(previous), previous.retire!()]);
      }
    },
  });
  registerLocalSemanticComponentRoutes(app, { manager: localKnowledgeComponent, requireAuth: uiAuthController.requireAuth });
  const knowledgeEmbedding = createKnowledgeEmbeddingOwner(kernelClient, semanticInference, {
    resolve: () => localKnowledgeEmbedder ??= createLocalSemanticEmbedder({ dataDir: VARIN_DATA_DIR,
      cpu: { mode: embeddingRequestSettings.active().localCpuMode ?? 'auto', maxThreads: embeddingRequestSettings.active().localCpuThreads ?? null } }),
    close: async () => {
      await localKnowledgeEmbedder?.retire?.();
    },
  });
  const unsubscribeKnowledgeEmbedding = settingsRuntime.subscribe(() => knowledgeVectors?.refreshAll());
  registerEmbeddingRequestRoutes(app, embeddingRequestSettings, uiAuthController.requireAuth);
  const storageService = createStorageService({
    hostId, name: os.hostname(), dataDirectory: VARIN_DATA_DIR,
    speechModelsDirectory: path.join(VARIN_USER_CONFIG_ROOT, 'speech-models'),
    workspaces: () => documentsAuthority.listWorkspaceRegistrations(),
    kernel: kernelClient,
    devices: async () => {
      const statuses = await connections.statusesWithDefaults();
      return readHostConnections(connections.settingsStore).hosts.map(host => {
        const status = statuses.find(item => item.id === host.id);
        return { id: `connection:${host.id}`, name: host.label || host.id, current: false,
          state: status && status.phase !== 'ready' ? 'offline' as const : 'unsupported' as const,
          ...(status?.detail ? { detail: status.detail } : {}) };
      });
    },
  });
  registerStorageRoutes(app, storageService, uiAuthController.requireAuth, createStorageCoordinator(storageService, managedRemoteTargets));
  knowledgeVectors = createKnowledgeVectorRuntime({
    dataDir: VARIN_DATA_DIR,
    hostId,
    scheduler: semanticScheduler,
    cache: semanticVectorCache,
    resolveEmbedder: knowledgeEmbedding.resolve,
  });
  const observeKnowledgeGitStatus = createGitStatusObserver({
    resolveWorkspaceId: (scope) => documentsAuthority.resolveScopeId(scope),
    observe: (event) => knowledgeContextRuntime.observeGitStatus(event),
    onError: (error) => console.error('[HarnessKnowledge] Git status observer failed:', errorMessage(error)),
  });
  observeKnowledgeDocumentMutation = (event) => {
    languageSupervisor.observeDocumentMutation(event);
    knowledgeContextRuntime.observeDocumentMutation(event);
  };
  const knowledgeLanguageSubscriptions = new Map<string, { close(): void }>();

  const terminalCommandProjector = createTerminalCommandProjector({
    resolveWorkspaceId: (cwd) => documentsAuthority.resolveScopeId(cwd),
    observe: createTerminalCommandObserveAdapter(knowledgeContextRuntime),
    drain: () => knowledgeContextRuntime.drain(),
    listBoundOwners: (workspaceId) => knowledgeContextRuntime.listBoundOwners(workspaceId),
    inspectCwd: (terminalId) => terminalRuntime?.inspectSession(terminalId)?.cwd,
    onError: (error) => {
      console.error('[HarnessKnowledge] Terminal command projection failed:', errorMessage(error));
    },
  });

  const unregisterMaterialToolCapability = extensionRuntime.capabilities.register(MATERIAL_SNAPSHOT_CAPABILITY, webRuntimeOwner.current.snapshotCapability);
  const unregisterImagesCapability = extensionRuntime.capabilities.register(IMAGES_CAPABILITY, imageRuntimeOwner.current.capability);
  const unregisterResearchDiscoveryCapability = extensionRuntime.capabilities.register(RESEARCH_DISCOVERY_CAPABILITY, researchDiscoveryOwner.current.capability);
  const unregisterInteractiveUiCapability = extensionRuntime.capabilities.register(INTERACTIVE_UI_CAPABILITY, interactiveUi.capability);
  const unregisterWebCapability = extensionRuntime.capabilities.register(WEB_CAPABILITY, webRuntimeOwner.current.capability);
  const unregisterOfficeCapability = extensionRuntime.capabilities.register(OFFICE_CAPABILITY, officeRuntimeOwner.current.capability);
  const unregisterBrowserCapability = extensionRuntime.capabilities.register(BROWSER_CAPABILITY, browserRuntimeOwner.current.capability);
  const unregisterExtensionPackageCapability = extensionRuntime.capabilities.register(
    VARIN_EXTENSION_PACKAGES_CAPABILITY, createExtensionPackageOwner({ extensions: extensionRuntime, kernel: kernelClient,
      runtime: agentRuntime, storage: kernelStorageAdapter, resolveLiveSource: liveSources.validate,
      onCleanupError: (operationId, error) => console.error("[Varin Extensions] Package source cleanup failed", operationId, errorMessage(error)) }),
  );
  const unregisterRuntimeContractCapability = extensionRuntime.capabilities.register(
    VARIN_RUNTIME_CONTRACTS_CAPABILITY, createRuntimeContractOwner({ extensions: extensionRuntime, kernel: kernelClient }),
  );
  const unregisterNestedToolCapability = extensionRuntime.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner(kernelClient));
  const unregisterScriptCapability = extensionRuntime.capabilities.register(SCRIPT_CAPABILITY, scriptRuntimeOwner.current.capability);
  const unregisterComputerCapability = extensionRuntime.capabilities.register(COMPUTER_CAPABILITY, computerRuntimeOwner.current.capability);
  const unregisterSettingsCapability = extensionRuntime.capabilities.register(SETTINGS_CAPABILITY, createSettingsToolOwner({ service: settingsService, runtime: agentRuntime,
    localWorkspace: authority => authority.source?.resource_owner.kind === 'local' && authority.source.mode === 'live_root' ? authority.source.workspace_id : null,
  }));
  const environmentForwards = createEnvironmentForwardRuntime();
  const environmentForwardJobs = createEnvironmentForwardJobRuntime({ kernel: kernelClient, runtime: agentRuntime,
    forwards: environmentForwards, targets: managedRemoteTargets,
    onError: () => console.error('[Environment] Original service forward requires reconciliation') });
  const unregisterEnvironmentForwardCapability = extensionRuntime.capabilities.register(ENVIRONMENT_FORWARD_CAPABILITY, environmentForwardJobs.capability);
  environmentForwardJobs.start();
  const unregisterResearchCapability = extensionRuntime.capabilities.register(RESEARCH_CAPABILITY, researchRuntime.capability);
  researchRuntime.start();
  mcpInteractionRuntime.start();
  managedMcpInteractions.start();
  mcpTaskRuntime.start();
  mcpResourceRuntime.start();
  const unregisterScheduleCapability = extensionRuntime.capabilities.register(SCHEDULE_CAPABILITY,
    createScheduleToolOwner({ service: scheduledTaskService,
      workspaceRoot: async workspaceId => (await documentsAuthority.admitWorkspaceRegistration(workspaceId)).canonicalPath,
      manageManaged: createManagedScheduleOwner({ coordinatorHostId: () => agentRuntime.coordinatorHostId,
        withRunAuthority: (runId, source, consume, signal) => agentRuntime.withManagedSourceAuthority(runId, source, consume, signal) }) }));
  const unregisterChildIntegrationCapability = extensionRuntime.capabilities.register(CHILD_INTEGRATION_CAPABILITY,
    createIntegrationToolOwner({ runtime: agentRuntime, coordinator: threadIntegrationCoordinator,
      onCleanupError: (_operationId, _error) => console.error('[Integration] Source grant cleanup requires attention'),
      mergeManaged: createManagedIntegrationOwner({ kernel: kernelClient, runtime: agentRuntime,
        resolveLiveSource: liveSources.validate,
        onCleanupError: (_operationId, _error) => console.error('[Integration] Managed source cleanup requires attention') }),
      openTarget: createIntegrationTargetOpener({ kernel: kernelClient, runtime: agentRuntime, storage: kernelStorageAdapter,
        recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore, resolveLiveSource: liveSources.validate,
        documents: documentsAuthority }) }));
  const unregisterCodeExchangeCapability = extensionRuntime.capabilities.register(CODE_EXCHANGE_CAPABILITY,
    createCodeExchangeOwner({ kernel: kernelClient, runtime: agentRuntime, storage: kernelStorageAdapter,
      coordinator: threadIntegrationCoordinator, recovery: foundationalRecoveryEngine, metadataReader: kernelRecoveryStore,
      resolveLiveSource: liveSources.validate, documents: documentsAuthority,
      onCleanupError: () => console.error('[CodeExchange] Original delivery or source cleanup requires retry') }));
  const unregisterDocumentsCapability = extensionRuntime.capabilities.register(
    'workspace.documents',
    createDocumentsCapabilityHandler(documentsAuthority),
  );
  const unregisterWorkspaceRecoveryCapability = extensionRuntime.capabilities.register(
    'workspace.recovery-primitives',
    createWorkspaceRecoveryCapabilityHandler(recoveryEngineForOwner, fileRecoveryService),
  );
  const unregisterSearchCapability = extensionRuntime.capabilities.register(
    'workspace.search',
    createWorkspaceSearchCapabilityHandler(workspaceContentSearch),
  );
  const unregisterLanguageCapability = extensionRuntime.capabilities.register(
    'workspace.language',
    createLanguageCapabilityHandler(languageSupervisor),
    { cleanupMethods: ['unregisterProvider'] },
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
    { cleanupMethods: ['unregisterAdapter'] },
  );
  const unregisterTestCapability = extensionRuntime.capabilities.register(
    'workspace.test',
    createWorkspaceTestCapabilityHandler(runRuntime.tests),
    { cleanupMethods: ['unregisterProvider'] },
  );
  await extensionRuntime.start().catch((error) => {
    console.warn('[Varin Extensions] Host reconciliation failed:', error?.message || error);
  });
  const unregisterWorkbenchLayoutService = await registerBuiltinWorkbenchLayoutService(extensionRuntime);
  botLifecycleRuntime = createBotLifecycleRuntime({
    hostId, computers: computerService,
    agent: { runtime: agentRuntime, kernel: kernelClient, gate: botId => botService.executionGate(botId),
      continueLaunch: runId => threads.continueLaunch(runId), drainScripts: runIds => scriptRuntimeOwner.current!.drainRuns(runIds),
      drainForwards: runIds => environmentForwardJobs.drainRuns(runIds),
      drainCollaborations: threadIds => collaboration.suspendThreads(threadIds) },
    stopMemory: (scopeId) => memoryOrganizer.suspendScope(scopeId),
    resumeMemory: (scopeId) => memoryOrganizer.resumeScope(scopeId),
    stopRemoteScope: (scopeId) => managedRemoteTargets.setScopeSleeping(scopeId, true),
    resumeRemoteScope: (scopeId) => managedRemoteTargets.setScopeSleeping(scopeId, false),
    remoteMachineOwners: (hostId) => managedRemoteTargets.ownersForMachine(`managed:${hostId}`),
  });
  // Recovery can open stores and inference consumers, so start only after
  // their owners and catalog observers have been assembled.
  memoryOrganizer.start();

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
    renderOffice: (bytes, format, signal) => officeRenderer.convert(bytes, format, 'pdf', signal),
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
    modelText,
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
    getVarinEventClients: () => uiVarinEventClients,
    writeSseEvent,
    surfaceBridge: clientSurfaceBridge,
    resolveAuthContext: uiAuthController.resolveAuthContext,
    resolveSurfaceThread: identity => isNativeThreadLive(identity),
    extensionCatalog,
    extensionPackages,
    extensionRuntime,
    ...(options.restartApplicationHost ? { restartApplicationHost: options.restartApplicationHost } : {}),
    uiAuthController,
    documents: documentsAuthority,
    fileResources: kernelFileResources,
    onGitStatus: observeKnowledgeGitStatus,
    languageSupervisor,
    languageSupport: languageSupportRuntime,
    runRuntime,

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
    listRecentThreads: () => agentRuntime.threadCatalog({ archived: 'exclude' }),
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

  let stopTask: Promise<void> | undefined;
  const controller: WebUiServerController = {
    expressApp: app,
    connections,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: async () => ({
      tunnel: { active: Boolean(tunnelService.getPublicUrl()) },
      scheduledTasks: await scheduledTasksRuntime.getStatus(),
    }),
    isReady: () => kernelClient.isReady,
    stop: (shutdownOptions: { exitProcess?: boolean | undefined } = {}) => stopTask ??= (async () => {
      const shutdown = createShutdownCollector();
      await shutdown.run('observations.stop', () => observations.stop());
      await shutdown.run('unsubscribeTokenizerKernel', () => unsubscribeTokenizerKernel());
      await shutdown.run('stopTokenizerCollection?.', () => stopTokenizerCollection?.());
      // Stop timer/watcher producers before their runtime and storage
      // dependencies begin shutting down.
      await shutdown.run('unsubscribeProjectTrust', () => unsubscribeProjectTrust());
      await shutdown.run('managedMcpOwner.current?.close', () => managedMcpOwner.current?.close());
      await shutdown.run('targetMcpService.close', () => targetMcpService.close());
      await shutdown.run('targetScheduleReceipts.dispose', () => targetScheduleReceipts.dispose());
      await shutdown.run('scriptRuntimeOwner.current?.dispose', () => scriptRuntimeOwner.current?.dispose());
      await shutdown.run('environmentForwardJobs.dispose', () => environmentForwardJobs.dispose());
      await shutdown.run('environmentForwards.dispose', () => environmentForwards.dispose());
      await shutdown.run('computerRuntimeOwner.current?.stop', () => computerRuntimeOwner.current?.stop());
      await shutdown.run('threadNotifications.dispose', () => threadNotifications.dispose());
      await shutdown.run('contentMaintenance.dispose', () => {removeWorkspaceIdleMaintenance();return contentMaintenance.dispose();});
      await shutdown.run('runObservers.stop', () => runObservers.stop());
      await shutdown.run('collaboration.stop', () => collaboration.stop());
      await shutdown.run('fileObservations.stop', () => fileObservations.stop());
      await shutdown.run('scheduledTasksRuntime.stop', () => scheduledTasksRuntime.stop());
      await shutdown.run('botService.dispose', () => botService.dispose());
      await shutdown.run('unregisterRuntimeContractCapability', () => unregisterRuntimeContractCapability());
      await shutdown.run('unregisterExtensionPackageCapability', () => unregisterExtensionPackageCapability());
      await shutdown.run('unregisterNestedToolCapability', () => unregisterNestedToolCapability());
      await shutdown.run('unregisterComputerCapability', () => unregisterComputerCapability());
      await shutdown.run('unregisterSettingsCapability', () => unregisterSettingsCapability());
      await shutdown.run('unregisterEnvironmentForwardCapability', () => unregisterEnvironmentForwardCapability());
      await shutdown.run('unregisterScriptCapability', () => unregisterScriptCapability());
      await shutdown.run('unregisterResearchCapability', () => unregisterResearchCapability());
      await shutdown.run('researchRuntime.dispose', () => researchRuntime.dispose());
      await shutdown.run('userIntegrations.dispose', () => userIntegrations.dispose());
      await shutdown.run('managedMcpInteractions.dispose', () => managedMcpInteractions.dispose());
      await shutdown.run('mcpInteractionRuntime.dispose', () => mcpInteractionRuntime.dispose());
      await shutdown.run('mcpResourceRuntime.dispose', () => mcpResourceRuntime.dispose());
      await shutdown.run('mcpTaskRuntime.dispose', () => mcpTaskRuntime.dispose());
      await shutdown.run('resourceService.dispose', () => resourceService.dispose());
      await shutdown.run('experimentService.detachObservers', () => experimentService.detachObservers());
      await shutdown.run('unregisterWorkbenchLayoutService', () => unregisterWorkbenchLayoutService());
      if (ownsExtensionRuntime) await shutdown.run('extensionRuntime.stop', () => extensionRuntime.stop());
      await shutdown.run('unregisterMaterialToolCapability', () => unregisterMaterialToolCapability());
      await shutdown.run('unregisterWebCapability', () => unregisterWebCapability());
      await shutdown.run('unregisterOfficeCapability', () => unregisterOfficeCapability());
      await shutdown.run('unregisterBrowserCapability', () => unregisterBrowserCapability());
      await shutdown.run('unregisterImagesCapability', () => unregisterImagesCapability());
      await shutdown.run('unregisterResearchDiscoveryCapability', () => unregisterResearchDiscoveryCapability());
      await shutdown.run('unregisterInteractiveUiCapability', () => unregisterInteractiveUiCapability());
      await shutdown.run('interactiveUi.close', () => interactiveUi.close());
      await shutdown.run('unregisterChildIntegrationCapability', () => unregisterChildIntegrationCapability());
      await shutdown.run('unregisterCodeExchangeCapability', () => unregisterCodeExchangeCapability());
      await shutdown.run('unregisterScheduleCapability', () => unregisterScheduleCapability());
      await shutdown.run('unregisterDocumentsCapability', () => unregisterDocumentsCapability());
      await shutdown.run('unregisterWorkspaceRecoveryCapability', () => unregisterWorkspaceRecoveryCapability());
      await shutdown.run('unregisterSearchCapability', () => unregisterSearchCapability());
      await shutdown.run('unregisterLanguageCapability', () => unregisterLanguageCapability());
      await shutdown.run('unregisterTasksCapability', () => unregisterTasksCapability());
      await shutdown.run('unregisterDebugCapability', () => unregisterDebugCapability());
      await shutdown.run('unregisterTestCapability', () => unregisterTestCapability());
      await shutdown.run('terminalCommandSubscription.dispose', () => terminalCommandSubscription.dispose());
      for (const subscription of knowledgeLanguageSubscriptions.values()) await shutdown.run('knowledgeLanguageSubscription.close', () => subscription.close());
      await shutdown.run('knowledgeLanguageSubscriptions.clear', () => knowledgeLanguageSubscriptions.clear());
      // Semantic and graph observers still read Documents and use the kernel
      // services. Stop them while those owners are alive; otherwise each late
      // document event can race a disposed mutation authority during shutdown.
      observeKnowledgeDocumentMutation = () => undefined;
      // The organizer is a semantic-inference consumer; fence it before closing that owner.
      const inferenceShutdownErrors: unknown[] = [];
      await shutdown.run('memoryOrganizer.dispose', () => memoryOrganizer.dispose().catch((error: unknown) => { inferenceShutdownErrors.push(error); }));
      unsubscribeNextStepSettings();
      await shutdown.run('nextSteps.close', () => nextSteps.close());
      for (const result of await Promise.allSettled([threadTitles.close(), modelText.close()])) {
        if (result.status === 'rejected') inferenceShutdownErrors.push(result.reason);
      }
      unsubscribeKnowledgeEmbedding();
      await shutdown.run('localKnowledgeComponent.dispose', () => localKnowledgeComponent.dispose());
      await shutdown.run('knowledgeEmbedding.close', () => knowledgeEmbedding.close());
      await shutdown.run('semanticInference.close', () => semanticInference.close().catch((error: unknown) => { inferenceShutdownErrors.push(error); }));
      // Stop producers and drain their receipts while process grants are valid.
      // One refused exit must not prevent the other domains from shutting down.
      const processShutdown = await Promise.allSettled([
        terminalRuntime?.shutdown(), targetSourceQuery.dispose(), languageSupervisor.dispose(), managedLanguageServers.dispose(), runRuntime.dispose(),
        // Release every supervised native driver so no synthesized input is
        // left held down when the Host exits.
        computerService.dispose(),
        connections.shutdownAll(),
      ]);
      const processShutdownErrors = [...inferenceShutdownErrors, ...processShutdown.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])];
      await shutdown.run('mcpSettings.close', () => mcpSettings.close());
      await shutdown.run('mcpCompositions.close', () => mcpCompositions.close());
      await shutdown.run('mcpAuthority.close', () => mcpAuthority.close());
      await shutdown.run('globalMcpProcesses.dispose', () => globalMcpProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); }));
      await shutdown.run('languageToolProcesses.dispose', () => languageToolProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); }));
      await shutdown.run('documentProcesses.dispose', () => documentProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); }));
      await shutdown.run('kernelProcesses.dispose', () => kernelProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); }));
      await shutdown.run('externalAgents.close', () => externalAgents.close().catch((error: unknown) => { processShutdownErrors.push(error); }));
      await shutdown.run('externalAgentProcesses.dispose', () => externalAgentProcesses.dispose().catch((error: unknown) => { processShutdownErrors.push(error); }));
      for (const error of processShutdownErrors) console.error('[VarinKernel] Native process shutdown incomplete:', errorMessage(error));
      await shutdown.run('unsubscribeModelSettings', () => unsubscribeModelSettings());
      await shutdown.run('unsubscribeModels', () => unsubscribeModels());
      await shutdown.run('stopModelDirectory', () => stopModelDirectory());
      await shutdown.run('modelsService.authorizations.close', () => modelsService.authorizations.close());
      await shutdown.run('unsubscribeModelKernel', () => unsubscribeModelKernel());
      await shutdown.run('modelExtensions.close', () => modelExtensions.close());
      await shutdown.run('documentsAuthority.dispose', () => documentsAuthority.dispose());
      await shutdown.run('Promise.allSettled', () => Promise.allSettled([...workspaceRecoveryEngines.values()].map((engine) => engine.dispose())));
      await shutdown.run('workspaceRecoveryEngines.clear', () => workspaceRecoveryEngines.clear());
      await shutdown.run('kernelCompute.dispose', () => kernelCompute.dispose());
      await shutdown.run('kernelStorageAdapter.dispose', () => kernelStorageAdapter.dispose().catch((error) => console.error('[VarinKernel] Failed to revoke storage grants:', errorMessage(error))));
      await shutdown.run('kernelClient?.close', () => kernelClient?.close());
      await shutdown.run('knowledgeVectors?.close', () => knowledgeVectors?.close());
      await shutdown.run('knowledgeContextRuntime.dispose', () => knowledgeContextRuntime.dispose());
      await shutdown.run('Promise.allSettled', () => Promise.allSettled([...knowledgeStoreLoads.values()]));
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
      try {
        await egressRuntime.close();
      } catch (error) {
        processShutdownErrors.push(error);
        console.error('[HarnessEgress] Shutdown incomplete:', errorMessage(error));
      }
      await shutdown.run('realtimeProxyRuntime.stop', () => realtimeProxyRuntime.stop());
      await shutdown.run('connectionProxy.stop', () => connectionProxy.stop());
      await shutdown.run('desktopMedia.stop', () => desktopMedia.stop());
      await shutdown.run('serviceForward.stop', () => serviceForward.stop());
      await shutdown.run('clearInterval', () => clearInterval(relayReconcileTimer));
      await shutdown.run('relayService.stop', () => relayService.stop());
      await shutdown.run('dictationRuntime?.stop?.', () => dictationRuntime?.stop?.());
      const stopped = await gracefulShutdownRuntime.gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false });
      processShutdownErrors.push(...shutdown.errors);
      if (processShutdownErrors.length) throw new AggregateError(processShutdownErrors, 'Native process shutdown requires attention');
      return stopped;
    })(),
  };
  stopHostResources = controller.stop;
  return controller;
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
