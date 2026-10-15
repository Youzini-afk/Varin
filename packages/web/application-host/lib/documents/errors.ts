export interface DocumentAuthorityErrorOptions {
  code?: string;
  statusCode?: number;
  currentEpoch?: number;
  cause?: unknown;
}

export class DocumentAuthorityError extends Error {
  code: string;
  statusCode: number;
  currentEpoch?: number;

  constructor(message: string, options: DocumentAuthorityErrorOptions = {}) {
    super(message);
    this.name = 'DocumentAuthorityError';
    this.code = options.code ?? 'failed';
    this.statusCode = options.statusCode ?? 500;
    if (options.currentEpoch !== undefined && Number.isSafeInteger(options.currentEpoch) && options.currentEpoch > 0) {
      this.currentEpoch = options.currentEpoch;
    }
  }
}

export class DocumentWorkspaceUnregisteredError extends DocumentAuthorityError {
  constructor() {
    super('Workspace is not registered on this application host; select its original source again', { code: 'workspace-unregistered', statusCode: 404 });
    this.name = 'DocumentWorkspaceUnregisteredError';
  }
}

export class DocumentUntrustedError extends DocumentAuthorityError {
  constructor(message: string = 'Workspace is not trusted') {
    super(message, { code: 'untrusted', statusCode: 403 });
    this.name = 'DocumentUntrustedError';
  }
}

export interface DocumentWorkspaceUnavailableErrorOptions {
  cause?: unknown;
}

export class DocumentWorkspaceUnavailableError extends DocumentAuthorityError {
  constructor(
    message: string = 'Workspace root is temporarily unavailable',
    options: DocumentWorkspaceUnavailableErrorOptions = {},
  ) {
    super(message, { code: 'workspace-unavailable', statusCode: 503 });
    this.name = 'DocumentWorkspaceUnavailableError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class DocumentPathError extends DocumentAuthorityError {
  constructor(message: string = 'Path is outside workspace', statusCode: number = 403) {
    super(message, { code: 'path-escape', statusCode });
    this.name = 'DocumentPathError';
  }
}

export const isDocumentAuthorityError = (error: unknown): error is DocumentAuthorityError =>
  error instanceof DocumentAuthorityError;
