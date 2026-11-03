export class ExtensionCatalogStorageError extends Error {
  readonly code: "catalog_invalid" | "catalog_read_failed" | "identity_invalid" | "identity_read_failed";
  readonly retryable: boolean;

  constructor(
    code: ExtensionCatalogStorageError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtensionCatalogStorageError";
    this.code = code;
    this.retryable = code.endsWith("read_failed");
  }
}

export class ExtensionCatalogRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Varin extension catalog changed: expected revision ${expectedRevision}, actual revision ${actualRevision}`);
    this.name = "ExtensionCatalogRevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
  }
}

export class ExtensionCatalogStaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionCatalogStaleStateError";
  }
}

export class ExtensionStorageError extends Error {
  readonly code: "storage_invalid" | "storage_read_failed" | "storage_write_failed" | "storage_schema_changed";
  readonly retryable: boolean;

  constructor(code: ExtensionStorageError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionStorageError";
    this.code = code;
    this.retryable = code === "storage_read_failed" || code === "storage_write_failed";
  }
}

export class ExtensionStorageRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Varin extension storage changed: expected revision ${expectedRevision}, actual revision ${actualRevision}`);
    this.name = "ExtensionStorageRevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
  }
}

/** A saved composition is evidence of the original selection, never permission to
 * restore removed code or grants. These reasons are safe to show without exposing
 * package paths, capability arguments, configuration bodies or credentials. */
export class HostCompositionRestoreError extends Error {
  readonly code = "host_composition_restore_failed";

  constructor(
    readonly reason: "catalog_unavailable" | "invalid_composition" | "extension_missing"
      | "extension_disabled" | "entrypoint_missing" | "candidate_changed"
      | "artifact_changed" | "grants_changed" | "dependencies_changed",
    message: string,
    readonly extensionId?: string,
    readonly extensionVersion?: string,
    options?: ErrorOptions,
  ) {
    super(`${message}. Inspect the original package and capability review in extension management. `
      + "Recovery will not select another implementation or restore permissions automatically.", options);
    this.name = "HostCompositionRestoreError";
  }
}

/** Product owners retain their established failure codes and the typed original
 * composition cause; a failed restore must not become a fresh execution choice. */
export class HostBindingRestoreError extends Error {
  readonly code: "extension_tool_exact_binding_unavailable" | "policy_exact_binding_unavailable" | "model-configuration-changed" | "run_driver_exact_binding_unavailable";

  constructor(
    readonly kind: "tool" | "policy" | "model" | "driver",
    readonly reason: "binding_changed" | "service_version_unsupported" | "implementation_unavailable",
    readonly reference: string,
    options?: ErrorOptions,
  ) {
    const code = kind === "tool" ? "extension_tool_exact_binding_unavailable"
      : kind === "policy" ? "policy_exact_binding_unavailable"
      : kind === "driver" ? "run_driver_exact_binding_unavailable" : "model-configuration-changed";
    const detail = options?.cause instanceof HostCompositionRestoreError ? options.cause.message
      : "Inspect the original extension version, service contract and configuration. "
        + "The accepted work will not be retargeted or replayed with the current implementation.";
    super(`${code}: The original ${kind} binding ${reference} cannot be restored (${reason}). ${detail}`, options);
    this.name = "HostBindingRestoreError";
    this.code = code;
  }
}
