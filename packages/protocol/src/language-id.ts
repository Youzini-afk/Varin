/**
 * Single language identity authority (D-087).
 *
 * The Host language views are keyed by `(workspaceId, languageId, viewId)` and
 * language providers are matched by `languageIds`. Two independent extension
 * tables therefore split one file across two sessions — `.sh` resolved to both
 * `shellscript` and `shell` — and made agent-side navigation unavailable for
 * extensions only one side knew. Both sides resolve identity here; identifiers
 * follow the extension ecosystem so a provider manifest keeps working.
 *
 * Languages contributed at runtime live in the renderer's editor registry and
 * are not visible to the Host, so they stay renderer-only by construction.
 */

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  scala: "scala",
  sc: "scala",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  toml: "toml",
  css: "css",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  geojson: "json",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
};

const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
};

const fileNameOf = (path: string): string => (
  path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? ""
);

/** Resolve one path to its language identity, or null when no side knows it. */
export const languageIdForPath = (path: string): string | null => {
  const fileName = fileNameOf(path);
  if (!fileName) return null;
  const byName = LANGUAGE_BY_FILENAME[fileName];
  if (byName) return byName;
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  return LANGUAGE_BY_EXTENSION[fileName.slice(dot + 1)] ?? null;
};

/** Editor-facing identity for languages whose Host id differs from the editor's. */
export const editorLanguageIdForLanguage = (languageId: string): string => {
  if (languageId === "typescriptreact") return "typescript";
  if (languageId === "javascriptreact") return "javascript";
  if (languageId === "shellscript") return "shell";
  return languageId;
};
