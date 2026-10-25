/** Local edits keep every unmodified OOXML part, relationship and embedded object. */
import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer, type XmlDocument as Document, type XmlElement as Element, type XmlNode as Node } from './xml.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OfficeEdit, OfficeFormat, OfficeObject, OfficeReadRequest, OfficeReadResult, OfficeSection } from '@varin/protocol';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const builtinNumberFormats = createRequire(import.meta.url)('exceljs/lib/xlsx/defaultnumformats.js') as Record<string, { f?: string } & Record<string, string>>;
const all = (node: Document | Element, name: string): Element[] => Array.from(node.getElementsByTagName('*')).filter(value => value.localName === name);
const children = (node: Node, name: string): Element[] => Array.from(node.childNodes).filter((value): value is Element => value.nodeType === 1 && (value as Element).localName === name);
const first = (node: Document | Element, name: string): Element | undefined => all(node, name)[0];
const attr = (node: Element | undefined, name: string): string => node?.getAttribute(name) || node?.getAttribute(`w:${name}`) || '';
const value = (node: Document | Element, name: string): string => attr(first(node, name), 'val');
const leaves = (node: Element): Element[] => all(node, 't').filter(value => {
  for (let parent = value.parentNode; parent && parent !== node; parent = parent.parentNode) if ((parent as Element).localName === 'del') return false;
  return true;
});
const text = (node: Element): string => leaves(node).map(value => value.textContent ?? '').join('');
const revision = (bytes: Uint8Array) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
const coordinates = (address: string): { row: number; column: number } => {
  const match = /^\$?([A-Z]+)\$?([1-9]\d*)$/i.exec(address);
  if (!match) throw new Error(`Invalid worksheet address: ${address}`);
  return { row: Number(match[2]), column: [...match[1]!.toUpperCase()].reduce((column, char) => column * 26 + char.charCodeAt(0) - 64, 0) };
};
const addressOf = (row: number, column: number): string => {
  let letters = '';
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) letters = String.fromCharCode(65 + (rest - 1) % 26) + letters;
  return `${letters}${row}`;
};

export class OfficePackage {
  readonly format: OfficeFormat;
  readonly revision: string;
  private readonly zip: AdmZip;
  private readonly documents = new Map<string, Document>();
  private readonly changed = new Set<string>();
  private readonly targets = new Map<string, { part: string; element: Element }>();
  private readonly notices = new Set<string>();

