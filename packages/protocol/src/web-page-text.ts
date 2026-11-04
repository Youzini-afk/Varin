/** Pure extracted-page projection shared by the Web owner and native material presentation.
 * It never changes the fixed material body or its source identity. */
export function selectWebPageText(markdown: string, options: { find?: string; start_line?: number; end_line?: number }): string {
  if (options.find === undefined && options.start_line === undefined && options.end_line === undefined) return markdown;
  const lines = markdown.split(/\r?\n/);
  const start = (options.start_line ?? 1) - 1;
  const end = Math.min(options.end_line ?? lines.length, lines.length);
  const header = `Extracted page: ${lines.length} lines.`;
  if (start >= lines.length) return `${header} Requested start line is beyond the page.`;
  if (options.find === undefined) {
    return `${header} Lines ${start + 1}–${end}:\n${lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n")}`;
  }
  const needle = options.find.toLowerCase();
  const selected = new Set<number>();
  let matches = 0;
  for (let index = start; index < end; index += 1) {
    if (!lines[index]!.toLowerCase().includes(needle)) continue;
    matches += 1;
    for (let context = Math.max(start, index - 3); context < Math.min(end, index + 4); context += 1) selected.add(context);
  }
  if (!matches) return `${header} No matches for ${JSON.stringify(options.find)} in lines ${start + 1}–${end}.`;
  const output = [`${header} ${matches} matching lines for ${JSON.stringify(options.find)}:`];
  let previous = -1;
  for (const index of [...selected].sort((left, right) => left - right)) {
    if (previous >= 0 && index > previous + 1) output.push("…");
    output.push(`${index + 1}: ${lines[index]}`);
    previous = index;
  }
  return output.join("\n");
}

/** A candidate always points to existing lines. Models may choose these ranges,
 * but never supply replacement prose to the source projection. */
export interface WebPassageCandidate {
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  heading?: string;
}
export interface WebPassageRange { startLine: number; endLine: number }

const QUESTION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you",
  "的", "了", "吗", "呢", "是", "在", "与", "和", "或", "有", "请", "什么", "怎么", "如何", "为什么", "哪些", "是否", "可以", "一个", "这个", "我们", "需要", "页面", "文档", "介绍", "说明",
]);
const normalizeQuestionText = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();
function questionTerms(question: string): Array<{ text: string; weight: number }> {
  const normalized = normalizeQuestionText(question);
  const terms = new Map<string, number>();
  const add = (text: string, weight: number) => {
    if (text.length > 1 && !QUESTION_STOP_WORDS.has(text)) terms.set(text, Math.max(terms.get(text) ?? 0, weight));
  };
  // Symbol-bearing tokens remain intact: ERR_CONNECTION_RESET, C++, foo.bar(),
  // HTTP/2, and --flag are useful evidence, not punctuation to discard.
  for (const match of normalized.matchAll(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}_./:+#-]*/gu)) {
    const token = match[0].replace(/[./:-]+$/, "");
    add(token, /[_./:+#-]/.test(token) ? 3 : 1);
  }
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  for (const segment of segmenter.segment(normalized)) if (segment.isWordLike) add(segment.segment, 1.5);
  // Adjacent Han pairs give a deterministic fallback for compounds and mixed
  // language strings absent from the platform's dictionary.
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index + 1 < characters.length; index += 1) add(characters.slice(index, index + 2).join(""), 0.5);
  }
  for (const match of normalized.matchAll(/["“`「]([^"”`」]+)["”`」]/g)) add(match[1]!, 4);
  return [...terms].map(([text, weight]) => ({ text, weight }));
}

/** Paragraphs, tables and fenced code remain atomic candidates. Blank lines in
 * code do not split its range; headings are retained as contextual candidates. */
