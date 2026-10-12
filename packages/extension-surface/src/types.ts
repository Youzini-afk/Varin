import type {
  VarinApplicationSurface,
  VarinContextValue,
  VarinExtensionActualState,
  VarinExtensionServiceProvision,
  VarinExtensionServiceRequirement,
  VarinExtensionStaticContribution,
} from "@varin/extension-contract";

export interface SurfaceOwnerIdentity {
  desiredRevision: number;
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  hostId: string;
  realmId: string;
}

export interface SurfaceContribution<TImplementation = unknown> {
  descriptor: VarinExtensionStaticContribution;
  implementation: TImplementation;
  owner: SurfaceOwnerIdentity;
}

export interface SurfaceService<TImplementation = unknown> {
  descriptor: VarinExtensionServiceProvision;
  implementation: TImplementation;
  owner: SurfaceOwnerIdentity;
}

export interface SurfaceExternalService<TImplementation = unknown> {
  descriptor: VarinExtensionServiceProvision;
  /** Cleanup owned by the consumer activation scope, for Surface-local service instances. */
  dispose?: SurfaceDisposer;
  implementation: TImplementation;
  providerId: string;
}

export interface SurfaceActualState extends VarinExtensionActualState {
  extensionId: string;
  extensionVersion: string;
}

export interface SurfaceLayoutReference {
  contributionId: string;
  order?: number;
  region?: string;
  size?: number;
  visible?: boolean;
}

export interface SurfaceRegistrySnapshot {
  actual: SurfaceActualState[];
  contributions: readonly SurfaceContribution[];
  layoutReferences: readonly SurfaceLayoutReference[];
  replacementSelections: Readonly<Record<string, string>>;
  revision: number;
  serviceSelections: Readonly<Record<string, string>>;
  services: readonly SurfaceService[];
  visibleContributions: readonly SurfaceContribution[];
}

export interface SurfaceActivationOptions {
  externalServices?: readonly SurfaceExternalService[];
  grantedCapabilities?: Iterable<string>;
  owner: SurfaceOwnerIdentity;
  requirements?: VarinExtensionServiceRequirement[];
  /** Provider IDs already resolved by the owning Host/profile for selected bindings. */
  serviceSelections?: Readonly<Record<string, string>>;
}

export interface SurfaceActivationContext {
  contribute<TImplementation>(
    descriptor: VarinExtensionStaticContribution,
    implementation: TImplementation,
  ): void;
  onDispose(disposer: SurfaceDisposer): void;
  provide<TImplementation>(
    descriptor: VarinExtensionServiceProvision,
    implementation: TImplementation,
  ): void;
  readonly signal: AbortSignal;
  useService<TImplementation = unknown>(id: string, version: number): TImplementation | undefined;
  useServices<TImplementation = unknown>(id: string, version: number): TImplementation[];
  /**
   * Owner-scoped context key writer. Keys written through this writer are
   * namespaced by owner identity and fenced by generation — writes from a
   * stale generation are silently rejected. All keys are cleaned up when
   * the owner scope is disposed.
   */
  readonly context: SurfaceContextWriter;
}

export type SurfaceDisposer = () => void | Promise<void>;
export type SurfaceActivation = (context: SurfaceActivationContext) => void | Promise<void>;

export interface SurfaceOwnerHandle {
  readonly owner: SurfaceOwnerIdentity;
  deactivate(nextDesiredRevision: number, nextGeneration: number): Promise<void>;
}

export interface SurfaceExtensionRuntimeOptions {
  surface: VarinApplicationSurface;
  /**
   * Optional provider for evaluating `when` context expressions on
   * contributions. When provided, contributions whose `when` expression
   * evaluates to false are excluded from visibleContributions (but remain
   * in the registry). When not provided, `when` expressions are ignored
   * (all compatible contributions are visible).
   */
  contextProvider?: SurfaceContextProvider;
}

/**
 * Provides context key values for evaluating contribution `when` expressions.
 * The Surface runtime calls this during visibility projection. Also
 * creates owner-scoped writers that namespace keys and fence by generation.
 */
export interface SurfaceContextChanges {
  commit: readonly SurfaceContextWriterLease[];
  dispose: readonly SurfaceContextWriterLease[];
}

export interface SurfaceReadonlyContextProvider {
  getContext(): ReadonlyMap<string, VarinContextValue>;
  subscribe(keys: readonly string[], listener: () => void): () => void;
  batch?(operation: () => void): void;
}

/** Read-only providers need no writer; owned writers always supply their original store's preview. */
export type SurfaceContextProvider = SurfaceReadonlyContextProvider & (
  | { createWriter?: never; previewContext?: never }
  | {
      createWriter(owner: SurfaceOwnerIdentity): SurfaceContextWriterLease;
      previewContext(changes: SurfaceContextChanges): ReadonlyMap<string, VarinContextValue>;
    }
);

export interface SurfaceContextWriterLease {
  /** Publish the staged owner layer. Calling this more than once is a no-op. */
  commit(): void;
  /**
   * Dispose only this lease. A stale lease must never remove a newer owner
   * generation or another entrypoint's values.
   */
  dispose(): void;
  readonly writer: SurfaceContextWriter;
}

/**
 * Owner-scoped writer for context key values. Candidate writes are staged;
 * after commit, only the currently active lease for that logical owner may
 * mutate its published layer. A disposed or superseded writer returns false.
 */
export interface SurfaceContextWriter {
  /**
   * Set a context key value. The key is namespaced by owner identity.
   * Returns true if the write was accepted, false if the writer's
   * generation is stale.
   */
  set(key: string, value: VarinContextValue): boolean;
  /**
   * Delete a context key value. Returns true if the key was removed.
   */
  delete(key: string): boolean;
}

/** A private candidate projection for connected Surface consumers, never an authoritative catalog. */
export interface SurfaceContributionPreview {
  extensionId: string;
  /** Owner updates plus actual visibility changes caused by declared when/context dependencies. */
  affectedExtensionIds: readonly string[];
  owners: readonly SurfaceOwnerIdentity[];
  visibleContributions: readonly SurfaceContribution[];
}

/** A connected consumer stages real mounts before the owning Surface generation is published. */
export interface SurfaceContributionLease {
  validate(): void;
  /** Synchronously publish staged mounts; return cleanup for retired mounts. Must not throw. */
  commit(): SurfaceDisposer | void;
  rollback(): void | Promise<void>;
}

export type SurfaceContributionConsumer = (
  preview: SurfaceContributionPreview,
) => Promise<SurfaceContributionLease | undefined>;
