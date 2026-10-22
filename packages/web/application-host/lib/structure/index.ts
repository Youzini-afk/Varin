export { JSON_OUTLINE_MAX_DEPTH, JSON_OUTLINE_MAX_SYMBOLS } from "./constants.js";
export { capabilitiesFromSpec, treeSitterLanguageSpec, TREE_SITTER_LANGUAGE_SPECS } from "./languages.js";
export { createTreeSitterStructureProvider } from "./tree-sitter-provider.js";
export type { TreeSitterLanguageSpec } from "./languages.js";
export { createStructureSource } from "./source.js";
export { isJsonStructureContainerKind, isStructureContainerKind } from "./kinds.js";
export type {
  StructureCapabilities,
  StructureClassifyRequest,
  StructureClassifyResult,
  StructureHitClass,
  StructureImport,
  StructureImportsResult,
  StructureLiteralCall,
  StructureLiteralCallsResult,
  StructureOutlineRequest,
  StructureOutlineResult,
  StructureProvider,
  StructureProviderId,
  StructureSource,
  StructureStatus,
  StructureSymbol,
} from "./types.js";
