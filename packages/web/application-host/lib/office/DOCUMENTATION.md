# Office format owner

`OfficePackage` reads the original DOCX/XLSX/PPTX package and addresses paragraphs, table cells,
worksheet cells, shapes and notes by package-local object IDs. IDs are used with the read revision.
Local edits update selected XML parts and retain unrelated package entries, including embedded
workbooks, charts, styles and custom XML. Unsupported shared/array formula edits report a concrete
capability gap. Formula text, stored values and recalculation state remain distinct.

`create.ts` lazily loads docx, ExcelJS and PptxGenJS for new editable files. `renderer.ts` uses an
installed LibreOffice executable (or `VARIN_LIBREOFFICE_COMMAND`) through the original managed
process service, in a private conversion profile. Rendering reports the actual engine/version;
missing LibreOffice leaves structural reading and editing available. No fabricated PDF preview or
formula evaluator substitutes for this engine. Process cancellation retains scratch files until the
original executor confirms exit.

`reader.ts` retains source bytes through WebMaterialStore. `office-runtime.ts` consumes the original
frozen tool invocation; byte transformations never write the workspace themselves. `binary-file-owner.ts`
applies a revision-checked native transaction with the turn's recovery journal. Managed sources forward
the same invocation to their source Host. Lost responses are unknown until the original file receipt is
read; later file changes do not overwrite that receipt.

Workbench readers use the selected physical file or its matching admitted source. Conversation readers
use fixed material snapshots and expose actual section/object references. A converted PDF retains its
Office source association. Office JSON structure and rendered pages are separate views.

The model-facing `document_read` defaults to readable content for both original paths and retained
snapshots. Explicit overview remains an index with human section names, `textStatus:not-requested`
and a `nextRead` for the original snapshot. Content pages retain selectors and return exact nextOffset
continuations. Conflicting general/Office views fail explicitly. PDF ingestion used only to register
uploaded material can still request metadata without extracting the entire body.

Focused format tests cover cross-run Word text edits, retained table/custom XML parts, formula cache
invalidation, and editable presentation charts with retained embedded workbooks. Real rendering needs
a Host with LibreOffice; component detection is not evidence of a completed render.
