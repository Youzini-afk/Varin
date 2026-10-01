import { type PiConfigTextFormat } from "@varin/protocol";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { HostError } from "./errors.js";
import { lstat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  RevisionedTextFileEditor,
  type RevisionedTextFileSnapshot,
} from "./revisioned-text-file-editor.js";

export type ConfigTextFileSnapshot = RevisionedTextFileSnapshot;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContent(content: string, format: PiConfigTextFormat, path: string): void {
  let value: unknown;
  if (format === "json") {
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new HostError("invalid_config_file", `Configuration file is not valid JSON: ${path}`, {
        cause: error,
      });
    }
  } else {
    const errors: ParseError[] = [];
    value = parse(content.replace(/^\uFEFF/, ""), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      const first = errors[0];
      const issue = first
        ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
        : "unknown parse error";
      throw new HostError(
        "invalid_config_file",
        `Configuration file is not valid JSONC (${issue}): ${path}`,
      );
    }
  }
  if (!isObject(value)) {
    throw new HostError("invalid_config_file", `Configuration file must contain an object: ${path}`);
  }
}

export async function resolveConfigDocumentPath(
  base: string,
  requestedPath: string,
  options: {
    extensions?: readonly string[];
    reservedPaths?: readonly string[];
  } = {},
): Promise<{ path: string; relativePath: string }> {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new HostError("invalid_config_path", "Configuration path must be non-empty");
  }
  const extensions = options.extensions ?? [".json"];
  if (!extensions.includes(extname(requestedPath).toLowerCase())) {
    throw new HostError(
      "invalid_config_path",
      `Configuration path must use one of: ${extensions.join(", ")}`,
    );
  }
  const root = resolve(base);
  const path = resolve(root, requestedPath);
  const relativePath = relative(root, path);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new HostError(
      "invalid_config_path",
      "Configuration path must stay inside its configuration root",
    );
  }
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const reservedPaths = options.reservedPaths ?? ["settings.json"];
  if (reservedPaths.some((entry) => normalizedPath.toLowerCase() === entry.toLowerCase())) {
    throw new HostError(
      "invalid_config_path",
      "Configuration path is owned by a dedicated Varin settings API",
    );
  }
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HostError(
          "invalid_config_path",
          "Configuration path cannot traverse a symbolic link",
        );
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return { path, relativePath: normalizedPath };
}

export class ConfigTextFileEditor {
  readonly #editor: RevisionedTextFileEditor;

  constructor(path: string, format: PiConfigTextFormat) {
    this.#editor = new RevisionedTextFileEditor(path, {
      conflictCode: "config_conflict",
      conflictLabel: "Configuration file",
      defaultContent: "{}\n",
      validate: (content) => validateContent(content, format, path),
    });
  }

  async read(): Promise<ConfigTextFileSnapshot> {
    return this.#editor.read();
  }

  async update(content: string, expectedRevision: string): Promise<ConfigTextFileSnapshot> {
    return this.#editor.update(content, expectedRevision);
  }
}
