/**
 * Varin tree-sitter queries for TypeScript / TSX.
 *
 * Adapted from Apache-2.0 query sets in Aider (paul-gauthier/aider,
 * `aider/repomap.py` language queries) and nvim-treesitter
 * (`queries/typescript/locals.scm` / `highlights.scm`). Captures and
 * grouping are Varin's; node names follow tree-sitter-typescript.
 *
 * `@unit` marks a candidate outline span. The provider keeps it as a slice
 * unit only when it is a container or a definition binding (D-098):
 * `const foo = () => {}` / `const C = class {}` stay units; `const needle = 1`
 * is a name for classification, not a slice unit.
 *
 * Covered: function/generator/class/abstract class (including named export
 * default and anonymous `export default class {}`), interface, type alias,
 * enum, method_definition (including object-literal methods),
 * function_signature (`declare function`), internal_module/module
 * (`namespace` / `declare namespace` / `module`), lexical and var declarators,
 * public fields (unit only when the initializer is a definition).
 *
 * Not covered (on purpose): import aliases, enum members as their own units,
 * interface/type method signatures as units, parameters, decorators, unnamed
 * `export default abstract class {}` (grammar error node), and a full
 * grammar-node census. Arrow bindings (`const beta = () => {}`,
 * `export const gamma = () => {}`) and `export default function` are covered.
 * JavaScript / JSON queries live below this TypeScript set.
 */

export const TYPESCRIPT_DEFINITION_QUERY = `
(function_declaration
  name: (identifier) @name) @unit

(generator_function_declaration
  name: (identifier) @name) @unit

(class_declaration
  name: (type_identifier) @name) @unit

(class_declaration) @unit

(export_statement
  (class) @unit)

(abstract_class_declaration
  name: (type_identifier) @name) @unit

(abstract_class_declaration) @unit

(interface_declaration
  name: (type_identifier) @name) @unit

(type_alias_declaration
  name: (type_identifier) @name) @unit

(enum_declaration
  name: (identifier) @name) @unit

(method_definition
  name: (_) @name) @unit

(method_signature
  name: (_) @name)

(abstract_method_signature
  name: (_) @name)

(public_field_definition
  name: (_) @name) @unit

(function_signature
  name: (identifier) @name) @unit

(internal_module
  name: (_) @name) @unit

(module
  name: (_) @name) @unit

(variable_declarator name: (identifier) @name) @unit
`;

/**
 * Calls whose *first* argument is a string literal — the shape a registration
 * or request takes (`register("x", …)`, `bridge.request("x", …)`).
 *
 * The `.` anchor pins the string to the first named argument. Without it the
 * query matched a string anywhere in the argument list, so
 * `register(handler, "not-first")` produced a "connection" and
 * `register("a", "b")` produced two (D-143).
 *
 * The `await_expression` alternative exists because tree-sitter-typescript
 * resolves the `<` ambiguity in `await x.request<T>(…)` by attaching `await`
 * to the callee rather than the call — the tree is
 * `(call_expression function: (await_expression …) type_arguments: … )`.
 * That is how every awaited generic bridge request in this repository parses,
 * and it is why `explore-tool.ts`'s request end of "explore.search" was
 * missing from the graph.
 */
export const TYPESCRIPT_LITERAL_CALL_QUERY = `
(call_expression
  function: [
    (identifier) @fn
    (member_expression
      property: (property_identifier) @fn)
    (await_expression [
      (identifier) @fn
      (member_expression
        property: (property_identifier) @fn)
    ])
  ]
  arguments: (arguments
    .
    (string) @literal)) @call
`;

export const TYPESCRIPT_IMPORT_QUERY = `
(import_statement
  source: (string) @source) @import

(call_expression
  function: (identifier) @fn
  arguments: (arguments
    (string) @source)
  (#eq? @fn "require")) @import

(call_expression
  function: (import) @fn
  arguments: (arguments
    (string) @source)) @import
`;

/**
 * JavaScript / JSX definition query. A subset of the TypeScript set: the JS
 * grammar has no `interface_declaration`, `type_alias_declaration`,
 * `enum_declaration`, `function_signature`, `abstract_class_declaration`,
 * `internal_module`, or `public_field_definition` (it uses `field_definition`).
 * Class names are `identifier`, not `type_identifier`.
 *
 * Adapted from the same Apache-2.0 Aider / nvim-treesitter sources as the
 * TypeScript queries above. JSX lives in this grammar; `javascriptreact`
 * reuses the query unchanged.
 */
export const JAVASCRIPT_DEFINITION_QUERY = `
(function_declaration
  name: (identifier) @name) @unit

(generator_function_declaration
  name: (identifier) @name) @unit

(class_declaration
  name: (identifier) @name) @unit

(class_declaration) @unit

(export_statement
  (class) @unit)

(method_definition
  name: (_) @name) @unit

(field_definition
  property: (_) @name) @unit

(variable_declarator name: (identifier) @name) @unit
`;

export const JAVASCRIPT_LITERAL_CALL_QUERY = TYPESCRIPT_LITERAL_CALL_QUERY;

export const JAVASCRIPT_IMPORT_QUERY = TYPESCRIPT_IMPORT_QUERY;

/**
 * JSON pair query. The provider keeps a pair when it is top-level or its
 * value is `object` / `array`, and separately walks object/array nodes as
 * slice containers (D-114). Node types follow tree-sitter-json.
 *
 * Adapted from nvim-treesitter `queries/json/locals.scm` (Apache-2.0).
 */
export const JSON_DEFINITION_QUERY = `
(pair
  key: (string) @name) @unit
`;
