import type { spawn as spawnFunction } from 'node:child_process';
import type cryptoModule from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type osModule from 'node:os';
import type pathModule from 'node:path';

import type { Express, Response } from 'express';

import type { DocumentAuthority } from '../documents/authority.js';
import { DocumentPathError, DocumentUntrustedError } from '../documents/errors.js';
import { registerExternalAccessRoutes } from '../external-access/routes.js';
import { registerExtensionRoutes } from '../extensions/routes.js';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerVarinEventRoutes, registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerModelTextRoutes } from '../model-text/routes.js';
import type { ModelTextService } from '../model-text/service.js';
import { registerSmartSearchRoutes } from '../smart-search/routes.js';
import { registerWorkspaceRoutes } from '../workspace/workspace-routes.js';
import { registerDocumentRoutes } from '../documents/routes.js';
import { registerWorkspaceSearchRoutes } from '../search/routes.js';
import { registerLanguageRoutes } from '../lsp/routes.js';
import { registerLanguageSupportRoutes } from '../language-support/routes.js';
import { registerRunRoutes } from '../run/routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';

type ExtensionRouteDependencies = Parameters<typeof registerExtensionRoutes>[1];
type ProjectIconDependencies = Parameters<typeof registerProjectIconRoutes>[1];
type ScheduledTaskDependencies = Parameters<typeof registerScheduledTaskRoutes>[1];
type VarinEventDependencies = Parameters<typeof registerVarinEventRoutes>[1];
type FsRouteDependencies = Parameters<typeof registerFsRoutes>[1];
type LanguageRouteDependencies = Parameters<typeof registerLanguageRoutes>[1];
type RunRouteDependencies = Parameters<typeof registerRunRoutes>[1];
type NormalizationRuntime = ReturnType<typeof import('./settings-normalization-runtime.js').createSettingsNormalizationRuntime>;
type SettingsHelpers = ReturnType<typeof import('./settings-helpers.js').createSettingsHelpers>;
type SettingsRuntime = ReturnType<typeof import('./settings-runtime.js').createSettingsRuntime>;
type ProjectDirectoryRuntime = ReturnType<typeof import('./project-directory-runtime.js').createProjectDirectoryRuntime>;
type EnvironmentRuntime = ReturnType<typeof import('./environment-runtime.js').createPlatformEnvironmentRuntime>;
type ProjectConfigRuntime = ReturnType<typeof import('../projects/project-config.js').createProjectConfigRuntime>;
type ScheduledTasksRuntime = ReturnType<typeof import('../scheduled-tasks/runtime.js').createScheduledTasksRuntime>;
type ScheduledTaskService = NonNullable<ScheduledTaskDependencies['scheduledTaskService']>;
type SmartSearchDependencies = Parameters<typeof registerSmartSearchRoutes>[1];
type SmartSearchSpawn = NonNullable<SmartSearchDependencies['spawn']>;

export interface PlatformRouteDependencies {
  modelText: ModelTextService;
  __dirname: string;
  buildAugmentedPath: EnvironmentRuntime['buildAugmentedPath'];
  fileSearch: ProjectIconDependencies['fileSearch'];
  contentSearch: ReturnType<typeof import('../search/content.js').createWorkspaceContentSearch>;
  crypto: typeof cryptoModule;
  documents?: DocumentAuthority;
  fileResources?: FsRouteDependencies['fileResources'];
  extensionCatalog: ExtensionRouteDependencies['extensionCatalog'];
  extensionPackages: ExtensionRouteDependencies['extensionPackages'];
  extensionRuntime: ExtensionRouteDependencies['extensionRuntime'];
  restartApplicationHost?: () => Promise<void>;
  formatSettingsResponse: SettingsHelpers['formatSettingsResponse'];
  fsPromises: typeof fsPromisesModule;
  getVarinEventClients: VarinEventDependencies['getVarinEventClients'];
  surfaceBridge?: VarinEventDependencies['surfaceBridge'];
  resolveSurfaceThread?: VarinEventDependencies['resolveSurfaceThread'];
  resolveAuthContext?: VarinEventDependencies['resolveAuthContext'];
  languageSupervisor?: LanguageRouteDependencies['language'];
  languageSupport?: import('../language-support/runtime.js').LanguageSupportRuntime;
  normalizeDirectoryPath: NormalizationRuntime['normalizeDirectoryPath'];
  onGitStatus?: (scope: string, status: unknown) => void | Promise<void>;
  os: typeof osModule;
  path: typeof pathModule;
  persistSettings: SettingsRuntime['persistSettings'];
  varinDataDir: string;
  varinUserConfigRoot: string;
  varinVersion: string;
  process: NodeJS.Process;
  projectConfigRuntime: ProjectConfigRuntime;
  readCustomThemesFromDisk: () => Promise<unknown>;
  readSettingsFromDisk: SettingsRuntime['readSettingsFromDisk'];
  reloadRuntimeConfiguration?: () => Promise<void>;
  remoteClientAuthRuntime: NonNullable<Parameters<typeof registerExternalAccessRoutes>[1]['remoteClientAuthRuntime']>;
  resolveGitBinaryForSpawn: FsRouteDependencies['resolveGitBinaryForSpawn'];
  resolveProjectDirectory: ProjectDirectoryRuntime['resolveProjectDirectory'];
  runRuntime?: {
    debug: RunRouteDependencies['debug'];
    tasks: RunRouteDependencies['tasks'];
    tests: RunRouteDependencies['tests'];
  };
  runtimeName: string;
  sanitizeProjects: NormalizationRuntime['sanitizeProjects'];
  scheduledTaskService: ScheduledTaskService;
  scheduledTasksRuntime: ScheduledTasksRuntime;
  serverStartedAt: string;
  spawn: typeof spawnFunction;
  uiAuthController: ExtensionRouteDependencies['uiAuthController'];
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
}

