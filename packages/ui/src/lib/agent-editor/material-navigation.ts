import { VARIN_WORKBENCH_DEFAULT_PROFILE_ID, VARIN_WORKBENCH_IDE_PROFILE_ID } from '@varin/extension-contract';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { openWorkbenchEditor, patchEditorViewState, peekEditorWorkbench, pinWorkbenchEditor, setActiveWorkbenchEditorView } from '@/lib/workbench/editors/session';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const returnProfiles = new Map<string, string>();
type BrowserPosition = { x: number; y: number };
type BrowserCapture = () => Promise<BrowserPosition | undefined>;
const browserCaptures = new Map<string, Set<BrowserCapture>>();
const browserKey = (directory: string, tabId: string) => JSON.stringify([getRuntimeKey(), normalizeContextPanelDirectoryKey(directory), tabId]);
export function registerBrowserMaterialCapture(directory: string, tabId: string, capture: BrowserCapture): () => void {
  const captureKey = browserKey(directory, tabId);
  const captures = browserCaptures.get(captureKey) ?? new Set<BrowserCapture>();
  captures.add(capture); browserCaptures.set(captureKey, captures);
  return () => { captures.delete(capture); if (!captures.size) browserCaptures.delete(captureKey); };
}
async function captureBrowserPosition(directory: string, tabId?: string): Promise<BrowserPosition | undefined> {
  if (!tabId) return;
  for (const capture of browserCaptures.get(browserKey(directory, tabId)) ?? []) {
    const position = await capture().catch(() => undefined);
    if (position) return position;
  }
}
const key = (workspaceId: string) => JSON.stringify([getRuntimeKey(), workspaceId]);

/** View placement changes; resource, document and editor state remain in their existing owners. */
export async function continueMaterialInIde(input: {
  workspaceId: string; viewId: string; fromProfileId: string;
}): Promise<void> {
  const runtimeKey = getRuntimeKey();
  setActiveWorkbenchEditorView(input.workspaceId, input.viewId);
  returnProfiles.set(key(input.workspaceId), input.fromProfileId);
  await selectActiveWorkbenchProfile(VARIN_WORKBENCH_IDE_PROFILE_ID, undefined, { enableShell: true });
  if (getRuntimeKey() !== runtimeKey) return;
  // Opening this material in IDE is an explicit keep action, not a disposable preview.
  const state = peekEditorWorkbench(input.workspaceId);
  const tab = state ? activeEditorTab(state) : undefined;
  if (tab?.viewId === input.viewId) pinWorkbenchEditor(input.workspaceId, tab.tabId);
}

export async function returnMaterialToConversation(workspaceId: string, workspaceRoot: string, viewId?: string): Promise<void> {
  const runtimeKey = getRuntimeKey();
  if (viewId) setActiveWorkbenchEditorView(workspaceId, viewId);
  const profileId = returnProfiles.get(key(workspaceId)) ?? VARIN_WORKBENCH_DEFAULT_PROFILE_ID;
  const workbench = peekEditorWorkbench(workspaceId);
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  if (tab?.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser) {
    const browserPosition = await captureBrowserPosition(workspaceRoot, tab.viewState.browserTabId);
    if (runtimeKey !== getRuntimeKey()) return;
    if (browserPosition) patchEditorViewState(workspaceId, tab.viewId, { browserPosition });
  }
  if (tab) {
    useUIStore.getState().openContextPanelTab(workspaceRoot, {
      mode: tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? 'browser' : 'file',
      targetPath: tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? tab.viewState.browserUrl ?? null : workspacePathFromResourceId(workspaceRoot, tab.resourceId),
      ...(tab.providerId === BUILTIN_EDITOR_PROVIDER_IDS.browser ? { dedupeKey: 'browser' } : {}),
      targetDirectory: workspaceRoot, editorViewId: tab.viewId,
    });
  }
  await selectActiveWorkbenchProfile(profileId, undefined, { enableShell: true });
  if (getRuntimeKey() === runtimeKey) useUIStore.getState().setActiveMainTab('chat');
}

export async function continueBrowserInIde(input: { workspaceRoot: string; tabId: string; url: string; fromProfileId: string }): Promise<void> {
  const runtimeKey = getRuntimeKey();
  const apis = getRegisteredRuntimeAPIs();
  if (!apis) throw new Error('Runtime APIs are not ready');
  const identity = await apis.documents.resolveWorkspace({ path: input.workspaceRoot });
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while opening the resource');
  const browserPosition = await captureBrowserPosition(input.workspaceRoot, input.tabId);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while opening the resource');
  const workbench = openWorkbenchEditor(identity.workspaceId, `browser:${input.tabId}`, BUILTIN_EDITOR_PROVIDER_IDS.browser,
    { viewState: { browserTabId: input.tabId, browserUrl: input.url, ...(browserPosition ? { browserPosition } : {}) } });
  const tab = activeEditorTab(workbench);
  if (tab) await continueMaterialInIde({ workspaceId: identity.workspaceId, viewId: tab.viewId, fromProfileId: input.fromProfileId });
}

subscribeRuntimeEndpointWillChange(() => { returnProfiles.clear(); browserCaptures.clear(); });
