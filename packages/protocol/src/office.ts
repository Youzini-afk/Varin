export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export const OFFICE_FORMAT_MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
export type DocumentMimeType = 'application/pdf' | (typeof OFFICE_FORMAT_MIME_TYPES)[OfficeFormat];
export const DOCUMENT_MIME_TYPES: readonly DocumentMimeType[] = ['application/pdf', ...Object.values(OFFICE_FORMAT_MIME_TYPES)];
export const DOCUMENT_FILE_ACCEPT = '.pdf,.docx,.xlsx,.pptx,application/pdf';
export function documentMimeType(filename: string, mime = ''): DocumentMimeType | undefined {
  if (DOCUMENT_MIME_TYPES.includes(mime as DocumentMimeType)) return mime as DocumentMimeType;
  const extension = filename.split('.').at(-1)?.toLowerCase();
  return extension === 'pdf' ? 'application/pdf' : extension && Object.hasOwn(OFFICE_FORMAT_MIME_TYPES, extension) ? OFFICE_FORMAT_MIME_TYPES[extension as OfficeFormat] : undefined;
}
export type OfficeCellValue = string | number | boolean | null | { formula: string };
export interface OfficeReadRequest {
  path?: string;
  snapshotId?: string;
  view?: 'overview' | 'content' | 'find';
  section?: string;
  objectId?: string;
  range?: string;
  query?: string;
  offset?: number;
  limit?: number;
}
export interface OfficeObject {
  id: string;
  kind: 'paragraph' | 'table' | 'cell' | 'shape' | 'picture' | 'chart' | 'notes' | 'comment';
  text?: string;
  style?: Record<string, unknown>;
  value?: string | number | boolean | null;
  formula?: { text: string; kind?: string; sharedIndex?: string; range?: string };
  cachedValue?: string | number | boolean | null;
  calculation?: 'stored-unverified' | 'needs-recalculation';
  address?: string;
  rows?: { cells: { text: string; objectIds: string[]; columnSpan?: number; verticalMerge?: string }[] }[];
  geometry?: { x: number; y: number; width: number; height: number; unit: 'inch'; space?: 'slide' | 'group' };
  chart?: { type?: string; series: { name: string; categories: string[]; values: (number | null)[]; formulas: string[] }[] };
  references?: { kind: string; target: string; external?: boolean }[];
}
export interface OfficeSection { id: string; name: string; kind: 'document' | 'header' | 'footer' | 'comments' | 'worksheet' | 'slide' | 'notes' }
export interface OfficeReadResult {
  status: 'ok';
  format: OfficeFormat;
  revision: string;
  sections: OfficeSection[];
  objects?: OfficeObject[];
  offset?: number;
  nextOffset?: number;
  total?: number;
  warnings?: string[];
  snapshotId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}
export type OfficeEdit =
  | { action: 'replace_text'; objectId: string; oldText: string; newText: string; all?: boolean }
  | { action: 'set_text'; objectId: string; text: string }
  | { action: 'insert_paragraph'; afterId: string; text: string; style?: string }
  | { action: 'set_cells'; sheet: string; start: string; values: OfficeCellValue[][]; numberFormat?: string; copyStyleFrom?: string }
  | { action: 'add_sheet'; name: string }
  | { action: 'move_shape'; objectId: string; x?: number; y?: number; width?: number; height?: number };
export interface OfficeTextRun { text: string; bold?: boolean; italic?: boolean; font?: string; size?: number; color?: string }
export type OfficeDocumentBlock =
  | { kind: 'paragraph'; text?: string; runs?: OfficeTextRun[]; heading?: number; bullet?: boolean; style?: string; alignment?: 'left' | 'center' | 'right' | 'justify' }
  | { kind: 'table'; rows: string[][]; header?: boolean };
export interface OfficeWorkbookSheet {
  name: string;
  rows: OfficeCellValue[][];
  header?: boolean;
  widths?: number[];
  numberFormats?: Record<string, string>;
  freezeRows?: number;
}
export type OfficeSlideObject =
  | { kind: 'text'; text: string; x: number; y: number; width: number; height: number; fontSize?: number; fontFace?: string; bold?: boolean; color?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'table'; rows: string[][]; x: number; y: number; width: number; height?: number; fontSize?: number }
  | { kind: 'image'; path: string; x: number; y: number; width: number; height: number }
  | { kind: 'chart'; type: 'bar' | 'line' | 'pie' | 'area' | 'scatter'; series: { name: string; labels: string[]; values: number[] }[]; x: number; y: number; width: number; height: number };
export type OfficeCreateContent =
  | { format: 'docx'; title?: string; font?: string; blocks: OfficeDocumentBlock[] }
  | { format: 'xlsx'; sheets: OfficeWorkbookSheet[] }
  | { format: 'pptx'; title?: string; width?: number; height?: number; slides: { objects: OfficeSlideObject[]; notes?: string; background?: string }[] };