export const createPlatformRoutesRuntime = ({
  clientReloadDelayMs,
}: {
  clientReloadDelayMs: number;
}) => {
  const registerRoutes = async (
    app: Express,
    dependencies: PlatformRouteDependencies,
  ): Promise<void> => {
    const {
      crypto,
      os,
      path,
      process,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      fileSearch,
      contentSearch,
      varinDataDir,
      varinUserConfigRoot,
      varinVersion,
      runtimeName,
      serverStartedAt,
      remoteClientAuthRuntime,
      __dirname,
      normalizeDirectoryPath,
      onGitStatus,
      resolveProjectDirectory,
      readCustomThemesFromDisk,
      formatSettingsResponse,
      readSettingsFromDisk,
      persistSettings,
      sanitizeProjects,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      getVarinEventClients,
      writeSseEvent,
      surfaceBridge,
      resolveSurfaceThread,
      resolveAuthContext,
      reloadRuntimeConfiguration = async () => {},
      extensionCatalog,
      extensionPackages,
      extensionRuntime,
      restartApplicationHost,
      uiAuthController,
      documents,
      fileResources,
      languageSupervisor,
      languageSupport,
      runRuntime,
    } = dependencies;

    registerExtensionRoutes(app, {
      extensionCatalog,
      extensionPackages,
      uiAuthController,
      ...(documents ? { documents } : {}),
      readProjects: async () => sanitizeProjects((await readSettingsFromDisk()).projects) ?? [],
      ...(extensionRuntime !== undefined ? { extensionRuntime } : {}),
      ...(restartApplicationHost ? { restartApplicationHost } : {}),
    });

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      reloadRuntimeConfiguration,
      clientReloadDelayMs,
    });

    app.get('/api/config/settings', async (_req, res) => {
      try {
        const settings = await readSettingsFromDisk();
        res.json(formatSettingsResponse(settings));
      } catch (error) {
        console.error('Failed to read Varin settings:', error);
        res.status(500).json({ error: 'Failed to read settings' });
      }
    });

    app.put('/api/config/settings', async (req, res) => {
      try {
        res.json(await persistSettings(req.body ?? {}));
      } catch (error) {
        console.error('Failed to save Varin settings:', error);
        res.status(500).json({ error: 'Failed to save settings' });
      }
    });

    const smartSearchSpawn: SmartSearchSpawn = (command, args, options) => spawn(command, args, options);
    registerSmartSearchRoutes(app, { fsPromises, path, spawn: smartSearchSpawn, env: process.env });
    registerExternalAccessRoutes(app, {
      fsPromises,
      path,
      process,
      spawn,
      buildAugmentedPath,
      varinDataDir,
      varinVersion,
      runtimeName,
      serverStartedAt,
      remoteClientAuthRuntime,
      resolveProjectDirectory,
      __dirname,
      ...(documents ? { documents } : {}),
    });
    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      varinDataDir,
      sanitizeProjects,
      readSettingsFromDisk,
      persistSettings,
      fileSearch,
    });
    registerScheduledTaskRoutes(app, {
      requireAuth: uiAuthController.requireAuth,
      readSettingsFromDisk,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
    });
    registerVarinEventRoutes(app, {
      getVarinEventClients,
      writeSseEvent,
      requireAuth: uiAuthController.requireAuth,
      ...(surfaceBridge ? { surfaceBridge } : {}),
      ...(resolveSurfaceThread ? { resolveSurfaceThread } : {}),
      ...(resolveAuthContext ? { resolveAuthContext } : {}),
    });
    registerModelTextRoutes(app, { service: dependencies.modelText });
    registerGitHubRoutes(app);
    registerGitRoutes(app, { ...(documents ? { documents } : {}), ...(onGitStatus ? { onStatus: onGitStatus } : {}) });
    registerWorkspaceRoutes(app, {
      fsPromises,
      pathModule: path,
      osModule: os,
      env: process.env,
      readSettingsFromDisk,
      persistSettings,
      sanitizeProjects,
      ...(documents ? { documents } : {}),
      ...(onGitStatus ? { onGitStatus } : {}),
    });
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      varinUserConfigRoot,
      ...(documents ? { documents } : {}),
      ...(fileResources ? { fileResources } : {}),
    });
    if (documents) {
      registerDocumentRoutes(app, { documents, uiAuthController });
      registerWorkspaceSearchRoutes(app, {
        contentSearch, fileSearch, uiAuthController, path, os, normalizeDirectoryPath, resolveProjectDirectory,
        authorizeSearchDirectory: async (directory) => {
          try {
            await documents.ensureResourceRoot(directory, 'directory');
            return true;
          } catch (error) {
            if (error instanceof DocumentPathError || error instanceof DocumentUntrustedError) return false;
            throw error;
          }
        },
      });
    }
    if (languageSupervisor) {
      registerLanguageRoutes(app, { language: languageSupervisor, uiAuthController });
    }
    if (languageSupport) {
      registerLanguageSupportRoutes(app, { languageSupport, uiAuthController });
    }
    if (runRuntime) {
      registerRunRoutes(app, {
        tasks: runRuntime.tasks,
        debug: runRuntime.debug,
        tests: runRuntime.tests,
        uiAuthController,
      });
    }
  };

  return { registerRoutes };
};
