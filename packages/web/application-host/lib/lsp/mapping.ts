import path from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
export interface LanguagePosition { character: number; line: number }
export interface LanguageRange { end: LanguagePosition; start: LanguagePosition }
export interface LanguageResource { resourceId: string; workspaceId: string }
export interface MappingContext {
  pathModule: typeof path;
  root: string;
  workspaceId: string;
}
interface DiagnosticContext extends MappingContext {
  documentVersion: number | null;
  generation: number;
  providerId: string;
  resource: LanguageResource;
  severity(value: unknown): unknown;
  onRejectedLocation?: (reason: 'outOfScope' | 'unmappable') => void;
}
interface CodeActionContext extends MappingContext { diagnosticContext: DiagnosticContext }

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const recordOrEmpty = (value: unknown): JsonRecord => isRecord(value) ? value : {};

export class LanguageMappingError extends Error {
  reason: string;
  constructor(message: string, reason = 'request-failed') {
    super(message);
    this.name = 'LanguageMappingError';
    this.reason = reason;
  }
}

export const mapPosition = (value: unknown): LanguagePosition | null => (
  isRecord(value) && finiteInteger(value.line) && finiteInteger(value.character)
    ? { line: value.line, character: value.character }
    : null
);

export const mapRange = (value: unknown): LanguageRange | null => {
  const record = recordOrEmpty(value);
  const start = mapPosition(record.start);
  const end = mapPosition(record.end);
  return start && end ? { start, end } : null;
};

const jsonArguments = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

export const mapCommand = (value: unknown) => {
  if (!isRecord(value) || typeof value.command !== 'string' || typeof value.title !== 'string') return undefined;
  const args = jsonArguments(value.arguments);
  return {
    title: value.title,
    command: value.command,
    ...(args ? { arguments: args } : {}),
  };
};

export const mapMarkup = (value: unknown) => {
  if (typeof value === 'string') return { kind: 'plaintext', value };
  if (!isRecord(value) || typeof value.value !== 'string') return null;
  if (value.kind === 'markdown' || value.kind === 'plaintext') {
    return { kind: value.kind, value: value.value };
  }
  if (typeof value.language === 'string') {
    return {
      kind: 'markdown',
      value: `\`\`\`${value.language.replace(/`/g, '')}\n${value.value}\n\`\`\``,
    };
  }
  return { kind: 'plaintext', value: value.value };
};

export const mapMarkupArray = (value: unknown) => {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => (
    typeof item === 'string' ? { kind: 'markdown', value: item } : mapMarkup(item)
  )).filter(Boolean);
};

export const resourceFromUri = (
  uri: unknown,
  workspaceId: string,
  root: string,
  pathModule: typeof path = path,
): LanguageResource | null => {
  if (typeof uri !== 'string' || !uri) return null;
  let absolutePath;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;
  return { workspaceId, resourceId: relative.split(pathModule.sep).join('/') };
};

/** Internal projection hook: expose an omitted location without returning an unauthorized URI. */
export const validLanguageRange = (value: unknown): boolean => {
  const range = mapRange(value);
  return !!range && (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
};
export const strictLocationRejection = (value: unknown, root: string, pathModule: typeof path = path, link = false): 'outOfScope' | 'unmappable' | undefined => {
  const item = recordOrEmpty(value);
  const uri = link ? item.targetUri ?? item.uri : item.uri ?? item.targetUri;
  if (typeof uri !== 'string') return 'unmappable';
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.search || url.hash) return 'unmappable';
    const relative = pathModule.relative(root, fileURLToPath(url));
    if (relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) return 'outOfScope';
    if (!relative) return 'unmappable';
  } catch { return 'unmappable'; }
  const range = link ? item.targetRange ?? item.range ?? item.targetSelectionRange : item.range ?? item.targetRange ?? item.targetSelectionRange;
  if (!validLanguageRange(range) || (link && !validLanguageRange(item.targetSelectionRange ?? item.targetRange ?? item.range))
    || (link && item.originSelectionRange !== undefined && !validLanguageRange(item.originSelectionRange))) return 'unmappable';
  return undefined;
};

export const rejectedLocationReason = (value: unknown, root: string, pathModule: typeof path = path): 'outOfScope' | 'unmappable' => {
  const record = recordOrEmpty(value);
  const uri = record.targetUri ?? record.uri;
  if (typeof uri !== 'string') return 'unmappable';
  try {
    const relative = pathModule.relative(root, fileURLToPath(uri));
    return relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative) ? 'outOfScope' : 'unmappable';
  } catch { return 'unmappable'; }
};

