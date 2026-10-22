import { readFileSync } from "node:fs";
import { JSON_OUTLINE_MAX_DEPTH, JSON_OUTLINE_MAX_SYMBOLS } from "./constants.js";
import {
  JAVASCRIPT_DEFINITION_QUERY,
  JAVASCRIPT_IMPORT_QUERY,
  JAVASCRIPT_LITERAL_CALL_QUERY,
  JSON_DEFINITION_QUERY,
  TYPESCRIPT_DEFINITION_QUERY,
  TYPESCRIPT_IMPORT_QUERY,
  TYPESCRIPT_LITERAL_CALL_QUERY,
} from "./queries.js";
import { resolveStructureRuntimeFile } from "./runtime-path.js";
import { NO_STRUCTURE_CAPABILITIES, type StructureCapabilities } from "./types.js";

/**
 * Node-type test for hit classification. Bundled languages name their comment
 * and string nodes exactly; an on-demand grammar is matched by shape, because
 * we do not carry a node-type table for every language we can install.
 */
export type StructureTypeMatcher = (type: string) => boolean;

const typeSet = (...types: readonly string[]): StructureTypeMatcher => {
  const set = new Set(types);
  return (type) => set.has(type);
};

/**
 * Per-language tree-sitter wiring. Capabilities are derived from which
 * queries are present — do not restate the four flags by hand.
 */
export interface TreeSitterLanguageSpec {
  grammarFile: string;
  definitionQuery: string;
  importQuery?: string;
  literalCallQuery?: string;
  commentTypes: StructureTypeMatcher;
  stringTypes: StructureTypeMatcher;
  bindingTypes: ReadonlySet<string>;
  /** When set, outline walks JSON pair/object/array nodes instead of code units. */
  jsonOutline?: { maxDepth: number; maxSymbols: number };
  /**
   * When set, `definitionQuery` is an upstream `tags.scm` and the outline is
   * read from its `@definition.*` captures instead of our own unit rules.
   */
  tagsOutline?: true;
}

const TYPESCRIPT_COMMENT_TYPES = typeSet("comment", "html_comment");
const TYPESCRIPT_STRING_TYPES = typeSet(
  "string",
  "template_string",
  "string_fragment",
  "escape_sequence",
);
const TYPESCRIPT_BINDING_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
  "public_field_definition",
]);

const JAVASCRIPT_BINDING_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
  "field_definition",
]);

/**
 * Grammars we can install carry no hand-written node-type table, so comments
 * and strings are recognised by name shape. Every grammar we list names them
 * with these substrings (`comment`, `line_comment`, `block_comment`, `string`,
 * `raw_string_literal`, `interpreted_string_literal`, `char_literal`).
 */
const GENERIC_COMMENT_TYPES: StructureTypeMatcher = (type) => type.includes("comment");
const GENERIC_STRING_TYPES: StructureTypeMatcher = (type) => (
  type.includes("string") || type.includes("char_literal")
);

const readBundledTags = (queryFile: string): string => {
  try {
    return readFileSync(resolveStructureRuntimeFile(queryFile, import.meta.url), "utf8");
  } catch {
    // A missing staged asset is reported by the native provider as unavailable;
    // importing the Host must remain possible so the rest of the service can
    // report that degradation instead of failing during module evaluation.
    return "";
  }
};

const bundledTags = (grammarFile: string, queryFile: string): TreeSitterLanguageSpec => ({
  grammarFile,
  definitionQuery: readBundledTags(queryFile),
  tagsOutline: true,
  commentTypes: GENERIC_COMMENT_TYPES,
  stringTypes: GENERIC_STRING_TYPES,
  bindingTypes: new Set(),
});

const TYPESCRIPT_FAMILY: Omit<TreeSitterLanguageSpec, "grammarFile"> = {
  definitionQuery: TYPESCRIPT_DEFINITION_QUERY,
  importQuery: TYPESCRIPT_IMPORT_QUERY,
  literalCallQuery: TYPESCRIPT_LITERAL_CALL_QUERY,
  commentTypes: TYPESCRIPT_COMMENT_TYPES,
  stringTypes: TYPESCRIPT_STRING_TYPES,
  bindingTypes: TYPESCRIPT_BINDING_TYPES,
};

const JAVASCRIPT_FAMILY: Omit<TreeSitterLanguageSpec, "grammarFile"> = {
  definitionQuery: JAVASCRIPT_DEFINITION_QUERY,
  importQuery: JAVASCRIPT_IMPORT_QUERY,
  literalCallQuery: JAVASCRIPT_LITERAL_CALL_QUERY,
  commentTypes: TYPESCRIPT_COMMENT_TYPES,
  stringTypes: TYPESCRIPT_STRING_TYPES,
  bindingTypes: JAVASCRIPT_BINDING_TYPES,
};

