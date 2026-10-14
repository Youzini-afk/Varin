import type { JsonValue, ProtocolErrorData } from "@varin/protocol";

export class HostError extends Error {
  readonly code: string;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; details?: JsonValue; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HostError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function toProtocolError(error: unknown): ProtocolErrorData {
  if (error instanceof HostError) {
    return {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