export const mapLocation = (value: unknown, workspaceId: string, root: string, pathModule: typeof path = path) => {
  const record = recordOrEmpty(value);
  const resource = resourceFromUri(record.uri ?? record.targetUri, workspaceId, root, pathModule);
  const range = mapRange(record.range ?? record.targetRange ?? record.targetSelectionRange);
  return resource && range ? { resource, range } : null;
};

export const mapLocationLink = (value: unknown, workspaceId: string, root: string, pathModule: typeof path = path) => {
  const record = recordOrEmpty(value);
  const resource = resourceFromUri(record.targetUri ?? record.uri, workspaceId, root, pathModule);
  const targetRange = mapRange(record.targetRange ?? record.range ?? record.targetSelectionRange);
  const targetSelectionRange = mapRange(record.targetSelectionRange ?? record.targetRange ?? record.range);
  const originSelectionRange = mapRange(record.originSelectionRange);
  if (!resource || !targetRange || !targetSelectionRange) return null;
  return {
    resource,
    targetRange,
    targetSelectionRange,
    ...(originSelectionRange ? { originSelectionRange } : {}),
  };
};

/**
 * CallHierarchyItem (LSP 3.17): `uri` maps to a workspace resource; `data` is
 * the server's opaque round-trip token and is kept so incoming/outgoing calls
 * can hand the item back verbatim.
 */
export const mapCallHierarchyItem = (value: unknown, workspaceId: string, root: string, pathModule: typeof path = path) => {
  const record = recordOrEmpty(value);
  const resource = resourceFromUri(record.uri, workspaceId, root, pathModule);
  const range = mapRange(record.range);
  const selectionRange = mapRange(record.selectionRange);
  if (!resource || !range || !selectionRange || typeof record.name !== 'string') return null;
  return {
    name: record.name,
    kind: record.kind,
    resource,
    range,
    selectionRange,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
};

export const mapTextEdit = (value: unknown) => {
  const record = recordOrEmpty(value);
  const range = mapRange(record.range);
  if (!range || typeof record.newText !== 'string') return null;
  return {
    range,
    newText: record.newText,
    ...(typeof record.annotationId === 'string' ? { annotationId: record.annotationId } : {}),
  };
};

const mapInsertReplaceEdit = (value: unknown) => {
  const record = recordOrEmpty(value);
  const insert = mapRange(record.insert);
  const replace = mapRange(record.replace);
  if (!insert || !replace || typeof record.newText !== 'string') return null;
  return { insert, replace, newText: record.newText };
};

const completionTextEdit = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  return mapTextEdit(value) ?? mapInsertReplaceEdit(value) ?? undefined;
};

