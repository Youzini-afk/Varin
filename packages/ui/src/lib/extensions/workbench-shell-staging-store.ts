import type { SurfaceContribution } from '@varin/extension-surface';
import { retryWorkbenchShellLoad } from './shell-component-registry';

export interface WorkbenchShellRenderStagingHandle {
  dispose(): Promise<void>;
  promote(): Promise<void>;
}

export interface WorkbenchShellStagingRequest {
  contribution: SurfaceContribution;
  id: number;
  props: Readonly<Record<string, unknown>>;
  profileId?: string;
  reject(error: unknown): void;
  resolve(): void;
  settled: boolean;
  promoted?: boolean;
  resolvePromotion?(): void;
  rejectPromotion?(error: unknown): void;
}

let requestSequence = 0;
let activeRequest: WorkbenchShellStagingRequest | null = null;
let stagingHostCount = 0;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeWorkbenchShellStaging = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getWorkbenchShellStagingRequest = (): WorkbenchShellStagingRequest | null => activeRequest;

export const settleWorkbenchShellStagingReady = (request: WorkbenchShellStagingRequest): void => {
  if (activeRequest !== request || request.settled) return;
  request.settled = true;
  request.resolve();
};

export const settleWorkbenchShellStagingFailure = (
  request: WorkbenchShellStagingRequest,
  error: unknown,
): void => {
  if (activeRequest !== request) return;
  if (!request.settled) { request.settled = true; request.reject(error); }
  request.rejectPromotion?.(error);
  activeRequest = null;
  publish();
};

/** Called only by the selected, authoritative slot after its prepared subtree is committed. */
export const settleWorkbenchShellPromotion = (request: WorkbenchShellStagingRequest): void => {
  if (activeRequest !== request) return;
  request.promoted = true;
  request.resolvePromotion?.();
};

export const stageWorkbenchShellRender = (
  contribution: SurfaceContribution,
  props: Readonly<Record<string, unknown>>,
  profileId?: string,
): Promise<WorkbenchShellRenderStagingHandle> => {
  if (stagingHostCount === 0) {
    return Promise.reject(new Error('Workbench shell staging host is unavailable'));
  }
  if (activeRequest) {
    settleWorkbenchShellStagingFailure(activeRequest, new Error('Workbench shell staging was superseded'));
  }
  const id = ++requestSequence;
  retryWorkbenchShellLoad(contribution.owner.extensionId);
  return new Promise<void>((resolve, reject) => {
    activeRequest = {
      contribution,
      id,
      props,
      profileId,
      reject,
      resolve,
      settled: false,
    };
    publish();
  }).then(() => ({
    promote: () => {
      if (activeRequest?.id !== id) return Promise.reject(new Error('Workbench shell staging was superseded'));
      if (activeRequest.promoted) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        activeRequest!.resolvePromotion = resolve;
        activeRequest!.rejectPromotion = reject;
      });
    },
    dispose: async () => {
      if (activeRequest?.id !== id) return;
      activeRequest.rejectPromotion?.(new Error('Workbench shell candidate released'));
      activeRequest = null;
      publish();
    },
  }));
};

export const mountWorkbenchShellStagingHost = (): (() => void) => {
  stagingHostCount += 1;
  return () => {
    stagingHostCount -= 1;
    if (stagingHostCount === 0 && activeRequest) {
      settleWorkbenchShellStagingFailure(activeRequest, new Error('Workbench shell staging host was removed'));
    }
  };
};