export function webPageBlocks(markdown: string): WebPassageRange[] {
  const lines = markdown.split("\n");
  const blocks: WebPassageRange[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.trim()) { index += 1; continue; }
    const start = index;
    const fence = /^\s*(`{3,}|~{3,})/.exec(lines[index]!);
    if (fence) {
      index += 1;
      while (index < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index]!);
        index += 1;
        if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) break;
      }
    } else if (/^\s*<table(?:\s|>)/i.test(lines[index]!)) {
      while (index < lines.length && !/<\/table>/i.test(lines[index]!)) index += 1;
      if (index < lines.length) index += 1;
    } else if (/^#{1,6}\s/.test(lines[index]!)) index += 1;
    else {
      index += 1;
      while (index < lines.length && lines[index]!.trim()
        && !/^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(lines[index]!)) index += 1;
    }
    blocks.push({ startLine: start + 1, endLine: index });
  }
  return blocks;
}

/** Rank original paragraphs with lexical coverage, entity fidelity, heading
 * context and rare-term weight. This is retrieval, never an answer generator. */
export function rankWebPagePassages(markdown: string, question: string): WebPassageCandidate[] {
  const lines = markdown.split("\n");
  const blocks = webPageBlocks(markdown);
  const terms = questionTerms(question);
  const normalized = blocks.map(range => normalizeQuestionText(lines.slice(range.startLine - 1, range.endLine).join("\n")));
  const frequencies = terms.map(term => normalized.filter(text => text.includes(term.text)).length);
  const headingStack: Array<{ level: number; title: string }> = [];
  return blocks.map((range, index) => {
    const text = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const heading = /^(#{1,6})\s+(.+)/.exec(text);
    if (heading) {
      while (headingStack.length && headingStack.at(-1)!.level >= heading[1]!.length) headingStack.pop();
      headingStack.push({ level: heading[1]!.length, title: heading[2]! });
    }
    const headingText = headingStack.map(entry => entry.title).join(" > ");
    const context = normalizeQuestionText(headingText);
    let score = 0;
    let covered = 0;
    for (const [termIndex, term] of terms.entries()) {
      const inBody = normalized[index]!.includes(term.text);
      const inHeading = context.includes(term.text);
      if (!inBody && !inHeading) continue;
      const rarity = 1 + Math.log(1 + blocks.length / (1 + frequencies[termIndex]!));
      score += term.weight * rarity * (inBody ? 1 : 0.3);
      if (inBody) covered += 1;
    }
    score *= 1 + covered / Math.max(1, terms.length);
    // A heading alone is context, rather than the best answer passage.
    if (heading) score *= 0.5;
    return { ...range, text, score, ...(headingText ? { heading: headingText } : {}) };
  }).filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score || left.startLine - right.startLine);
}

/** Reject invented/out-of-bounds locations, merge overlaps and preserve source
 * order. This is also the trust boundary for optional model selections. */
export function validateWebPassageRanges(value: unknown, totalLines: number): WebPassageRange[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const ranges: WebPassageRange[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine)
      || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > totalLines) return null;
    ranges.push({ startLine: entry.startLine, endLine: entry.endLine });
  }
  const merged: WebPassageRange[] = [];
  for (const range of ranges.sort((left, right) => left.startLine - right.startLine)) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push(range);
  }
  return merged;
}

/** Budget the default response, preserving a table/code block that crosses the
 * end boundary. A single indivisible line/block may exceed this soft budget. */
export function webPageEndLine(markdown: string, startLine: number, maxLines = 160, endLine?: number): number {
  const lines = markdown.split("\n");
  const limit = Math.min(endLine ?? lines.length, lines.length);
  let end = Math.min(limit, startLine + maxLines - 1);
  let characters = 0;
  for (let index = startLine - 1; index < end; index += 1) {
    characters += lines[index]!.length + 1;
    if (characters > 24_000 && index >= startLine) { end = index; break; }
  }
  // Continue through a fenced code/table block rather than publishing a broken
  // structure. Ordinary prose can continue at the next real line.
  const block = webPageBlocks(markdown).find(entry => entry.startLine <= end && entry.endLine > end);
  if (block && (/^\s*(`{3,}|~{3,})/.test(lines[block.startLine - 1]!) || (lines[block.startLine - 1]!.trim().startsWith("|") || /^\s*<table(?:\s|>)/i.test(lines[block.startLine - 1]!)))) {
    end = Math.min(limit, block.endLine);
  }
  return end;
}
