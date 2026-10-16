import { init, parse } from 'es-module-lexer';
import { uiFrameDocument } from './frame';
import type { UiSource, UiViewState } from '@varin/application-client';
export function workFilePath(from: string, ref: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const parts = ref.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of ref.split(/[?#]/, 1)[0]!.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') { try { parts.push(decodeURIComponent(part)); } catch { parts.push(part); } }
  }
  return parts.join('/');
}
export const uiModuleId = (file: string) => `ui-file:/${file.split('/').map(encodeURIComponent).join('/')}`;
/** Transform module specifiers with a lexer, leaving comments, templates and ordinary
 * string literals intact. Import maps resolve cycles without recursively bundling code. */
export async function prepareUiFiles(files: Record<string, string>, entry: string) {
  await init;
  const transform = (text: string, file: string) => {
    let imports: ReturnType<typeof parse>[0];
    try { [imports] = parse(text); } catch { return text; }
    const edits = imports.flatMap(specifier => {
      if (!specifier.n) return [];
      const path = workFilePath(file, specifier.n);
      if (!path || !Object.hasOwn(files, path)) return [];
      const id = uiModuleId(path);
      return [{ start: specifier.s, end: specifier.e, text: specifier.d >= 0 ? JSON.stringify(id) : JSON.stringify(id).slice(1, -1) }];
    });
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text;
  };
  const result = { ...files };
  for (const [file, text] of Object.entries(files)) if (/\.[cm]?js$/i.test(file)) result[file] = transform(text, file);
  const parsed = new DOMParser().parseFromString(files[entry] ?? '', 'text/html');
  for (const script of parsed.querySelectorAll('script[type="module"]:not([src])')) script.textContent = transform(script.textContent ?? '', entry);
  result[entry] = '<!doctype html>\n' + parsed.documentElement.outerHTML;
  return result;
}
export async function createUiExport(files: Record<string, string>, assets: UiSource['assets'], entry: string, state?: UiViewState, theme = '') {
  const prepared = await prepareUiFiles(files, entry), channel = crypto.randomUUID();
  const payload = JSON.stringify({ channel, type: 'update', files: prepared, assets, entry, committed: true, state, source: {} }).replaceAll('<', '\\u003c');
  const themeMessage = JSON.stringify({ channel, type: 'theme', css: theme }).replaceAll('<', '\\u003c');
  return uiFrameDocument(channel).replace('</body>', `<script>window.postMessage(${themeMessage},'*');window.postMessage(${payload},'*')</script></body>`);
}
