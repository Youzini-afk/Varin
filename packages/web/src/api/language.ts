import type {
  LanguageServicesAPI,
  VarinLanguageCodeAction,
  VarinLanguageCommandRequest,
  VarinLanguageColorInformation,
  VarinLanguageColorPresentation,
  VarinLanguageCompletionItem,
  VarinLanguageDocumentHighlight,
  VarinLanguageDocumentLink,
  VarinLanguageDocumentSyncRequest,
  VarinLanguageDocumentSyncResult,
  VarinLanguageFeatureRequest,
  VarinLanguageFeatureResult,
  VarinLanguageLocation,
  VarinLanguageLocationLink,
  VarinLanguageFoldingRange,
  VarinLanguageHover,
  VarinLanguageInlayHint,
  VarinLanguageProviderStatus,
  VarinLanguageServiceEvent,
  VarinLanguageSelectionRange,
  VarinLanguageSemanticTokens,
  VarinLanguageSignatureHelp,
  VarinLanguageSymbol,
  VarinLanguageTextEdit,
  VarinLanguageWorkspaceEdit,
  Subscription,
} from '@varin/application-client';
import type { JsonValue } from '@varin/extension-contract';
import { LanguageServicesError, parseLanguageServicesFailureReason } from '@varin/application-client';
import { runtimeFetch } from '@varin/application-client';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@varin/application-client';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new LanguageServicesError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new LanguageServicesError(error.error || 'Language request failed', {
      reason: parseLanguageServicesFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

const readSseEvents = async (
  response: Response,
  listener: (event: VarinLanguageServiceEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new LanguageServicesError('Language event stream is unavailable', { reason: 'failed' });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as VarinLanguageServiceEvent;
        if (event && typeof event === 'object' && 'content' in event) continue;
        listener(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

const feature = <T>(method: string, request: VarinLanguageFeatureRequest) => (
  postJson('/api/language/feature', { method, request }) as Promise<VarinLanguageFeatureResult<T>>
);

const command = <T>(method: string, request: VarinLanguageCommandRequest) => (
  postJson('/api/language/feature', { method, request }) as Promise<VarinLanguageFeatureResult<T>>
);

export const createWebLanguageServicesAPI = (): LanguageServicesAPI => ({
  getStatus: (workspaceId, languageId) => (
    postJson('/api/language/status', { workspaceId, languageId }) as Promise<VarinLanguageProviderStatus>
  ),
  subscribe(workspaceId, listener, options): Subscription {
    const generation = getRuntimeEndpointGeneration();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    void (async () => {
      let response: Response | undefined;
      try {
        assertGeneration(generation);
        response = await runtimeFetch('/api/language/events', {
          headers: { Accept: 'text/event-stream' },
          query: { workspaceId },
          signal: controller.signal,
        });
        assertGeneration(generation);
        if (!response.ok) {
          throw new LanguageServicesError('Language event stream failed', {
            reason: 'failed',
            status: response.status,
          });
        }
        await readSseEvents(response, listener, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        controller.abort();
        unsubscribe();
        options?.signal?.removeEventListener('abort', abort);
        await response?.body?.cancel().catch(() => {});
      }
    })();
    return {
      close() {
        unsubscribe();
        options?.signal?.removeEventListener('abort', abort);
        controller.abort();
      },
    };
  },
  syncDocument: (request: VarinLanguageDocumentSyncRequest) => (
    postJson('/api/language/sync', request) as Promise<VarinLanguageDocumentSyncResult>
  ),
  completion: (request) => feature<VarinLanguageCompletionItem[]>('completion', request),
  completionResolve: (request) => feature<VarinLanguageCompletionItem>('completionResolve', request),
  hover: (request) => feature<VarinLanguageHover | null>('hover', request),
  signatureHelp: (request) => feature<VarinLanguageSignatureHelp | null>('signatureHelp', request),
  definition: (request) => feature<VarinLanguageLocationLink[]>('definition', request),
  references: (request) => feature<VarinLanguageLocation[]>('references', request),
  documentSymbols: (request) => feature<VarinLanguageSymbol[]>('documentSymbols', request),
  workspaceSymbols: (request) => feature<VarinLanguageSymbol[]>('workspaceSymbols', request),
  rename: (request) => feature<VarinLanguageWorkspaceEdit | null>('rename', request),
  codeActions: (request) => feature<VarinLanguageCodeAction[]>('codeActions', request),
  codeActionResolve: (request) => feature<VarinLanguageCodeAction>('codeActionResolve', request),
  executeCommand: (request) => command<JsonValue | null>('executeCommand', request),
  documentFormatting: (request) => feature<VarinLanguageTextEdit[]>('documentFormatting', request),
  documentRangeFormatting: (request) => feature<VarinLanguageTextEdit[]>('documentRangeFormatting', request),
  onTypeFormatting: (request) => feature<VarinLanguageTextEdit[]>('onTypeFormatting', request),
  semanticTokens: (request) => feature<VarinLanguageSemanticTokens | null>('semanticTokens', request),
  inlayHints: (request) => feature<VarinLanguageInlayHint[]>('inlayHints', request),
  inlayHintResolve: (request) => feature<VarinLanguageInlayHint>('inlayHintResolve', request),
  documentHighlights: (request) => feature<VarinLanguageDocumentHighlight[]>('documentHighlights', request),
  foldingRanges: (request) => feature<VarinLanguageFoldingRange[]>('foldingRanges', request),
  selectionRanges: (request) => feature<VarinLanguageSelectionRange[]>('selectionRanges', request),
  documentLinks: (request) => feature<VarinLanguageDocumentLink[]>('documentLinks', request),
  documentLinkResolve: (request) => feature<VarinLanguageDocumentLink>('documentLinkResolve', request),
  documentColors: (request) => feature<VarinLanguageColorInformation[]>('documentColors', request),
  colorPresentations: (request) => feature<VarinLanguageColorPresentation[]>('colorPresentations', request),
  restart: (workspaceId, languageId) => (
    postJson('/api/language/restart', { workspaceId, languageId }) as Promise<VarinLanguageProviderStatus>
  ),
  async disposeWorkspace(workspaceId) {
    const generation = getRuntimeEndpointGeneration();
    await postJson('/api/language/dispose-workspace', { workspaceId });
    assertGeneration(generation);
  },
});
