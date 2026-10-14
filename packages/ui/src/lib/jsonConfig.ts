import type { JsonValue } from '@varin/protocol';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';

export type JsonObject = { [key: string]: JsonValue };

export const asJsonObject = (value: JsonValue | undefined): JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
);

export const readJsonPath = (
  source: JsonObject,
  path: readonly string[],
): JsonValue | undefined => {
  let current: JsonValue | undefined = source;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

export const hasJsonPath = (source: JsonObject, path: readonly string[]): boolean => {
  if (path.length === 0) return true;
  let current: JsonValue | undefined = source;
  for (const segment of path) {
    if (
      typeof current !== 'object'
      || current === null
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return false;
    }
    current = current[segment];
  }
  return true;
};

export const setJsonPath = (
  source: JsonObject,
  path: readonly string[],
  value: JsonValue,
): JsonObject => {
  if (path.length === 0) return asJsonObject(value);
  const [head, ...tail] = path;
  if (!head) return source;
  return {
    ...source,
    [head]: tail.length === 0
      ? value
      : setJsonPath(asJsonObject(source[head]), tail, value),
  };
};

const removeJsonPathInternal = (
  source: JsonObject,
  path: readonly string[],
): JsonObject => {
  const [head, ...tail] = path;
  if (!head || !Object.prototype.hasOwnProperty.call(source, head)) return source;
  if (tail.length === 0) {
    const next = { ...source };
    delete next[head];
    return next;
  }

  const child = asJsonObject(source[head]);
  const nextChild = removeJsonPathInternal(child, tail);
  if (nextChild === child) return source;
  const next = { ...source };
  if (Object.keys(nextChild).length === 0) {
    delete next[head];
  } else {
    next[head] = nextChild;
  }
  return next;
};

export const removeJsonPath = (
  source: JsonObject,
  path: readonly string[],
): JsonObject => removeJsonPathInternal(source, path);

export const jsonObjectsEqual = (left: JsonObject, right: JsonObject): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

export const parseJsoncObject = (content: string): JsonObject => {
  const errors: ParseError[] = [];
  const value = parse(content.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as JsonValue | undefined;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(first
      ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
      : 'Invalid JSONC');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Configuration root must be an object');
  }
  return value as JsonObject;
};

export const updateJsoncPath = (
  content: string,
  path: readonly string[],
  value: JsonValue | undefined,
): string => {
  const source = content.trim() ? content : '{}\n';
  const edits = modify(source, [...path], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: source.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  return applyEdits(source, edits);
};

export const removeJsoncPath = (
  content: string,
  path: readonly string[],
): string => {
  let next = updateJsoncPath(content, path, undefined);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    const parent = readJsonPath(parseJsoncObject(next), parentPath);
    if (
      typeof parent !== 'object'
      || parent === null
      || Array.isArray(parent)
      || Object.keys(parent).length > 0
    ) break;
    next = updateJsoncPath(next, parentPath, undefined);
  }
  return next;
};

export const validString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
);

export const validBoolean = (value: JsonValue | undefined): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

export const validFiniteNumber = (value: JsonValue | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

export const validStringArray = (value: JsonValue | undefined): string[] | undefined => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : undefined
);

export const normalizeCommandWords = (value: string): string[] => {
  const words = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(words)];
};

export const invalidCommandWords = (words: readonly string[]): string[] => (
  words.filter((word) => !/^[A-Za-z0-9_-]+$/.test(word))
);
