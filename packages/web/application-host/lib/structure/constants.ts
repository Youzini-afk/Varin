/**
 * Runaway guard for one tree-sitter outline or classify call after the runtime
 * wasm is already loaded. Init and grammar load are outside this window; their
 * failure is `unavailable`, not a budget miss.
 *
 * This is a wall clock, so it competes with everything else on the box. A
 * value near the parse time of an ordinary file turns a busy Host into silent
 * `failed` and require a plain-text read; it also makes the tests that
 * assert a real parse depend on machine load. Keep enough headroom that only a
 * pathological file trips it, and inject an explicit budget in tests that
 * assert either outcome (D-102).
 */
export const STRUCTURE_PARSE_BUDGET_MS = 250;

/**
 * JSON outline caps (D-114). Depth counts object/array ancestors from the
 * document value. The root object/array is always kept so a capped file still
 * slices to that container instead of a bare ±3 window.
 */
export const JSON_OUTLINE_MAX_DEPTH = 8;
export const JSON_OUTLINE_MAX_SYMBOLS = 256;

/**
 * Ceiling for a user-supplied grammar. The largest published grammar we list is
 * under 6 MB, so this leaves room for a locally built one while keeping a stray
 * pick from being read into memory whole.
 */
export const MAX_USER_GRAMMAR_BYTES = 32 * 1024 * 1024;
