import type { OfficeCreateContent, OfficeTextRun } from '@varin/protocol';

export async function createOfficeFile(content: OfficeCreateContent,
  readImage: (path: string) => Promise<Buffer>, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (content.format === 'docx') {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType } = await import('docx');
    const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    const run = (value: OfficeTextRun) => new TextRun({ text: value.text,
      ...(value.bold === undefined ? {} : { bold: value.bold }), ...(value.italic === undefined ? {} : { italics: value.italic }),
      ...(value.font ? { font: value.font } : {}), ...(value.size ? { size: value.size * 2 } : {}), ...(value.color ? { color: value.color.replace(/^#/, '') } : {}) });
    const blocks = content.blocks.map(block => block.kind === 'table'
      ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({
          ...(block.header && index === 0 ? { tableHeader: true } : {}),
          children: row.map(text => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: !!block.header && index === 0 })] })] })),
        })) })
      : new Paragraph({ children: (block.runs ?? [{ text: block.text ?? '' }]).map(run),
          ...(block.heading ? block.heading <= 6 ? { heading: headings[block.heading - 1]! } : { style: `Heading${block.heading}` } : {}), ...(block.bullet ? { bullet: { level: 0 } } : {}),
          ...(block.style ? { style: block.style } : {}),
          ...(block.alignment ? { alignment: block.alignment === 'justify' ? AlignmentType.JUSTIFIED : block.alignment } : {}),
        }));
    const document = new Document({ ...(content.title ? { title: content.title } : {}),
      styles: { default: { document: { run: { font: content.font ?? 'Calibri' } } },
        paragraphStyles: [7, 8, 9].map(level => ({ id: `Heading${level}`, name: `Heading ${level}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
          paragraph: { outlineLevel: level - 1 }, run: { bold: true } })) }, sections: [{ children: blocks }] });
    const bytes = await Packer.toBuffer(document);
    signal?.throwIfAborted();
    return bytes;
  }
  if (content.format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    book.calcProperties.fullCalcOnLoad = true;
    for (const source of content.sheets) {
      signal?.throwIfAborted();
      const sheet = book.addWorksheet(source.name);
      sheet.addRows(source.rows.map(row => row.map(value => value !== null && typeof value === 'object' ? { formula: value.formula.replace(/^=/, '') } : value)));
      if (source.header && source.rows.length) sheet.getRow(1).font = { bold: true };
      if (source.widths) source.widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
      if (source.freezeRows) sheet.views = [{ state: 'frozen', ySplit: source.freezeRows }];
      for (const [address, format] of Object.entries(source.numberFormats ?? {})) {
        if (/^[A-Z]+$/i.test(address)) sheet.getColumn(address).numFmt = format;
        else sheet.getCell(address).numFmt = format;
      }
    }
    const bytes = await book.xlsx.writeBuffer();
    signal?.throwIfAborted();
    return Buffer.from(bytes);
  }
  if (content.format === 'pptx') {
    // This dual-package release exposes an ESM class with CommonJS-shaped NodeNext declarations.
    const Presentation = (await import('pptxgenjs')).default as unknown as typeof import('pptxgenjs').default;
    const deck = new Presentation();
    if (content.width !== undefined || content.height !== undefined) {
      if (!content.width || !content.height) throw new Error('A custom slide size requires both width and height in inches');
      deck.defineLayout({ name: 'CUSTOM', width: content.width, height: content.height }); deck.layout = 'CUSTOM';
    } else deck.layout = 'LAYOUT_WIDE';
    if (content.title) deck.title = content.title;
    for (const source of content.slides) {
      signal?.throwIfAborted();
      const slide = deck.addSlide();
      if (source.background) slide.background = { color: source.background.replace(/^#/, '') };
      if (source.notes) slide.addNotes(source.notes);
      for (const object of source.objects) {
        const geometry = { x: object.x, y: object.y, w: object.width, ...(object.height === undefined ? {} : { h: object.height }) };
        if (object.kind === 'text') slide.addText(object.text, { ...geometry,
          ...(object.fontSize === undefined ? {} : { fontSize: object.fontSize }), ...(object.fontFace ? { fontFace: object.fontFace } : {}),
          ...(object.bold === undefined ? {} : { bold: object.bold }), ...(object.color ? { color: object.color.replace(/^#/, '') } : {}),
          ...(object.align ? { align: object.align } : {}) });
        else if (object.kind === 'table') slide.addTable(object.rows.map(row => row.map(text => ({ text }))), { ...geometry, ...(object.fontSize ? { fontSize: object.fontSize } : {}) });
        else if (object.kind === 'image') {
          const bytes = await readImage(object.path);
          signal?.throwIfAborted();
          const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
            : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : /<svg\b/i.test(bytes.subarray(0, 1024).toString()) ? 'image/svg+xml' : undefined;
          if (!mime) throw new Error(`Unsupported presentation image format: ${object.path}`);
          slide.addImage({ ...geometry, data: `data:${mime};base64,${bytes.toString('base64')}` });
        } else {
          if (object.series.some(series => series.labels.length !== series.values.length || series.values.some(value => !Number.isFinite(value)))) throw new Error('Chart labels and finite numeric values must have matching lengths');
          slide.addChart(deck.ChartType[object.type], object.series, geometry);
        }
      }
    }
    const bytes = await deck.write({ outputType: 'nodebuffer' });
    signal?.throwIfAborted();
    return Buffer.from(bytes as Buffer);
  }
  throw new Error('Select docx, xlsx or pptx for the new document');
}
