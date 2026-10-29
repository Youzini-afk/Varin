import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';

export const VARIN_BUILTIN_OFFICE_EXTENSION_ID = 'varin.builtin.office';
export const OFFICE_CAPABILITY = 'office.files';
const text = { type: 'string', minLength: 1 }, string = { type: 'string' }, number = { type: 'number' };
const positive = { type: 'number', exclusiveMinimum: 0 }, integer = { type: 'integer', minimum: 0 };
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: JsonObject): JsonObject => ({ type: 'array', items });
const rows = array(array(string));
const values = array(array({ anyOf: [string, number, { type: 'boolean' }, { type: 'null' }, object({ formula: text }, ['formula'])] }));
const geometry = { x: number, y: number, width: positive, height: positive };
const create: JsonObject = { oneOf: [
  object({ format: { const: 'docx' }, title: text, font: text, blocks: array({ oneOf: [
    object({ kind: { const: 'paragraph' }, text: string, runs: array(object({ text: string, bold: { type: 'boolean' }, italic: { type: 'boolean' }, font: text, size: positive, color: text }, ['text'])),
      heading: { type: 'integer', minimum: 1, maximum: 9 }, bullet: { type: 'boolean' }, style: text, alignment: { enum: ['left', 'center', 'right', 'justify'] } }, ['kind']),
    object({ kind: { const: 'table' }, rows, header: { type: 'boolean' } }, ['kind', 'rows']),
  ] }) }, ['format', 'blocks']),
  object({ format: { const: 'xlsx' }, sheets: array(object({ name: text, rows: values, header: { type: 'boolean' }, widths: array(positive),
    numberFormats: { type: 'object', additionalProperties: string }, freezeRows: integer }, ['name', 'rows'])) }, ['format', 'sheets']),
  object({ format: { const: 'pptx' }, title: text, width: positive, height: positive, slides: array(object({ background: text, notes: string, objects: array({ oneOf: [
    object({ kind: { const: 'text' }, text: string, ...geometry, fontSize: positive, fontFace: text, bold: { type: 'boolean' }, color: text, align: { enum: ['left', 'center', 'right'] } }, ['kind', 'text', 'x', 'y', 'width', 'height']),
    object({ kind: { const: 'table' }, rows, ...geometry, fontSize: positive }, ['kind', 'rows', 'x', 'y', 'width']),
    object({ kind: { const: 'image' }, path: text, ...geometry }, ['kind', 'path', 'x', 'y', 'width', 'height']),
    object({ kind: { const: 'chart' }, type: { enum: ['bar', 'line', 'pie', 'area', 'scatter'] }, ...geometry,
      series: array(object({ name: text, labels: array(string), values: array(number) }, ['name', 'labels', 'values'])) }, ['kind', 'type', 'series', 'x', 'y', 'width', 'height']),
  ] }) }, ['objects'])) }, ['format', 'slides']),
] };
const edits = array({ oneOf: [
  object({ action: { const: 'replace_text' }, objectId: text, oldText: text, newText: string, all: { type: 'boolean' } }, ['action', 'objectId', 'oldText', 'newText']),
  object({ action: { const: 'set_text' }, objectId: text, text: string }, ['action', 'objectId', 'text']),
  object({ action: { const: 'insert_paragraph' }, afterId: text, text: string, style: text }, ['action', 'afterId', 'text']),
  object({ action: { const: 'set_cells' }, sheet: text, start: text, values, numberFormat: text, copyStyleFrom: text }, ['action', 'sheet', 'start', 'values']),
  object({ action: { const: 'add_sheet' }, name: text }, ['action', 'name']),
  object({ action: { const: 'move_shape' }, objectId: text, ...geometry }, ['action', 'objectId']),
] });
const source: JsonObject = { path: text, snapshotId: text };
const exactlyOneSource = { oneOf: [{ required: ['path'], not: { required: ['snapshotId'] } }, { required: ['snapshotId'], not: { required: ['path'] } }] };
const declaration = (method: string, description: string, inputSchema: JsonObject, operation: 'read' | 'effect' = 'read', physical = false): VarinExtensionServiceProvision => ({
  id: `varin.office.${method}`, version: 1,
  tool: { name: `office_${method}`, description, inputSchema, operation, completion: 'result', outputSchema: { type: 'object' },
    disclosure: { summary: ({read:'Read Office structure, paragraphs, cells, shapes and revision-bound objects.',write:'Create, replace or edit DOCX, XLSX and PPTX files.',render:'Render Office files through the available LibreOffice engine.',export:'Convert Office formats and recalculate spreadsheets through LibreOffice.',environment:'Inspect Office libraries, renderer availability and supported operations.'} as Record<string,string>)[method]!,
      aliases:['Office','办公','文档','表格','演示'], namespace:'office',
      ...(method === 'write' ? { operations: [
        ...['create','replace'].flatMap((action,index) => [
          {name:action, description:`${action} an Office file; all content formats.`, paths:[`/oneOf/${index}`]},
          ...['docx','xlsx','pptx'].map((format,formatIndex) => ({name:`${action}.${format}`,description:`${action} ${format.toUpperCase()} content.`,paths:[`/oneOf/${index}`,`/$defs/content/oneOf/${formatIndex}`]})),
        ]),
        {name:'edit',description:'Edit an existing revision; all supported edit actions.',paths:['/oneOf/2']},
        ...['replace_text','set_text','insert_paragraph','set_cells','add_sheet','move_shape'].map((action,index) => ({name:`edit.${action}`,description:`Edit action ${action}.`,paths:['/oneOf/2',`/$defs/edits/items/oneOf/${index}`]})),
      ] } : {}) },
    ...(physical ? { requirements: { source: 'physical' as const, process: false } } : {}) },
});

