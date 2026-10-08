import { createNativeThreadsHttpAPI } from '@varin/application-client';
import type { RuntimeAPIs } from '@varin/application-client';
import {
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
  type RuntimeUrlResolver,
} from '@varin/application-client';
import { useDirectoryStore } from '@varin/ui/stores/useDirectoryStore';
import { createWebTerminalAPI } from './terminal';
import { createWebGitAPI } from './git';
import { createWebFilesAPI } from './files';
import { createWebSettingsAPI } from './settings';
import { createWebPermissionsAPI } from './permissions';
import { createWebNotificationsAPI } from './notifications';
import { createWebToolsAPI } from './tools';
import { createWebPushAPI } from './push';
import { createWebGitHubAPI } from './github';
import { createWebWorkspaceAPI } from './workspace';
import { createWebMobileAPI } from './mobile';
import { createWebSmartSearchAPI } from './smart-search';
import { createWebClientAuthAPI } from './clientAuth';
import { createWebExtensionsAPI } from './extensions';
import { createWebPiRuntimeAPI } from './piRuntime';
import { createWebDocumentsAPI } from './documents';
import { createWebWorkspaceSearchAPI } from './workspace-search';
import { createWebLanguageServicesAPI } from './language';
import { createWebLanguageSupportAPI } from './language-support';
import { createWebWorkspaceTasksAPI } from './tasks';
import { createWebWorkspaceDebugAPI } from './debug';
import { createWebWorkspaceTestAPI } from './tests';

export interface WebAPIsOptions {
  urls?: RuntimeUrlResolver;
}

const createActiveRuntimeUrlResolver = (): RuntimeUrlResolver => ({
  api: (...args) => getRuntimeUrlResolver().api(...args),
  authenticatedAsset: (...args) => getRuntimeUrlResolver().authenticatedAsset(...args),
  auth: (...args) => getRuntimeUrlResolver().auth(...args),
  health: (...args) => getRuntimeUrlResolver().health(...args),
  rawFile: (...args) => getRuntimeUrlResolver().rawFile(...args),
  sse: (...args) => getRuntimeUrlResolver().sse(...args),
  websocket: (...args) => getRuntimeUrlResolver().websocket(...args),
});

export const createWebAPIs = (options: WebAPIsOptions = {}): RuntimeAPIs => {
  const urls = options.urls ?? createRuntimeUrlResolver();
  setRuntimeUrlResolver(urls);
  const activeUrls = createActiveRuntimeUrlResolver();

  return {
    runtime: { platform: 'web', isDesktop: false, label: 'web' },
    piRuntime: createWebPiRuntimeAPI(),
    nativeThreads: createNativeThreadsHttpAPI(),
    terminal: createWebTerminalAPI(),
    git: createWebGitAPI(),
    workspace: createWebWorkspaceAPI(),
    files: createWebFilesAPI({ urls: activeUrls, getDirectory: () => useDirectoryStore.getState().currentDirectory }),
    documents: createWebDocumentsAPI(),
    workspaceSearch: createWebWorkspaceSearchAPI(),
    language: createWebLanguageServicesAPI(),
    languageSupport: createWebLanguageSupportAPI(),
    tasks: createWebWorkspaceTasksAPI(),
    debug: createWebWorkspaceDebugAPI(),
    tests: createWebWorkspaceTestAPI(),
    settings: createWebSettingsAPI(),
    permissions: createWebPermissionsAPI(),
    notifications: createWebNotificationsAPI(),
    github: createWebGitHubAPI({ urls: activeUrls }),
    push: createWebPushAPI(),
    clientAuth: createWebClientAuthAPI(),
    mobile: createWebMobileAPI(),
    smartSearch: createWebSmartSearchAPI(),
    extensions: createWebExtensionsAPI(),
    tools: createWebToolsAPI(),
  };
};
