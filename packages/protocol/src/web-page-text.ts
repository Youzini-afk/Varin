/** Pure extracted-page projection shared by the Web owner and its Pi presentation.
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
