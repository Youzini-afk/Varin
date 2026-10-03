import type { AgentInputContext } from "@varin/protocol";
import type { KernelComputeInput, KernelComputeOptions, KernelComputeResult } from "../kernel/compute-runner.js";

export type StructureProviderId = "lsp" | "tree-sitter";

export type StructureStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "failed"
  | "cancelled";

export type StructureHitClass = "name" | "body" | "string" | "comment";

export interface StructureCapabilities {
  outline: boolean;
  classifyHits: boolean;
  literalCalls: boolean;
  imports: boolean;
}

export interface StructureLineRange {
  /** Inclusive, 1-based. */
  startLine: number;
  /** Inclusive, 1-based. */
  endLine: number;
}

export interface StructureSymbol {
  name: string;
  kind: string;
  range: StructureLineRange;
  signature: StructureLineRange;
  children?: StructureSymbol[];
}

export interface StructureOutlineRequest {
  path: string;
  languageId: string | null;
  text: string;
  revision: string;
  workspaceId?: string;
  sessionId?: string;
  inputContext?: AgentInputContext;
  signal?: AbortSignal;
  /** Hit lines used to detect an uncovered gap before consulting a later provider. */
  hitLines?: number[];
  /**
   * When true, a provider that would start a cold language-server session
   * must return `unavailable` instead (D-099).
   */
  warmOnly?: boolean;
  /** Native scheduling lane; index ingestion never occupies foreground workers. */
  lane?: "foreground" | "background";
}

/**
 * A disk-backed structure request. Unlike StructureOutlineRequest, file bytes
 * remain inside the native compute authority; only revision-bound structure
 * records or structural units cross back into the Host.
 */
export interface StructureFileRequest {
  workspaceId: string;
  root: string;
  path: string;
  languageId: string | null;
  signal?: AbortSignal;
  lane?: "foreground" | "background";
  /** Hit lines for a single native parse/classification pass. */
  lines?: number[];
  /** Compare captured bytes before parsing; only usable with the same recipe. */
  unchangedRevision?: string;
}

export type StructureFixedComputeInput = Omit<KernelComputeInput, "workspaceId" | "pinId" | "rootId" | "objects" | "operation"> & {
  operation: "structure" | "chunks";
};
export type StructureFixedCompute = (
  input: StructureFixedComputeInput,
  options?: KernelComputeOptions,
) => Promise<KernelComputeResult>;

/** Immutable WorkingState input. The provider supplies only grammar/query
 * metadata; bytes stay behind the pinned native compute boundary. */
export interface StructureFixedFileRequest {
  workspaceId: string;
  path: string;
  languageId: string | null;
  compute: StructureFixedCompute;
  signal?: AbortSignal;
  lane?: "foreground" | "background";
  lines?: number[];
}

export interface StructureOutlineResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  symbols: StructureSymbol[];
  message?: string;
}

export interface StructureClassifyRequest extends StructureOutlineRequest {
  lines: number[];
}

export interface StructureClassifyResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  hits: Array<{ line: number; class: StructureHitClass }>;
  incomplete?: boolean;
  message?: string;
}

export interface StructureLiteralCall {
  name: string;
  literal: string;
  line: number;
}

export interface StructureImport {
  source: string;
  line: number;
}

export interface StructureLiteralCallsResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  calls: StructureLiteralCall[];
  incomplete?: boolean;
  message?: string;
}

export interface StructureImportsResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  imports: StructureImport[];
  incomplete?: boolean;
  message?: string;
}

export interface StructureProvider {
  analyze?(request: StructureClassifyRequest): Promise<StructureAnalysis>;
  analyzeFile?(request: StructureFileRequest): Promise<StructureAnalysis>;
  units?(request: StructureOutlineRequest): Promise<StructureUnitsResult>;
  unitsFile?(request: StructureFileRequest): Promise<StructureUnitsResult>;
  unitsFixed?(request: StructureFixedFileRequest): Promise<StructureUnitsResult>;
  readonly id: StructureProviderId;
  capabilities(languageId: string | null): StructureCapabilities;
  outline(request: StructureOutlineRequest): Promise<StructureOutlineResult>;
  classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult>;
  literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult>;
  imports(request: StructureOutlineRequest): Promise<StructureImportsResult>;
}

export interface StructureSource {
  analyze?(request: StructureClassifyRequest): Promise<StructureAnalysis>;
  analyzeFile?(request: StructureFileRequest): Promise<StructureAnalysis>;
  units?(request: StructureOutlineRequest): Promise<StructureUnitsResult>;
  unitsFile?(request: StructureFileRequest): Promise<StructureUnitsResult>;
  unitsFixed?(request: StructureFixedFileRequest): Promise<StructureUnitsResult>;
  outline(request: StructureOutlineRequest): Promise<StructureOutlineResult>;
  classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult>;
  literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult>;
  imports(request: StructureOutlineRequest): Promise<StructureImportsResult>;
}

export const NO_STRUCTURE_CAPABILITIES: StructureCapabilities = {
  outline: false,
  classifyHits: false,
  literalCalls: false,
  imports: false,
};

export function unsupportedResult(
  provider: StructureProviderId | null,
  revision: string,
  message: string,
): StructureOutlineResult {
  return { status: "unsupported", provider, revision, symbols: [], message };
}

/** One native parse supplies every model-neutral structure category. */
export interface StructureAnalysis {
  outline: StructureOutlineResult;
  classify: StructureClassifyResult;
  literalCalls: StructureLiteralCallsResult;
  imports: StructureImportsResult;
  recipeId?: string;
  /** UTF-16 line lengths produced by the same native parse input. */
  lineLengths?: number[];
  unchanged?: boolean;
  sourceMetadata?: StructureSourceMetadata;
}
export type StructureSourceMetadata = { byteLength: string; modifiedTimeNs: string };
export interface StructureUnit {
  startLine: number;
  endLine: number;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  docComments: string;
  text: string;
  fallback: boolean;
}
export interface StructureUnitsResult {
  status: StructureStatus;
  revision: string;
  units: StructureUnit[];
  recipeId?: string;
  message?: string;
  unchanged?: boolean;
  sourceMetadata?: StructureSourceMetadata;
}
