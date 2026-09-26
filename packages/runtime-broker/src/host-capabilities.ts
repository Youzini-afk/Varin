import type { HostHandshakeParams } from '@varin/protocol';

/** Capabilities of the shared Application Host, independent of its Web or Electron shell. */
export function applicationHostClientCapabilities(options: {
  documentRead: boolean;
  documentPathOverlay: boolean;
  workContext: boolean;
  webRead: boolean;
  webSearch: boolean;
}): NonNullable<HostHandshakeParams['capabilities']> {
  return {
    harnessDocumentRead: options.documentRead,
    harnessDocumentPathOverlay: options.documentPathOverlay,
    harnessWorkContext: options.workContext,
    harnessExperiments: true,
    harnessSettings: true,
    harnessFollowUps: true,
    harnessScheduledTasks: true,
    harnessLspNavigation: true,
    harnessMaterials: true,
    harnessThreads: true,
    harnessWebRead: options.webRead,
    harnessWebSearch: options.webSearch,
    workspaceMutationJournal: true,
  };
}