export const TREE_SITTER_LANGUAGE_SPECS: Readonly<Record<string, TreeSitterLanguageSpec>> = {
  typescript: {
    ...TYPESCRIPT_FAMILY,
    grammarFile: "tree-sitter-typescript.wasm",
  },
  typescriptreact: {
    ...TYPESCRIPT_FAMILY,
    grammarFile: "tree-sitter-tsx.wasm",
  },
  javascript: {
    ...JAVASCRIPT_FAMILY,
    grammarFile: "tree-sitter-javascript.wasm",
  },
  javascriptreact: {
    ...JAVASCRIPT_FAMILY,
    grammarFile: "tree-sitter-javascript.wasm",
  },
  json: {
    grammarFile: "tree-sitter-json.wasm",
    definitionQuery: JSON_DEFINITION_QUERY,
    commentTypes: typeSet("comment"),
    stringTypes: typeSet("string", "string_content", "escape_sequence"),
    bindingTypes: new Set(),
    jsonOutline: { maxDepth: JSON_OUTLINE_MAX_DEPTH, maxSymbols: JSON_OUTLINE_MAX_SYMBOLS },
  },
  python: bundledTags("tree-sitter-python.wasm", "tree-sitter-python.tags.scm"),
  go: bundledTags("tree-sitter-go.wasm", "tree-sitter-go.tags.scm"),
  rust: bundledTags("tree-sitter-rust.wasm", "tree-sitter-rust.tags.scm"),
  java: bundledTags("tree-sitter-java.wasm", "tree-sitter-java.tags.scm"),
  c: bundledTags("tree-sitter-c.wasm", "tree-sitter-c.tags.scm"),
  cpp: bundledTags("tree-sitter-cpp.wasm", "tree-sitter-cpp.tags.scm"),
  csharp: bundledTags("tree-sitter-c_sharp.wasm", "tree-sitter-csharp.tags.scm"),
  kotlin: bundledTags("tree-sitter-kotlin.wasm", "tree-sitter-kotlin.tags.scm"),
  ruby: bundledTags("tree-sitter-ruby.wasm", "tree-sitter-ruby.tags.scm"),
  php: bundledTags("tree-sitter-php.wasm", "tree-sitter-php.tags.scm"),
  shellscript: bundledTags("tree-sitter-bash.wasm", "tree-sitter-bash.tags.scm"),
  css: bundledTags("tree-sitter-css.wasm", "tree-sitter-css.tags.scm"),
  html: bundledTags("tree-sitter-html.wasm", "tree-sitter-html.tags.scm"),
  yaml: bundledTags("tree-sitter-yaml.wasm", "tree-sitter-yaml.tags.scm"),
  toml: bundledTags("tree-sitter-toml.wasm", "tree-sitter-toml.tags.scm"),
};

/**
 * An installed grammar plus its upstream tags query. Outline and hit
 * classification only: `tags.scm` says nothing about imports or literal calls,
 * so those capabilities stay off and the facade reports `unsupported`.
 */
export function treeSitterTagsSpec(grammarFile: string, tagsQuery: string): TreeSitterLanguageSpec {
  return {
    grammarFile,
    definitionQuery: tagsQuery,
    tagsOutline: true,
    commentTypes: GENERIC_COMMENT_TYPES,
    stringTypes: GENERIC_STRING_TYPES,
    bindingTypes: new Set(),
  };
}

/**
 * `@definition.<suffix>` from an upstream tags query, mapped onto the kinds the
 * slice container test already understands. An unmapped suffix stays a catalog
 * name and never becomes a slice unit (D-098).
 */
const TAGS_DEFINITION_KINDS: Readonly<Record<string, string>> = {
  function: "function",
  method: "method",
  constructor: "constructor",
  class: "class",
  interface: "interface",
  trait: "interface",
  protocol: "interface",
  struct: "struct",
  union: "struct",
  enum: "enum",
  type: "type",
  module: "module",
  namespace: "module",
  package: "package",
  macro: "function",
  constant: "variable",
  field: "variable",
  property: "variable",
  variable: "variable",
};

export function tagsDefinitionKind(captureName: string): string | null {
  if (!captureName.startsWith("definition.")) return null;
  const suffix = captureName.slice("definition.".length);
  return TAGS_DEFINITION_KINDS[suffix] ?? "unknown";
}

export function treeSitterLanguageSpec(languageId: string | null | undefined): TreeSitterLanguageSpec | undefined {
  if (!languageId) return undefined;
  return TREE_SITTER_LANGUAGE_SPECS[languageId];
}

export function capabilitiesFromSpec(spec: TreeSitterLanguageSpec | undefined): StructureCapabilities {
  if (!spec || (spec.tagsOutline === true && !spec.definitionQuery.trim())) return NO_STRUCTURE_CAPABILITIES;
  return {
    outline: true,
    classifyHits: true,
    literalCalls: Boolean(spec.literalCallQuery),
    imports: Boolean(spec.importQuery),
  };
}
