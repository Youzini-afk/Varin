export type EmbeddedSessionChatConfig = {
  threadId: string;
  branchId: string;
  directory: string | null;
  readOnly: boolean;
};

export const VARIN_EMBEDDED_SESSION_CHAT_PANEL = 'session-chat';

export const normalizeEmbeddedSessionDirectory = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
};

export const buildEmbeddedSessionChatURL = ({
  threadId,
  branchId,
  directory,
  readOnly,
  basePath,
  origin,
}: EmbeddedSessionChatConfig & {
  basePath?: string;
  origin?: string;
}): string => {
  const resolvedOrigin = origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  const resolvedPath = basePath ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  const url = new URL(resolvedPath, resolvedOrigin);
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('panel', VARIN_EMBEDDED_SESSION_CHAT_PANEL);
  url.searchParams.set('threadId', threadId);
  url.searchParams.set('branchId', branchId);
  if (readOnly) {
    url.searchParams.set('readOnly', '1');
  }
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory.trim());
  }
  url.hash = '';
  return url.toString();
};

export const readEmbeddedSessionChatConfigFromParams = (params: URLSearchParams): EmbeddedSessionChatConfig | null => {
  if (params.get('panel') !== VARIN_EMBEDDED_SESSION_CHAT_PANEL) {
    return null;
  }

  const threadId = params.get('threadId')?.trim() || '';
  const branchId = params.get('branchId')?.trim() || '';
  if (!threadId || !branchId) {
    return null;
  }

  const directoryRaw = params.get('directory');
  const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
    ? directoryRaw.trim()
    : null;

  return {
    threadId,
    branchId,
    directory,
    readOnly: params.get('readOnly') === '1' || params.get('readOnly') === 'true',
  };
};

export const readEmbeddedSessionChatConfigFromSearch = (search: string): EmbeddedSessionChatConfig | null => {
  return readEmbeddedSessionChatConfigFromParams(new URLSearchParams(search));
};

export const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return readEmbeddedSessionChatConfigFromSearch(window.location.search);
};

export const shouldConsumeSessionUrlParams = (params: URLSearchParams): boolean => {
  if (params.get('panel') === VARIN_EMBEDDED_SESSION_CHAT_PANEL) {
    return false;
  }

  return Boolean(params.get('thread')?.trim() && params.get('branch')?.trim());
};

export const isEmbeddedSessionChatReady = ({
  embeddedSessionChat,
  currentIdentity,
  currentDirectory,
}: {
  embeddedSessionChat: EmbeddedSessionChatConfig;
  currentIdentity: import('@varin/application-client').ThreadIdentity | null | undefined;
  currentDirectory: string | null | undefined;
}): boolean => {
  const expectedDirectory = normalizeEmbeddedSessionDirectory(embeddedSessionChat.directory);
  const activeDirectory = normalizeEmbeddedSessionDirectory(currentDirectory);
  if (expectedDirectory && activeDirectory !== expectedDirectory) {
    return false;
  }
  return currentIdentity?.threadId === embeddedSessionChat.threadId && currentIdentity?.branchId === embeddedSessionChat.branchId;
};