export const mapCompletionItem = (item: unknown, resolveToken?: string | undefined) => {
  if (!isRecord(item) || typeof item.label !== 'string' || !item.label) return null;
  const textEdit = completionTextEdit(item.textEdit);
  const additionalTextEdits = Array.isArray(item.additionalTextEdits)
    ? item.additionalTextEdits.map(mapTextEdit).filter(Boolean)
    : undefined;
  const documentation = mapMarkup(item.documentation);
  const command = mapCommand(item.command);
  return {
    label: item.label,
    ...(finiteInteger(item.kind) ? { kind: item.kind } : {}),
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    ...(typeof item.insertText === 'string' ? { insertText: item.insertText } : {}),
    ...(item.insertTextFormat === 2 ? { insertTextFormat: 'snippet' } : item.insertTextFormat === 1 ? { insertTextFormat: 'plain' } : {}),
    ...(documentation ? { documentation } : {}),
    ...(typeof item.sortText === 'string' ? { sortText: item.sortText } : {}),
    ...(typeof item.filterText === 'string' ? { filterText: item.filterText } : {}),
    ...(item.preselect === true ? { preselect: true } : {}),
    ...(item.deprecated === true ? { deprecated: true } : {}),
    ...(Array.isArray(item.commitCharacters) ? { commitCharacters: item.commitCharacters.filter((value): value is string => typeof value === 'string') } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags.filter(finiteInteger) } : {}),
    ...(textEdit ? { textEdit } : {}),
    ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
    ...(command ? { command } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapHover = (raw: unknown) => {
  if (!isRecord(raw)) return null;
  const contents = mapMarkupArray(raw.contents);
  if (contents.length === 0) return null;
  const range = mapRange(raw.range);
  return {
    contents,
    ...(range ? { range } : {}),
  };
};

const mapSignatureParameter = (value: unknown) => {
  if (!isRecord(value)) return null;
  const label = typeof value.label === 'string'
    ? value.label
    : Array.isArray(value.label) && value.label.length === 2 && value.label.every(finiteInteger)
      ? [value.label[0], value.label[1]]
      : null;
  if (!label) return null;
  const documentation = mapMarkup(value.documentation);
  return { label, ...(documentation ? { documentation } : {}) };
};

export const mapSignatureHelp = (raw: unknown) => {
  if (!isRecord(raw) || !Array.isArray(raw.signatures)) return null;
  const signatures = raw.signatures.map((signature: unknown) => {
    if (!isRecord(signature) || typeof signature.label !== 'string') return null;
    const documentation = mapMarkup(signature.documentation);
    const parameters = Array.isArray(signature.parameters)
      ? signature.parameters.map(mapSignatureParameter).filter(Boolean)
      : [];
    return {
      label: signature.label,
      parameters,
      ...(documentation ? { documentation } : {}),
      ...(finiteInteger(signature.activeParameter) ? { activeParameter: signature.activeParameter } : {}),
    };
  }).filter(Boolean);
  return {
    signatures,
    activeSignature: finiteInteger(raw.activeSignature) ? raw.activeSignature : 0,
    activeParameter: finiteInteger(raw.activeParameter) ? raw.activeParameter : 0,
  };
};

const mapSymbol = (value: unknown, context: MappingContext): JsonRecord | null => {
  if (!isRecord(value) || typeof value.name !== 'string' || !finiteInteger(value.kind)) return null;
  const location = value.location ? mapLocation(value.location, context.workspaceId, context.root, context.pathModule) : null;
  const locationRecord = isRecord(value.location) ? value.location : null;
  const range = mapRange(value.range ?? locationRecord?.range) ?? location?.range;
  if (!range) return null;
  const selectionRange = mapRange(value.selectionRange);
  const children = Array.isArray(value.children)
    ? value.children.map((child: unknown) => mapSymbol(child, context)).filter((child): child is JsonRecord => Boolean(child))
    : undefined;
  return {
    name: value.name,
    kind: value.kind,
    range,
    ...(selectionRange ? { selectionRange } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.containerName === 'string' ? { containerName: value.containerName } : {}),
    ...(Array.isArray(value.tags) ? { tags: value.tags.filter(finiteInteger) } : {}),
    ...(location ? { resource: location.resource } : {}),
    ...(children?.length ? { children } : {}),
  };
};

export const mapSymbols = (raw: unknown, context: MappingContext) => (
  (Array.isArray(raw) ? raw : []).map((value: unknown) => mapSymbol(value, context)).filter(Boolean)
);

const mapChangeAnnotations = (value: unknown): Record<string, JsonRecord> | undefined => {
  if (!isRecord(value)) return undefined;
  const result: Record<string, JsonRecord> = {};
  for (const [id, annotation] of Object.entries(value)) {
    if (!isRecord(annotation) || typeof annotation.label !== 'string') continue;
    result[id] = {
      label: annotation.label,
      ...(typeof annotation.description === 'string' ? { description: annotation.description } : {}),
      ...(annotation.needsConfirmation === true ? { needsConfirmation: true } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

export const mapWorkspaceEdit = (raw: unknown, context: MappingContext) => {
  if (!isRecord(raw)) return null;
  const documentChanges: JsonRecord[] = [];
  const requireResource = (uri: unknown): LanguageResource => {
    const resource = resourceFromUri(uri, context.workspaceId, context.root, context.pathModule);
    if (!resource) {
      throw new LanguageMappingError('Workspace edit targets an unsupported resource', 'unsupported');
    }
    return resource;
  };
  const requireEdits = (values: unknown) => {
    if (!Array.isArray(values)) throw new LanguageMappingError('Workspace edit contains invalid text edits');
    const edits = values.map(mapTextEdit);
    if (edits.some((edit) => !edit)) throw new LanguageMappingError('Workspace edit contains an invalid text edit');
    return edits.filter((edit): edit is NonNullable<ReturnType<typeof mapTextEdit>> => Boolean(edit));
  };
  if (isRecord(raw.changes)) {
    for (const [uri, values] of Object.entries(raw.changes)) {
      const resource = requireResource(uri);
      const edits = requireEdits(values);
      documentChanges.push({ kind: 'text', resource, version: null, edits });
    }
  }
  if (Array.isArray(raw.documentChanges)) {
    for (const change of raw.documentChanges) {
      if (!isRecord(change)) continue;
      if (isRecord(change.textDocument) && typeof change.textDocument.uri === 'string') {
        const resource = requireResource(change.textDocument.uri);
        documentChanges.push({
          kind: 'text',
          resource,
          version: Number.isInteger(change.textDocument.version) ? change.textDocument.version : null,
          edits: requireEdits(change.edits),
        });
        continue;
      }
      if (change.kind === 'create') {
        const resource = requireResource(change.uri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'create',
          resource,
          ...(options.overwrite === true ? { overwrite: true } : {}),
          ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      } else if (change.kind === 'rename') {
        const from = requireResource(change.oldUri);
        const to = requireResource(change.newUri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'rename',
          from,
          to,
          ...(options.overwrite === true ? { overwrite: true } : {}),
          ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      } else if (change.kind === 'delete') {
        const resource = requireResource(change.uri);
        const options = isRecord(change.options) ? change.options : {};
        documentChanges.push({
          kind: 'delete',
          resource,
          ...(options.recursive === true ? { recursive: true } : {}),
          ...(options.ignoreIfNotExists === true ? { ignoreIfNotExists: true } : {}),
          ...(typeof change.annotationId === 'string' ? { annotationId: change.annotationId } : {}),
        });
      }
    }
  }
  const changeAnnotations = mapChangeAnnotations(raw.changeAnnotations);
  return { documentChanges, ...(changeAnnotations ? { changeAnnotations } : {}) };
};

export const mapDiagnostic = (diagnostic: unknown, context: DiagnosticContext) => {
  const record = recordOrEmpty(diagnostic);
  const range = mapRange(record.range) ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  const relatedInformation = Array.isArray(record.relatedInformation)
    ? record.relatedInformation.map((item: unknown) => {
        const itemRecord = recordOrEmpty(item);
        const location = mapLocation(itemRecord.location, context.workspaceId, context.root, context.pathModule);
        if (!location) context.onRejectedLocation?.(rejectedLocationReason(itemRecord.location, context.root, context.pathModule));
        return location && typeof itemRecord.message === 'string' ? { location, message: itemRecord.message } : null;
      }).filter(Boolean)
    : undefined;
  return {
    resource: context.resource,
    documentVersion: context.documentVersion,
    severity: context.severity(record.severity),
    message: typeof record.message === 'string' ? record.message : 'Diagnostic',
    range,
    ...(typeof record.code === 'string' || typeof record.code === 'number' ? { code: record.code } : {}),
    ...(typeof record.source === 'string' ? { source: record.source } : {}),
    ...(Array.isArray(record.tags) ? { tags: record.tags.filter(finiteInteger) } : {}),
    ...(relatedInformation?.length ? { relatedInformation } : {}),
    providerId: context.providerId,
    generation: context.generation,
  };
};

export const mapCodeAction = (value: unknown, context: CodeActionContext, resolveToken?: string | undefined) => {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title) return null;
  const edit = mapWorkspaceEdit(value.edit, context);
  const command = mapCommand(isRecord(value.command)
    ? value.command
    : typeof value.command === 'string'
      ? value
      : null);
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.map((diagnostic: unknown) => mapDiagnostic(diagnostic, context.diagnosticContext))
    : undefined;
  const disabled = recordOrEmpty(value.disabled);
  return {
    title: value.title,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(value.isPreferred === true ? { isPreferred: true } : {}),
    ...(typeof disabled.reason === 'string' ? { disabledReason: disabled.reason } : {}),
    ...(diagnostics?.length ? { diagnostics } : {}),
    ...(edit ? { edit } : {}),
    ...(command ? { command } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapInlayHint = (value: unknown, context: MappingContext, resolveToken?: string | undefined) => {
  const record = recordOrEmpty(value);
  const position = mapPosition(record.position);
  if (!position) return null;
  let label;
  if (typeof record.label === 'string') label = record.label;
  else if (Array.isArray(record.label)) {
    label = record.label.map((part: unknown) => {
      if (!isRecord(part) || typeof part.value !== 'string') return null;
      const tooltip = mapMarkup(part.tooltip);
      const location = mapLocation(part.location, context.workspaceId, context.root, context.pathModule);
      const command = mapCommand(part.command);
      return {
        value: part.value,
        ...(tooltip ? { tooltip } : {}),
        ...(location ? { location } : {}),
        ...(command ? { command } : {}),
      };
    }).filter(Boolean);
  }
  if (typeof label !== 'string' && !Array.isArray(label)) return null;
  const tooltip = mapMarkup(record.tooltip);
  const textEdits = Array.isArray(record.textEdits) ? record.textEdits.map(mapTextEdit).filter(Boolean) : undefined;
  return {
    position,
    label,
    ...(record.kind === 1 ? { kind: 'type' } : record.kind === 2 ? { kind: 'parameter' } : {}),
    ...(tooltip ? { tooltip } : {}),
    ...(textEdits?.length ? { textEdits } : {}),
    ...(record.paddingLeft === true ? { paddingLeft: true } : {}),
    ...(record.paddingRight === true ? { paddingRight: true } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export const mapDocumentLink = (value: unknown, context: MappingContext, resolveToken?: string | undefined) => {
  const record = recordOrEmpty(value);
  const range = mapRange(record.range);
  if (!range) return null;
  let target;
  if (typeof record.target === 'string') {
    const resource = resourceFromUri(record.target, context.workspaceId, context.root, context.pathModule);
    target = resource ? { kind: 'resource', resource } : { kind: 'uri', uri: record.target };
  }
  return {
    range,
    ...(target ? { target } : {}),
    ...(typeof record.tooltip === 'string' ? { tooltip: record.tooltip } : {}),
    ...(resolveToken ? { resolveToken } : {}),
  };
};

export interface SelectionRangeResult { range: LanguageRange; parent?: SelectionRangeResult | undefined }
export const mapSelectionRange = (value: unknown): SelectionRangeResult | null => {
  const record = recordOrEmpty(value);
  const range = mapRange(record.range);
  if (!range) return null;
  const parent: SelectionRangeResult | null = record.parent ? mapSelectionRange(record.parent) : null;
  return { range, ...(parent ? { parent } : {}) };
};

export const mapDocumentHighlight = (value: unknown) => {
  const record = recordOrEmpty(value);
  const range = mapRange(record.range);
  if (!range) return null;
  return {
    range,
    ...(record.kind === 1 ? { kind: 'text' } : record.kind === 2 ? { kind: 'read' } : record.kind === 3 ? { kind: 'write' } : {}),
  };
};

export const mapFoldingRange = (value: unknown) => {
  const record = recordOrEmpty(value);
  if (!finiteInteger(record.startLine) || !finiteInteger(record.endLine)) return null;
  return {
    startLine: record.startLine,
    endLine: record.endLine,
    ...(finiteInteger(record.startCharacter) ? { startCharacter: record.startCharacter } : {}),
    ...(finiteInteger(record.endCharacter) ? { endCharacter: record.endCharacter } : {}),
    ...(record.kind === 'comment' || record.kind === 'imports' || record.kind === 'region' ? { kind: record.kind } : {}),
  };
};

export const mapColorInformation = (value: unknown) => {
  const record = recordOrEmpty(value);
  const range = mapRange(record.range);
  const color = record.color;
  if (!range || !isRecord(color) || ![color.red, color.green, color.blue, color.alpha]
    .every((channel) => typeof channel === 'number' && Number.isFinite(channel))) return null;
  return {
    range,
    color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
  };
};

export const mapColorPresentation = (value: unknown) => {
  if (!isRecord(value) || typeof value.label !== 'string') return null;
  const textEdit = mapTextEdit(value.textEdit);
  const additionalTextEdits = Array.isArray(value.additionalTextEdits)
    ? value.additionalTextEdits.map(mapTextEdit).filter(Boolean)
    : undefined;
  return {
    label: value.label,
    ...(textEdit ? { textEdit } : {}),
    ...(additionalTextEdits?.length ? { additionalTextEdits } : {}),
  };
};

export const mapTextEdits = (raw: unknown) => (Array.isArray(raw) ? raw.map(mapTextEdit).filter(Boolean) : []);
