/** Tokenizer-aware packing of native structural units. Syntax discovery,
 * container selection and source coverage belong to Rust; model decoration
 * and exact tokenizer budgets remain in this model adapter. */
import type { StructureLineRange, StructureUnit } from "../../structure/types.js";
import { buildEmbedText, splitSourceLines, textOfLines, type TokenCounter } from "./embed-text.js";
import { blockIdentity, contentHashOf, parentUnitIdentity } from "./identity.js";
export type SemanticChunk = {
  blockId: string;
  parentUnitId: string;
  documentId: string;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  body: string;
  embedText: string;
  fallback: boolean;
  /** Offset of `body` inside the original line-range text when a range was continue-split. */
  bodyOffset?: number;
};

const prefixThatFits = (text: string, maxTokens: number, countTokens: TokenCounter): number => {
  if (text.length === 0) return 0;
  // Probe near one model window. Re-tokenizing the entire unconsumed suffix
  // for every piece made long generated lines quadratic in source length.
  let low = 0;
  let high = Math.min(text.length, maxTokens);
  while (countTokens(text.slice(0, high)) <= maxTokens) {
    low = high;
    if (high === text.length) return high;
    high = Math.min(text.length, high * 2);
  }
  high -= 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return Math.max(1, low);
};

const splitBodyPieces = (body: string, maxTokens: number, countTokens: TokenCounter): Array<{ text: string; offset: number }> => {
  if (body.length === 0) return [];
  if (countTokens(body) <= maxTokens) return [{ text: body, offset: 0 }];
  const pieces: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  let remaining = body;
  while (remaining.length > 0) {
    const take = prefixThatFits(remaining, maxTokens, countTokens);
    pieces.push({ text: remaining.slice(0, take), offset });
    remaining = remaining.slice(take);
    offset += take;
  }
  return pieces;
};

const makeChunks = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
  fallback: boolean,
): SemanticChunk[] => {
  const body = textOfLines(lines, range.startLine, range.endLine);
  const pieces = splitBodyPieces(body, maxTokens, countTokens);
  return pieces.map((piece, index) => {
    const embedText = buildEmbedText({
      documentId,
      parentName: parent.name,
      parentSignature: parent.signature,
      docComments: docs,
      body: piece.text,
    }, maxTokens, countTokens);
    const blockId = pieces.length === 1
      ? blockIdentity(documentId, range.startLine, range.endLine)
      : `${blockIdentity(documentId, range.startLine, range.endLine)}#p${index}`;
    return {
      blockId,
      parentUnitId: parentUnitIdentity(documentId, parent.name, parent.kind),
      documentId,
      parentName: parent.name,
      parentKind: parent.kind,
      parentSignature: parent.signature,
      startLine: range.startLine,
      endLine: range.endLine,
      contentHash: contentHashOf(piece.text),
      body: piece.text,
      embedText,
      fallback,
      ...(pieces.length > 1 ? { bodyOffset: piece.offset } : {}),
    };
  });
};

const windowFits = (
  lines: readonly string[],
  range: StructureLineRange,
  maxTokens: number,
  countTokens: TokenCounter,
): boolean => {
  const body = textOfLines(lines, range.startLine, range.endLine);
  // buildEmbedText never removes body text to make room for decoration, so a
  // window fits exactly when its body fits. Avoid rebuilding and tokenizing the
  // decorated text several times for every size probe.
  return countTokens(body) <= maxTokens;
};

const overlappingChunks = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
): SemanticChunk[] => {
  const lineCount = range.endLine - range.startLine + 1;
  let low = 1;
  let high = lineCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const probe = { startLine: range.startLine, endLine: range.startLine + middle - 1 };
    if (windowFits(lines, probe, maxTokens, countTokens)) low = middle;
    else high = middle - 1;
  }
  const size = Math.max(1, low);
  if (size === 1 && !windowFits(lines, { startLine: range.startLine, endLine: range.startLine }, maxTokens, countTokens)) {
    return makeChunks(documentId, lines, range, parent, docs, maxTokens, countTokens, true);
  }
  const overlap = Math.min(8, Math.max(1, Math.floor(size / 4)));
  const step = Math.max(1, size - overlap);
  const chunks: SemanticChunk[] = [];
  for (let start = range.startLine; start <= range.endLine; start += step) {
    const end = Math.min(range.endLine, start + size - 1);
    chunks.push(...makeChunks(documentId, lines, { startLine: start, endLine: end }, parent, docs, maxTokens, countTokens, true));
    if (end >= range.endLine) break;
  }
  return chunks;
};

const emitRange = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
  fallback: boolean,
): SemanticChunk[] => {
  if (range.endLine < range.startLine) return [];
  if (windowFits(lines, range, maxTokens, countTokens)) {
    return makeChunks(documentId, lines, range, parent, docs, maxTokens, countTokens, fallback);
  }
  return overlappingChunks(documentId, lines, range, parent, docs, maxTokens, countTokens);
};


export interface PackStructuralUnitsInput {
  documentId:string;
  units:readonly StructureUnit[];
  maxTokens:number;
  countTokens:TokenCounter;
}
export function packStructuralUnits(input:PackStructuralUnitsInput):SemanticChunk[] {
  if(!Number.isSafeInteger(input.maxTokens)||input.maxTokens<1)throw new Error("The embedding token window must be positive");
  return input.units.flatMap(unit=>{
    const lines=splitSourceLines(unit.text);
    if(!Number.isSafeInteger(unit.startLine)||unit.startLine<1||unit.endLine<unit.startLine
      ||lines.length!==unit.endLine-unit.startLine+1)throw new Error("Native unit source range does not match its captured body");
    const packed=emitRange(input.documentId,lines,{startLine:1,endLine:lines.length},
      {name:unit.parentName,kind:unit.parentKind,signature:unit.parentSignature},unit.docComments,
      input.maxTokens,input.countTokens,unit.fallback);
    return packed.map(chunk=>{
      const startLine=chunk.startLine+unit.startLine-1,endLine=chunk.endLine+unit.startLine-1;
      const continuation=chunk.blockId.match(/#p\d+$/)?.[0]??"";
      return {...chunk,startLine,endLine,blockId:blockIdentity(input.documentId,startLine,endLine)+continuation};
    });
  });
}

/** Logical knowledge records have no filesystem syntax. Their authority supplies
 * a plain unit, and this same tokenizer packer enforces the model window. */
export const packPlainText = (input: { documentId:string; text:string; maxTokens:number; countTokens:TokenCounter }): SemanticChunk[] =>
  packStructuralUnits({...input,units:input.text ? [{startLine:1,endLine:splitSourceLines(input.text).length,
    parentName:"",parentKind:"file",parentSignature:"",docComments:"",text:input.text,fallback:true}] : []});
