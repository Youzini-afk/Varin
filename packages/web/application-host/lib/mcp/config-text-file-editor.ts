import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { HostError } from "../configuration-errors.js";
import {
  RevisionedTextFileEditor,
  type RevisionedTextFileSnapshot,
} from "./revisioned-text-file-editor.js";

export type ConfigTextFileSnapshot = RevisionedTextFileSnapshot;
type ConfigurationTextFormat = 'json' | 'jsonc';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContent(content: string, format: ConfigurationTextFormat, path: string): void {
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

export class ConfigTextFileEditor {
  readonly #editor: RevisionedTextFileEditor;

  constructor(path: string, format: ConfigurationTextFormat) {
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