export const OFFICE_TOOL_DECLARATIONS = [
  declaration('read', 'Read DOCX, XLSX or PPTX structure from a source-relative path or a fixed snapshotId. Overview lists sections; content returns paragraphs, cells, shapes and notes with revision-bound object IDs. Select a section, objectId, worksheet range or query; offset/limit continue results. Formulas and cached values are distinct; a stored cache is not a new calculation. Use document_read for PDF pages.', {
    ...object({ ...source, view: { enum: ['overview', 'content', 'find'] }, section: text, objectId: text, range: text, query: text, offset: integer, limit: { type: 'integer', minimum: 1 } }), ...exactlyOneSource,
  }),
  declaration('write', 'Create an editable Office file or edit an existing revision in place. edit requires expectedRevision from office_read; object IDs belong to that revision. Text edits preserve surrounding runs and unrelated package parts. Worksheet edits clear stale formula caches and request recalculation; office_export through LibreOffice performs actual recalculation. PPTX coordinates are inches, DOCX font sizes are points. create only writes a missing path; replace explicitly replaces a known revision with new content.', { $defs:{content:create,edits}, oneOf: [
    object({ action: { const: 'create' }, path: text, content: {$ref:'#/$defs/content'} }, ['action', 'path', 'content']),
    object({ action: { const: 'replace' }, path: text, expectedRevision: text, content: {$ref:'#/$defs/content'} }, ['action', 'path', 'expectedRevision', 'content']),
    object({ action: { const: 'edit' }, path: text, expectedRevision: text, edits:{$ref:'#/$defs/edits'} }, ['action', 'path', 'expectedRevision', 'edits']),
  ] }, 'effect', true),
  declaration('render', 'Render real Office pages through the Host’s available LibreOffice engine and return a PDF snapshot or actual page images. Reuse the returned PDF snapshotId with document_read for additional pages. Rendering availability is independent of structure reading and local edits; office_environment reports the installed engine.', {
    ...object({ ...source, page: { type: 'integer', minimum: 1 }, scale: positive }), ...exactlyOneSource,
  }),
  declaration('export', 'Convert an input Office file (sourcePath or snapshotId, exactly one) using LibreOffice and save it to the separate output destination path. Exporting XLSX to XLSX also recalculates formulas. expectedRevision is required to replace an existing destination; omitting it creates a new file. The result identifies the engine and the committed file revision.', { ...object({
    sourcePath: { ...text, description: 'Input source-relative file path; choose sourcePath or snapshotId.' },
    snapshotId: { ...text, description: 'Input snapshot; choose snapshotId or sourcePath.' },
    path: { ...text, description: 'Output destination file path, distinct from the input sourcePath or snapshotId.' },
    expectedRevision: text, format: { enum: ['pdf', 'docx', 'xlsx', 'pptx', 'csv'] },
  }, ['path', 'format']), oneOf: [{ required: ['sourcePath'], not: { required: ['snapshotId'] } }, { required: ['snapshotId'], not: { required: ['sourcePath'] } }] } as JsonObject, 'effect', true),
  declaration('environment', 'Inspect the reusable Office environment: available format operations, bundled library module paths for JavaScript work, and the actual local LibreOffice renderer. Advanced application operations are available through computer_office on supported connected desktops; process and script tools remain usable for tasks beyond these format operations.', object({})),
] as const;