  constructor(bytes: Uint8Array) {
    this.revision = revision(bytes);
    try { this.zip = new AdmZip(Buffer.from(bytes)); } catch { throw new Error('The document is not a readable Office Open XML package; encrypted or legacy binary files need an Office application'); }
    if (this.zip.getEntry('word/document.xml')) this.format = 'docx';
    else if (this.zip.getEntry('xl/workbook.xml')) this.format = 'xlsx';
    else if (this.zip.getEntry('ppt/presentation.xml')) this.format = 'pptx';
    else throw new Error('This package is not a DOCX, XLSX or PPTX document');
  }
  private xml(part: string): Document {
    const saved = this.documents.get(part);
    if (saved) return saved;
    const entry = this.zip.getEntry(part);
    if (!entry) throw new Error(`The document is missing its ${part} part`);
    let error: string | undefined;
    const bytes = entry.getData();
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const document = new DOMParser({ errorHandler: { warning() {}, error(message) { error = message; }, fatalError(message) { error = message; } } }).parseFromString(source, 'application/xml');
    if (error || !document.documentElement) throw new Error(`Cannot parse document part ${part}: ${error ?? 'missing document element'}`);
    this.documents.set(part, document);
    return document;
  }
  private relationships(part: string): { id: string; type: string; target: string; external: boolean }[] {
    const rels = `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
    if (!this.zip.getEntry(rels) && !this.documents.has(rels)) return [];
    return all(this.xml(rels), 'Relationship').map(element => {
      const external = element.getAttribute('TargetMode') === 'External';
      const raw = element.getAttribute('Target') ?? '';
      const target = external ? raw : raw.startsWith('/') ? raw.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(part), raw));
      if (!external && (target.startsWith('../') || target.includes('\\'))) throw new Error(`Invalid package relationship in ${rels}`);
      return { id: element.getAttribute('Id') ?? '', type: (element.getAttribute('Type') ?? '').split('/').at(-1) ?? '', target, external };
    });
  }
  sections(): OfficeSection[] {
    if (this.format === 'docx') return [
      { id: 'word/document.xml', name: 'Document', kind: 'document' },
      ...this.zip.getEntries().filter(entry => /^word\/(header\d+|footer\d+|comments)\.xml$/.test(entry.entryName)).map(entry => ({
        id: entry.entryName, name: path.posix.basename(entry.entryName, '.xml'),
        kind: entry.entryName.includes('/header') ? 'header' as const : entry.entryName.includes('/footer') ? 'footer' as const : 'comments' as const,
      })),
    ];
    const part = this.format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
    const relationships = this.relationships(part);
    return all(this.xml(part), this.format === 'xlsx' ? 'sheet' : 'sldId').map((element, index) => {
      const id = element.getAttributeNS(R, 'id') || element.getAttribute('r:id');
      const target = relationships.find(rel => rel.id === id && !rel.external)?.target;
      if (!target) throw new Error(`The document is missing the relationship for ${id}`);
      return { id: target, name: this.format === 'xlsx' ? element.getAttribute('name') ?? `Sheet ${index + 1}` : `Slide ${index + 1}`,
        kind: this.format === 'xlsx' ? 'worksheet' : 'slide' };
    });
  }
  private register(part: string, kind: string, key: string | number, element: Element): string {
    const id = `${part}#${kind}:${key}`;
    this.targets.set(id, { part, element });
    return id;
  }
  private paragraphs(part: string): OfficeObject[] {
    return all(this.xml(part), 'p').map((element, index) => ({
      id: this.register(part, 'p', index + 1, element), kind: 'paragraph', text: text(element),
      style: { style: value(element, 'pStyle'), numbering: value(element, 'numId'), level: value(element, 'ilvl'),
        runs: all(element, 'r').map(run => ({ text: text(run), bold: !!first(run, 'b') && !['0', 'false', 'off'].includes(value(run, 'b')),
          italic: !!first(run, 'i') && !['0', 'false', 'off'].includes(value(run, 'i')), font: attr(first(run, 'rFonts'), 'ascii'),
          ...(value(run, 'sz') ? { sizePoints: Number(value(run, 'sz')) / 2 } : {}), color: value(run, 'color') })) },
    }));
  }
  private objects(part: string): OfficeObject[] {
    if (this.format === 'xlsx') return this.cells(part);
    if (this.format === 'docx') {
      const paragraphs = this.paragraphs(part);
      const byElement = new Map([...this.targets].filter(([, target]) => target.part === part).map(([id, target]) => [target.element, id]));
      const tables: OfficeObject[] = all(this.xml(part), 'tbl').map((element, index) => ({
        id: this.register(part, 'table', index + 1, element), kind: 'table',
        rows: children(element, 'tr').map(row => ({ cells: children(row, 'tc').map(cell => ({
          text: all(cell, 'p').map(text).join('\n'), objectIds: all(cell, 'p').map(p => byElement.get(p)!).filter(Boolean),
          ...(value(cell, 'gridSpan') ? { columnSpan: Number(value(cell, 'gridSpan')) } : {}),
          ...(first(cell, 'vMerge') ? { verticalMerge: value(cell, 'vMerge') || 'continue' } : {}),
        })) })),
      }));
      const comments: OfficeObject[] = all(this.xml(part), 'comment').map((element, index) => ({ id: this.register(part, 'comment', index + 1, element), kind: 'comment', text: text(element),
        style: { author: attr(element, 'author'), date: attr(element, 'date'), commentId: attr(element, 'id') } }));
      const entries = new Map([...paragraphs, ...tables, ...comments].map(object => [this.targets.get(object.id)!.element, object]));
      return Array.from(this.xml(part).getElementsByTagName('*')).flatMap(element => {
        const entry = entries.get(element); if (!entry) return [];
        if (comments.length && entry.kind === 'paragraph') return [];
        for (let parent = element.parentNode; parent; parent = parent.parentNode) if (parent.localName === 'tbl') return [];
        return [entry];
      });
    }
    const relationships = this.relationships(part);
    const paragraphIds = new Map(all(this.xml(part), 'p').map((p, index) => [p, this.register(part, 'p', index + 1, p)]));
    const shapes = all(this.xml(part), 'spTree').flatMap(tree => Array.from(tree.childNodes).filter((node): node is Element => node.nodeType === 1 && ['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes((node as Element).localName)));
    const objects: OfficeObject[] = shapes.flatMap(shape => [shape, ...all(shape, 'sp'), ...all(shape, 'pic'), ...all(shape, 'graphicFrame')]).filter((shape, index, values) => values.indexOf(shape) === index).map((element, index) => {
      const properties = first(element, 'cNvPr');
      const id = this.register(part, 'shape', properties?.getAttribute('id') ?? index + 1, element);
      const transform = first(element, 'xfrm');
      const off = transform && first(transform, 'off'), ext = transform && first(transform, 'ext');
      const references = all(element, 'blip').map(ref => ref.getAttributeNS(R, 'embed') || ref.getAttribute('r:embed'))
        .concat(all(element, 'chart').map(ref => ref.getAttributeNS(R, 'id') || ref.getAttribute('r:id')))
        .map(id => relationships.find(rel => rel.id === id)).filter((rel): rel is NonNullable<typeof rel> => !!rel)
        .map(rel => ({ kind: rel.type, target: rel.target, ...(rel.external ? { external: true } : {}) }));
      const chartReference = references.find(reference => reference.kind === 'chart' && !reference.external);
      let chart: OfficeObject['chart'];
      if (chartReference) try { chart = this.chart(chartReference.target); } catch (error) { this.notices.add(`Chart ${chartReference.target}: ${error instanceof Error ? error.message : String(error)}`); }
      return { id, kind: element.localName === 'pic' ? 'picture' : first(element, 'chart') ? 'chart' : first(element, 'tbl') ? 'table' : 'shape', text: all(element, 'p').map(text).join('\n'),
        style: { name: properties?.getAttribute('name'), paragraphs: all(element, 'p').map(p => ({ id: paragraphIds.get(p), text: text(p), level: attr(first(p, 'pPr'), 'lvl'),
          runs: all(p, 'r').map(run => ({ text: text(run), font: attr(first(run, 'latin'), 'typeface'), sizePoints: Number(attr(first(run, 'rPr'), 'sz')) / 100 || undefined })) })) },
        ...(off && ext ? { geometry: { x: Number(off.getAttribute('x')) / 914400, y: Number(off.getAttribute('y')) / 914400,
          width: Number(ext.getAttribute('cx')) / 914400, height: Number(ext.getAttribute('cy')) / 914400, unit: 'inch' as const, space: element.parentNode?.localName === 'grpSp' ? 'group' as const : 'slide' as const } } : {}),
        ...(chart ? { chart } : {}),
        ...(references.length ? { references } : {}),
      };
    });
    const notes = relationships.find(rel => rel.type === 'notesSlide' && !rel.external);
    if (notes) for (const [index, element] of all(this.xml(notes.target), 'sp').entries()) {
      const placeholder = first(element, 'ph');
      if (placeholder && placeholder.getAttribute('type') !== 'body') continue;
      objects.push({ id: this.register(notes.target, 'notes', index + 1, element), kind: 'notes', text: all(element, 'p').map(text).join('\n') });
    }
    return objects;
  }
  private chart(part: string): NonNullable<OfficeObject['chart']> {
    const document = this.xml(part), plot = first(document, 'plotArea');
    const kind = plot && Array.from(plot.childNodes).find((node): node is Element => node.nodeType === 1 && (node as Element).localName.endsWith('Chart'))?.localName;
    const points = (node?: Element) => node ? all(node, 'pt').sort((a, b) => Number(a.getAttribute('idx')) - Number(b.getAttribute('idx'))).map(point => first(point, 'v')?.textContent ?? '') : [];
    return { ...(kind ? { type: kind } : {}), series: all(document, 'ser').map(series => ({
      name: first(first(series, 'tx') ?? series, 'v')?.textContent ?? '',
      categories: points(first(series, 'cat') ?? first(series, 'xVal')),
      values: points(first(series, 'val') ?? first(series, 'yVal')).map(value => value.trim() && Number.isFinite(Number(value)) ? Number(value) : null),
      formulas: all(series, 'f').map(formula => formula.textContent ?? ''),
    })) };
  }
  private cells(part: string): OfficeObject[] {
    const strings = this.zip.getEntry('xl/sharedStrings.xml') ? all(this.xml('xl/sharedStrings.xml'), 'si').map(text) : [];
    const styles = this.zip.getEntry('xl/styles.xml') ? this.xml('xl/styles.xml') : undefined;
    const xfs = styles && first(styles, 'cellXfs');
    const formats = new Map(styles ? all(styles, 'numFmt').map(element => [element.getAttribute('numFmtId'), element.getAttribute('formatCode')]) : []);
    return all(this.xml(part), 'c').map(element => {
      const address = element.getAttribute('r') ?? '';
      const type = element.getAttribute('t') ?? '';
      const raw = first(element, 'v')?.textContent ?? '';
      const stored = type === 's' ? strings[Number(raw)] ?? '' : type === 'inlineStr' ? text(element) : type === 'b' ? raw === '1' : ['str', 'e', 'd'].includes(type) ? raw : raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
      const formula = first(element, 'f');
      const xf = xfs && children(xfs, 'xf')[Number(element.getAttribute('s') || 0)];
      const numberFormatId = xf?.getAttribute('numFmtId') ?? '0';
      const numberFormat = formats.get(numberFormatId) ?? builtinNumberFormats[numberFormatId]?.f;
      return { id: this.register(part, 'cell', address, element), kind: 'cell', address,
        ...(formula ? { formula: { text: formula.textContent ?? '', ...(formula.getAttribute('t') ? { kind: formula.getAttribute('t')! } : {}),
          ...(formula.getAttribute('si') ? { sharedIndex: formula.getAttribute('si')! } : {}), ...(formula.getAttribute('ref') ? { range: formula.getAttribute('ref')! } : {}) },
          cachedValue: stored, calculation: raw === '' ? 'needs-recalculation' as const : 'stored-unverified' as const } : { value: stored }),
        style: { numberFormatId, ...(numberFormat ? { numberFormat } : {}), index: Number(element.getAttribute('s') || 0), type: type || 'n' },
      };
    });
  }
  read(input: OfficeReadRequest = {}): OfficeReadResult {
    const sections = this.sections();
    const result: OfficeReadResult = { status: 'ok', format: this.format, revision: this.revision, sections };
    if (this.format === 'xlsx') result.metadata = {
      dateSystem: ['1', 'true'].includes(attr(first(this.xml('xl/workbook.xml'), 'workbookPr'), 'date1904')) ? '1904' : '1900',
      definedNames: all(this.xml('xl/workbook.xml'), 'definedName').map(element => ({ name: attr(element, 'name'), formula: element.textContent, sheetIndex: attr(element, 'localSheetId') || undefined })),
    };
    else if (this.format === 'pptx') {
      const size = first(this.xml('ppt/presentation.xml'), 'sldSz');
      result.metadata = { size: { width: Number(attr(size, 'cx')) / 914400, height: Number(attr(size, 'cy')) / 914400, unit: 'inch' },
        relatedParts: this.zip.getEntries().filter(entry => /^ppt\/(slideMasters|theme)\/[^/]+\.xml$/.test(entry.entryName)).map(entry => entry.entryName) };
    }
    if ((!input.view || input.view === 'overview') && !input.section && !input.objectId && !input.range && !input.query) return result;
    const selected = input.section ? sections.filter(section => section.id === input.section || section.name === input.section) : sections;
    if (!selected.length) throw new Error(`Unknown document section: ${input.section}`);
    let readableSections = 0;
    let objects = selected.flatMap(section => {
      try { const objects = this.objects(section.id); readableSections++; return objects; }
      catch (error) { if (selected.length === 1) throw error; this.notices.add(`${section.name}: ${error instanceof Error ? error.message : String(error)}`); return []; }
    });
    if (!readableSections) throw new Error(`No selected document section could be read. ${[...this.notices].join('; ')}`);
    if (this.format === 'xlsx' && selected.length === 1) result.metadata = { ...result.metadata,
      dimension: attr(first(this.xml(selected[0]!.id), 'dimension'), 'ref'),
      mergedRanges: all(this.xml(selected[0]!.id), 'mergeCell').map(element => attr(element, 'ref')), relationships: this.relationships(selected[0]!.id),
    };
    if (input.objectId) {
      objects = objects.filter(object => object.id === input.objectId);
      // Table cells retain their own paragraph targets even in the compact table view.
      if (!objects.length && this.format === 'docx') {
        const target = this.target(input.objectId);
        objects = this.paragraphs(target.part).filter(object => object.id === input.objectId);
      }
      if (!objects.length && this.format === 'pptx') {
        const target = this.target(input.objectId);
        if (target.element.localName === 'p') objects = [{ id: input.objectId, kind: 'paragraph', text: text(target.element) }];
      }
    }
    if (input.range) {
      const [from, to = from] = input.range.split(':').map(coordinates);
      objects = objects.filter(object => { if (!object.address) return false; const at = coordinates(object.address); return at.row >= from!.row && at.row <= to!.row && at.column >= from!.column && at.column <= to!.column; });
    }
    if (input.query) { const query = input.query.toLocaleLowerCase(); objects = objects.filter(object =>
      [object.text, object.value, object.formula?.text, object.address, object.rows?.flatMap(row => row.cells.map(cell => cell.text)).join(' '),
        object.chart?.series.map(series => `${series.name} ${series.categories.join(' ')}`).join(' ')].join(' ').toLocaleLowerCase().includes(query)); }
    const offset = input.offset ?? 0, limit = input.limit ?? 80;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Document pagination requires a nonnegative offset and a positive limit');
    return { ...result, objects: objects.slice(offset, offset + limit), offset, total: objects.length, ...(this.notices.size ? { warnings: [...this.notices] } : {}),
      ...(offset + limit < objects.length ? { nextOffset: offset + limit } : {}) };
  }
  private target(id: string): { part: string; element: Element } {
    if (!this.targets.has(id)) for (const section of this.sections()) this.objects(section.id);
    const target = this.targets.get(id);
    if (!target) throw new Error(`The document object is unavailable in this revision: ${id}`);
    return target;
  }
  private replace(target: Element, oldText: string | undefined, newText: string, everywhere = false): void {
    const parts = leaves(target);
    if (!parts.length) throw new Error('This object has no editable text; select a paragraph or a text shape');
    const original = parts.map(part => part.textContent ?? '').join('');
    if (oldText === undefined) { parts[0]!.textContent = newText; for (const part of parts.slice(1)) part.textContent = ''; }
    else {
      if (!oldText) throw new Error('The text to replace must not be empty');
      const matches: number[] = [];
      for (let index = original.indexOf(oldText); index !== -1; index = original.indexOf(oldText, index + oldText.length)) matches.push(index);
      if (!matches.length || matches.length > 1 && !everywhere) throw new Error(matches.length ? 'The text occurs more than once in this object; select all or a narrower object' : 'The text is absent from this object revision');
      for (const start of matches.reverse()) {
        let offset = 0, inserted = false;
        for (const part of parts) {
          const current = part.textContent ?? '', end = offset + current.length;
          if (end > start && offset < start + oldText.length) {
            part.textContent = current.slice(0, Math.max(0, start - offset)) + (!inserted ? newText : '') + current.slice(Math.max(0, start + oldText.length - offset));
            inserted = true;
          }
          offset = end;
        }
      }
    }
    for (const part of parts) part.setAttribute('xml:space', 'preserve');
  }
  edit(edits: OfficeEdit[]): { bytes: Buffer; changedParts: string[]; requiresRecalculation: boolean } {
    let recalculate = false;
    for (const edit of edits) {
      if (edit.action === 'set_cells') { this.setCells(edit); recalculate = true; continue; }
      if (edit.action === 'add_sheet') { this.addSheet(edit.name); continue; }
      const target = this.target(edit.action === 'insert_paragraph' ? edit.afterId : edit.objectId);
      if (edit.action === 'insert_paragraph') {
        if (this.format !== 'docx' || target.element.localName !== 'p') throw new Error('Paragraph insertion requires a DOCX paragraph');
        const doc = target.element.ownerDocument!, p = doc.createElementNS(W, 'w:p');
        const props = children(target.element, 'pPr')[0]?.cloneNode(true);
        if (props) p.appendChild(props);
        if (edit.style) { let pPr = first(p, 'pPr'); if (!pPr) { pPr = doc.createElementNS(W, 'w:pPr'); p.appendChild(pPr); } const style = first(pPr, 'pStyle') ?? doc.createElementNS(W, 'w:pStyle'); style.setAttributeNS(W, 'w:val', edit.style); if (!style.parentNode) pPr.appendChild(style); }
        const r = doc.createElementNS(W, 'w:r'), t = doc.createElementNS(W, 'w:t'); t.setAttribute('xml:space', 'preserve'); t.textContent = edit.text; r.appendChild(t); p.appendChild(r);
        target.element.parentNode!.insertBefore(p, target.element.nextSibling);
      } else if (edit.action === 'move_shape') {
        if (this.format !== 'pptx') throw new Error('Shape geometry belongs to a presentation');
        const transform = first(target.element, 'xfrm'), off = transform && first(transform, 'off'), ext = transform && first(transform, 'ext');
        if (!off || !ext) throw new Error('This shape has no local editable geometry; use its group or the Office application');
        for (const [key, field, node] of [['x', 'x', off], ['y', 'y', off], ['width', 'cx', ext], ['height', 'cy', ext]] as const) {
          const value = edit[key]; if (value !== undefined) { if (!Number.isFinite(value) || (key === 'width' || key === 'height') && value <= 0) throw new Error('Shape dimensions must be positive finite inches'); node.setAttribute(field, String(Math.round(value * 914400))); }
        }
      } else {
        if (this.format === 'xlsx') throw new Error('Use set_cells to preserve worksheet value and formula types');
        this.replace(target.element, edit.action === 'replace_text' ? edit.oldText : undefined, edit.action === 'replace_text' ? edit.newText : edit.text, edit.action === 'replace_text' && edit.all);
      }
      this.changed.add(target.part);
    }
    if (recalculate) this.invalidateFormulaCaches();
    for (const part of this.changed) {
      const xml = new XMLSerializer().serializeToString(this.xml(part)).replace(/^<\?xml[^?]*\?>/, '<?xml version="1.0" encoding="UTF-8"?>');
      this.zip.updateFile(part, Buffer.from(xml));
    }
    return { bytes: this.zip.toBuffer(), changedParts: [...this.changed], requiresRecalculation: recalculate };
  }
  private setCells(edit: Extract<OfficeEdit, { action: 'set_cells' }>): void {
    if (this.format !== 'xlsx') throw new Error('Cell edits require an XLSX workbook');
    const section = this.sections().find(section => section.name === edit.sheet || section.id === edit.sheet);
    if (!section) throw new Error(`Unknown worksheet: ${edit.sheet}`);
    const doc = this.xml(section.id), data = first(doc, 'sheetData');
    if (!data) throw new Error('The worksheet has no sheetData');
    const start = coordinates(edit.start);
    const styleSource = edit.copyStyleFrom ? all(doc, 'c').find(cell => cell.getAttribute('r') === edit.copyStyleFrom!.toUpperCase()) : undefined;
    if (edit.copyStyleFrom && !styleSource) throw new Error(`The style source cell is absent: ${edit.copyStyleFrom}`);
    for (const [rowOffset, values] of edit.values.entries()) for (const [colOffset, value] of values.entries()) {
      const at = addressOf(start.row + rowOffset, start.column + colOffset);
      let row = children(data, 'row').find(row => Number(row.getAttribute('r')) === start.row + rowOffset);
      if (!row) { row = doc.createElementNS(S, 'row'); row.setAttribute('r', String(start.row + rowOffset)); data.insertBefore(row, children(data, 'row').find(next => Number(next.getAttribute('r')) > start.row + rowOffset) ?? null); }
      let cell = children(row, 'c').find(cell => cell.getAttribute('r') === at);
      if (!cell) { cell = doc.createElementNS(S, 'c'); cell.setAttribute('r', at); row.insertBefore(cell, children(row, 'c').find(next => coordinates(next.getAttribute('r')!).column > start.column + colOffset) ?? null); }
      const formula = first(cell, 'f');
      if (formula && ['array', 'dataTable', 'shared'].includes(formula.getAttribute('t') ?? '')) throw new Error(`Cell ${at} participates in a ${formula.getAttribute('t')} formula; edit it through a calculation engine`);
      for (const child of Array.from(cell.childNodes)) if (child.nodeType === 1 && ['f', 'v', 'is'].includes((child as Element).localName)) cell.removeChild(child);
      cell.removeAttribute('t');
      if (styleSource?.hasAttribute('s')) cell.setAttribute('s', styleSource.getAttribute('s')!);
      if (value !== null) {
        if (typeof value === 'object') { if (!value.formula?.trim()) throw new Error('A formula must contain an expression'); const f = doc.createElementNS(S, 'f'); f.textContent = value.formula.replace(/^=/, ''); cell.appendChild(f); }
        else if (typeof value === 'string') { cell.setAttribute('t', 'inlineStr'); const inline = doc.createElementNS(S, 'is'), t = doc.createElementNS(S, 't'); t.setAttribute('xml:space', 'preserve'); t.textContent = value; inline.appendChild(t); cell.appendChild(inline); }
        else { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Worksheet numbers must be finite'); if (typeof value === 'boolean') cell.setAttribute('t', 'b'); const v = doc.createElementNS(S, 'v'); v.textContent = typeof value === 'boolean' ? value ? '1' : '0' : String(value); cell.appendChild(v); }
      }
      if (edit.numberFormat) this.setNumberFormat(cell, edit.numberFormat);
    }
    // A stale dimension can hide newly written cells from readers. Derive it from actual cells.
    const positions = all(doc, 'c').map(cell => coordinates(cell.getAttribute('r')!));
    const dimension = first(doc, 'dimension');
    if (dimension && positions.length) {
      const bounds = positions.reduce((range, point) => ({ minRow: Math.min(range.minRow, point.row), minColumn: Math.min(range.minColumn, point.column),
        maxRow: Math.max(range.maxRow, point.row), maxColumn: Math.max(range.maxColumn, point.column) }), { minRow: Infinity, minColumn: Infinity, maxRow: 0, maxColumn: 0 });
      dimension.setAttribute('ref', `${addressOf(bounds.minRow, bounds.minColumn)}:${addressOf(bounds.maxRow, bounds.maxColumn)}`);
    }
    this.changed.add(section.id);
  }
  private setNumberFormat(cell: Element, code: string): void {
    const part = 'xl/styles.xml', doc = this.xml(part);
    let formats = first(doc, 'numFmts');
    if (!formats) { formats = doc.createElementNS(S, 'numFmts'); doc.documentElement.insertBefore(formats, doc.documentElement.firstChild); }
    let format = children(formats, 'numFmt').find(format => format.getAttribute('formatCode') === code);
    if (!format) { const id = Math.max(163, ...children(formats, 'numFmt').map(format => Number(format.getAttribute('numFmtId')))) + 1; format = doc.createElementNS(S, 'numFmt'); format.setAttribute('numFmtId', String(id)); format.setAttribute('formatCode', code); formats.appendChild(format); formats.setAttribute('count', String(children(formats, 'numFmt').length)); }
    const xfs = first(doc, 'cellXfs'); if (!xfs) throw new Error('The workbook has no cell style table');
    const styles = children(xfs, 'xf'), original = styles[Number(cell.getAttribute('s') || 0)];
    if (!original) throw new Error('The cell style is absent from the workbook');
    const xf = original.cloneNode(true) as Element; xf.setAttribute('numFmtId', format.getAttribute('numFmtId')!); xf.setAttribute('applyNumberFormat', '1');
    const serialized = new XMLSerializer().serializeToString(xf);
    let index = styles.findIndex(style => new XMLSerializer().serializeToString(style) === serialized);
    if (index === -1) { index = styles.length; xfs.appendChild(xf); xfs.setAttribute('count', String(index + 1)); }
    cell.setAttribute('s', String(index)); this.changed.add(part);
  }
  private addSheet(name: string): void {
    if (this.format !== 'xlsx') throw new Error('Sheets belong to an XLSX workbook');
    if (!name || name.length > 31 || /[\\/*?:[\]]/.test(name) || this.sections().some(section => section.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('Excel sheet names must be unique, at most 31 characters, and exclude \\ / * ? : [ ]');
    const workbook = this.xml('xl/workbook.xml'), sheets = first(workbook, 'sheets'); if (!sheets) throw new Error('The workbook sheet list is missing');
    const relPart = 'xl/_rels/workbook.xml.rels', rels = this.xml(relPart);
    let id = Math.max(0, ...children(sheets, 'sheet').map(sheet => Number(sheet.getAttribute('sheetId')))) + 1;
    while (this.zip.getEntry(`xl/worksheets/sheet${id}.xml`)) id++;
    const part = `xl/worksheets/sheet${id}.xml`, relId = `varinSheet${id}`;
    if (all(rels, 'Relationship').some(rel => rel.getAttribute('Id') === relId)) throw new Error('The new sheet relationship already exists');
    const sheet = workbook.createElementNS(S, 'sheet'); sheet.setAttribute('name', name); sheet.setAttribute('sheetId', String(id)); sheet.setAttributeNS(R, 'r:id', relId); sheets.appendChild(sheet);
    const relationship = rels.createElementNS(REL, 'Relationship'); relationship.setAttribute('Id', relId); relationship.setAttribute('Type', `${R}/worksheet`); relationship.setAttribute('Target', `worksheets/sheet${id}.xml`); rels.documentElement.appendChild(relationship);
    const types = this.xml('[Content_Types].xml'), override = types.createElementNS(CT, 'Override'); override.setAttribute('PartName', `/${part}`); override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'); types.documentElement.appendChild(override);
    this.zip.addFile(part, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${S}"><sheetData/></worksheet>`));
    for (const changed of ['xl/workbook.xml', relPart, '[Content_Types].xml']) this.changed.add(changed);
  }
  private invalidateFormulaCaches(): void {
    if (this.zip.getEntry('xl/calcChain.xml')) {
      this.zip.deleteFile('xl/calcChain.xml');
      const relPart = 'xl/_rels/workbook.xml.rels';
      for (const rel of all(this.xml(relPart), 'Relationship')) if ((rel.getAttribute('Type') ?? '').endsWith('/calcChain')) rel.parentNode!.removeChild(rel);
      for (const entry of all(this.xml('[Content_Types].xml'), 'Override')) if (entry.getAttribute('PartName') === '/xl/calcChain.xml') entry.parentNode!.removeChild(entry);
      this.changed.add(relPart); this.changed.add('[Content_Types].xml');
    }
    for (const section of this.sections()) {
      const doc = this.xml(section.id);
      let changed = false;
      for (const cell of all(doc, 'c')) if (first(cell, 'f')) for (const cache of children(cell, 'v')) { cell.removeChild(cache); changed = true; }
      if (changed) this.changed.add(section.id);
    }
    const doc = this.xml('xl/workbook.xml');
    let calc = first(doc, 'calcPr'); if (!calc) { calc = doc.createElementNS(S, 'calcPr'); doc.documentElement.appendChild(calc); }
    calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1'); calc.setAttribute('calcMode', 'auto');
    this.changed.add('xl/workbook.xml');
  }
}
