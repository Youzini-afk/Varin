import { expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { OfficePackage } from './package.js';
import { createOfficeFile } from './create.js';

const noImage = async (): Promise<Buffer> => { throw new Error('No image was requested'); };

it('edits Word text across styled runs and preserves unrelated package parts and table structure', async () => {
  const generated = await createOfficeFile({ format: 'docx', blocks: [
    { kind: 'paragraph', heading: 1, runs: [{ text: 'Original ', bold: true }, { text: 'heading', italic: true }] },
    { kind: 'table', header: true, rows: [['Name', 'Value'], ['Revenue', '100']] },
    { kind: 'paragraph', text: 'Conclusion' },
  ] }, noImage);
  const template = new AdmZip(generated);
  template.addFile('customXml/item1.xml', Buffer.from('<custom>preserve me</custom>'));
  const bytes = template.toBuffer(), document = new OfficePackage(bytes);
  const content = document.read({ view: 'content' }).objects!;
  expect(content.map(object => object.kind)).toEqual(['paragraph', 'table', 'paragraph']);
  expect(document.read({ view: 'find', query: 'Revenue' }).objects?.[0]?.kind).toBe('table');
  const edited = document.edit([{ action: 'replace_text', objectId: content[0]!.id, oldText: 'Original heading', newText: 'Updated heading' }]);
  const after = new OfficePackage(edited.bytes).read({ view: 'content' }).objects!;
  expect(after[0]!.text).toBe('Updated heading');
  expect(after[1]!.rows).toEqual(content[1]!.rows);
  const output = new AdmZip(edited.bytes);
  for (const part of ['word/styles.xml', '[Content_Types].xml', 'customXml/item1.xml']) expect(output.getEntry(part)!.getData()).toEqual(template.getEntry(part)!.getData());
  expect(output.getEntry('word/document.xml')!.getData().toString()).toContain('<w:b');
  expect(new OfficePackage(edited.bytes).read({ objectId: after[1]!.rows![1]!.cells[0]!.objectIds[0]! }).objects?.[0]?.text).toBe('Revenue');
});

it('keeps workbook formulas distinct from their stored results and invalidates dependent caches on a cell edit', async () => {
  const generated = await createOfficeFile({ format: 'xlsx', sheets: [{ name: 'Data', rows: [['Value', 'Total'], [2, { formula: 'A2*3' }]], numberFormats: { B: '0.00' } }] }, noImage);
  const template = new AdmZip(generated);
  const part = 'xl/worksheets/sheet1.xml';
  template.updateFile(part, Buffer.from(template.getEntry(part)!.getData().toString().replace('<f>A2*3</f>', '<f>A2*3</f><v>6</v>')));
  template.addFile('xl/charts/kept.xml', Buffer.from('<chart>untouched</chart>'));
  const document = new OfficePackage(template.toBuffer());
  expect(document.read({ view: 'content', section: 'Data', range: 'B2' }).objects?.[0]).toMatchObject({ formula: { text: 'A2*3' }, cachedValue: 6, calculation: 'stored-unverified' });
  const edited = document.edit([{ action: 'set_cells', sheet: 'Data', start: 'A2', values: [[4]], numberFormat: '0.0' }]);
  const after = new OfficePackage(edited.bytes);
  expect(after.read({ section: 'Data', range: 'A2' }).objects?.[0]).toMatchObject({ value: 4, style: { numberFormat: '0.0' } });
  expect(after.read({ section: 'Data', range: 'B2' }).objects?.[0]).toMatchObject({ formula: { text: 'A2*3' }, cachedValue: null, calculation: 'needs-recalculation' });
  expect(edited.requiresRecalculation).toBe(true);
  expect(new AdmZip(edited.bytes).getEntry('xl/charts/kept.xml')!.getData()).toEqual(template.getEntry('xl/charts/kept.xml')!.getData());
});

it('creates editable presentation charts and changes one text shape without rebuilding its chart or embedded workbook', async () => {
  const bytes = await createOfficeFile({ format: 'pptx', slides: [{ notes: 'Speaker notes', objects: [
    { kind: 'text', text: 'Original title', x: 1, y: 0.4, width: 8, height: 1, fontSize: 30 },
    { kind: 'chart', type: 'bar', series: [{ name: 'Revenue', labels: ['A', 'B'], values: [10, 20] }], x: 1, y: 2, width: 8, height: 4 },
  ] }] }, noImage);
  const before = new AdmZip(bytes), document = new OfficePackage(bytes);
  expect(document.read({ view: 'content' }).objects?.find(object => object.kind === 'chart')?.chart?.series[0]).toMatchObject({ name: 'Revenue', categories: ['A', 'B'], values: [10, 20] });
  const title = document.read({ view: 'content' }).objects!.find(object => object.text === 'Original title')!;
  const edited = document.edit([{ action: 'set_text', objectId: title.id, text: 'Updated title' }, { action: 'move_shape', objectId: title.id, x: 0.5 }]);
  expect(new OfficePackage(edited.bytes).read({ view: 'content' }).objects).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Updated title', geometry: expect.objectContaining({ x: 0.5 }) })]));
  const output = new AdmZip(edited.bytes);
  const preserved = before.getEntries().filter(entry => entry.entryName.startsWith('ppt/charts/') || entry.entryName.startsWith('ppt/embeddings/'));
  expect(preserved.length).toBeGreaterThan(1);
  for (const entry of preserved) expect(output.getEntry(entry.entryName)!.getData()).toEqual(entry.getData());
});

it('creates a presentation with an embedded PNG and rejects unsupported image bytes', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const content = { format: 'pptx' as const, slides: [{ objects: [
    { kind: 'image' as const, path: 'figure.png', x: 1, y: 2, width: 3, height: 4 },
  ] }] };
  const requested: string[] = [];
  const bytes = await createOfficeFile(content, async path => { requested.push(path); return png; });
  expect(requested).toEqual(['figure.png']);
  const archive = new AdmZip(bytes);
  const image = archive.getEntries().find(entry => entry.entryName.startsWith('ppt/media/') && entry.entryName.endsWith('.png'));
  expect(image?.getData()).toEqual(png);
  const relations = archive.readAsText('ppt/slides/_rels/slide1.xml.rels');
  expect(relations).toContain(`../media/${image!.entryName.split('/').pop()}`);
  expect(archive.readAsText('ppt/slides/slide1.xml')).toContain('<p:pic>');
  await expect(createOfficeFile(content, async () => Buffer.from('not an image')))
    .rejects.toThrow('Unsupported presentation image format: figure.png');
});
