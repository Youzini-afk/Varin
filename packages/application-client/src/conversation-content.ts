import type { JsonValue } from '@varin/protocol';

export interface ConversationUiAction { type: 'compose' | 'copy' | 'reference' | 'send' | 'open'; label: string; ref?: string }
interface Base { key: string; label?: string; action?: string | ConversationUiAction }
export interface ConversationUiChoice extends Base { type: 'choice'; options: { key: string; label: string }[]; multiple?: boolean; required?: boolean; allowOther?: boolean }
export interface ConversationUiInput extends Base { type: 'input'; inputType: 'text' | 'number' | 'range' | 'date' | 'textarea'; required?: boolean; min?: number; max?: number; step?: number; placeholder?: string; unit?: string }
export type ConversationUiField = ConversationUiChoice | ConversationUiInput;
export type ConversationUiNode = ConversationUiField
  | (Base & { type: 'form'; fields: ConversationUiField[] })
  | (Base & { type: 'disclosure'; content: string })
  | (Base & { type: 'tabs'; tabs: { key: string; label: string; content: string }[] })
  | (Base & { type: 'embed' | 'object'; ref: string });
export type ConversationContentPart =
  | { kind: 'markdown'; text: string; start: number; end: number }
  | { kind: 'ui'; raw: string; start: number; end: number; fragmentKey: string; node: ConversationUiNode; definition: unknown }
  | { kind: 'invalid'; raw: string; start: number; end: number; error: string }
  | { kind: 'pending'; raw: string; start: number; end: number };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
};
const string = (value: unknown, name: string): string => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`); return value; };
const unique = (keys: string[]) => { if (new Set(keys).size !== keys.length) throw new Error('Keys must be unique'); };
/** Implicit keys use exact labels, never array indices, so reorder cannot silently change meaning. */
export function normalizeConversationUi(value: unknown, fallbackKey = 'root'): ConversationUiNode {
  const v = object(value);
  const key = v.key === undefined ? fallbackKey : string(v.key, 'key');
  const base: Base = { key };
  if (v.label !== undefined) base.label = string(v.label, 'label');
  if (v.action !== undefined) {
    if (typeof v.action === 'string') base.action = string(v.action, 'action');
    else { const action = object(v.action), type = action.type;
      if (!['compose', 'copy', 'reference', 'send', 'open'].includes(String(type))) throw new Error('Unknown action');
      base.action = { type: type as ConversationUiAction['type'], label: string(action.label, 'action.label'), ...(action.ref === undefined ? {} : { ref: string(action.ref, 'action.ref') }) };
      if (type === 'open' && !base.action.ref) throw new Error('Open action requires a reference');
    }
  }
  const required = v.required === undefined ? undefined : typeof v.required === 'boolean' ? v.required : (() => { throw new Error('required must be boolean'); })();
  if (v.type === 'choice') {
    if (!Array.isArray(v.options) || !v.options.length) throw new Error('Choice needs options');
    const options = v.options.map(option => { if (typeof option === 'string') return { key: `label:${string(option, 'option')}`, label: option }; const o = object(option); const label = string(o.label, 'option.label'); return { key: o.key === undefined ? `label:${label}` : string(o.key, 'option.key'), label }; });
    unique(options.map(option => option.key));
    if (v.allowOther !== undefined && typeof v.allowOther !== 'boolean') throw new Error('allowOther must be boolean');
    if (v.multiple !== undefined && typeof v.multiple !== 'boolean') throw new Error('multiple must be boolean');
    return { ...base, type: 'choice', options, ...(v.allowOther === undefined ? {} : { allowOther: v.allowOther as boolean }), ...(required === undefined ? {} : { required }), ...(v.multiple === undefined ? {} : { multiple: v.multiple as boolean }) };
  }
  if (v.type === 'input') {
    const inputType = v.inputType ?? 'text';
    if (!['text', 'number', 'range', 'date', 'textarea'].includes(String(inputType))) throw new Error('Unknown input type');
    const node: ConversationUiInput = { ...base, type: 'input', inputType: inputType as ConversationUiInput['inputType'], ...(required === undefined ? {} : { required }) };
    for (const name of ['min', 'max', 'step'] as const) if (v[name] !== undefined) { if (typeof v[name] !== 'number' || !Number.isFinite(v[name])) throw new Error(`${name} must be finite`); node[name] = v[name] as number; }
    if (node.min !== undefined && node.max !== undefined && node.min > node.max) throw new Error('min exceeds max');
    if (node.step !== undefined && node.step <= 0) throw new Error('step must be positive');
    if (v.unit !== undefined) node.unit = string(v.unit, 'unit');
    if (v.placeholder !== undefined) node.placeholder = string(v.placeholder, 'placeholder');
    return node;
  }
  if (v.type === 'form') {
    if (!Array.isArray(v.fields) || !v.fields.length) throw new Error('Form needs fields');
    const fields = v.fields.map(field => { const f = object(field); const node = normalizeConversationUi(f, f.key === undefined ? `label:${string(f.label, 'field.label')}` : string(f.key, 'field.key')); if (node.type !== 'choice' && node.type !== 'input') throw new Error('Form fields must be choices or inputs'); return node; });
    unique(fields.map(field => field.key)); return { ...base, type: 'form', fields };
  }
  if (v.type === 'disclosure') return { ...base, type: 'disclosure', content: string(v.content, 'content') };
  if (v.type === 'tabs') {
    if (!Array.isArray(v.tabs) || !v.tabs.length) throw new Error('Tabs needs tabs');
    const tabs = v.tabs.map(tab => { const t = object(tab), label = string(t.label, 'tab.label'); return { key: t.key === undefined ? `label:${label}` : string(t.key, 'tab.key'), label, content: string(t.content, 'tab.content') }; });
    unique(tabs.map(tab => tab.key)); return { ...base, type: 'tabs', tabs };
  }
  if (v.type === 'embed' || v.type === 'object') {
    const ref = string(v.ref, 'ref');
    if (v.type === 'embed' && !/^ui:[a-zA-Z0-9_-]+@[1-9]\d*$/.test(ref)) throw new Error('Embed requires a fixed ui revision');
    return { ...base, type: v.type, ref };
  }
  throw new Error('Unknown interaction type');
}

/** Only unindented, top-level assistant fences are executable. Outer examples stay opaque. */
export function parseConversationContent(text: string, options: { role: string; streaming?: boolean }): ConversationContentPart[] {
  if (options.role !== 'assistant') return [{ kind: 'markdown', text, start: 0, end: text.length }];
  const parts: ConversationContentPart[] = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
  let htmlEnd: RegExp | undefined;
  let markdownStart = 0, outer: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, body = line[0].replace(/\r?\n$/, ''), start = line.index!;
    if (htmlEnd) { if (htmlEnd.test(body)) htmlEnd = undefined; continue; }
    if (!outer) {
      const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(body);
      const blockTag = /^ {0,3}<\/?(?:address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?:\s|\/?>|$)/i.test(body);
      const end = rawTag ? new RegExp(`</${rawTag[1]}\\s*>`, 'i') : /^ {0,3}<!--/.test(body) ? /-->/ : /^ {0,3}<\?/.test(body) ? /\?>/ : /^ {0,3}<!\[CDATA\[/.test(body) ? /\]\]>/ : /^ {0,3}<![A-Z]/.test(body) ? />/ : blockTag ? /^\s*$/ : undefined;
      if (end) { if (!end.test(body)) htmlEnd = end; continue; }
    }
    if (outer) { if (new RegExp(`^ {0,3}${outer.char}{${outer.length},}\\s*$`).test(body)) outer = undefined; continue; }
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(body);
    if (!opening) continue;
    const marker = opening[2]!, info = opening[3]!.trim();
    if (info !== 'varin-ui' || opening[1]) { outer = { char: marker[0]!, length: marker.length }; continue; }
    let close = i + 1;
    for (; close < lines.length; close++) if (new RegExp(`^${marker[0]}{${marker.length},}\\s*$`).test(lines[close]![0].replace(/\r?\n$/, ''))) break;
    const end = close < lines.length ? lines[close]!.index! + lines[close]![0].length : text.length;
    if (start > markdownStart) parts.push({ kind: 'markdown', text: text.slice(markdownStart, start), start: markdownStart, end: start });
    const raw = text.slice(start, end);
    if (close === lines.length) parts.push(options.streaming ? { kind: 'pending', raw, start, end } : { kind: 'invalid', raw, start, end, error: 'Incomplete interaction' });
    else {
      try { const definition: unknown = JSON.parse(text.slice(start + line[0].length, lines[close]!.index!)); const node = normalizeConversationUi(definition); parts.push({ kind: 'ui', raw, start, end, fragmentKey: `offset:${start}`, node, definition }); }
      catch (error) { parts.push({ kind: 'invalid', raw, start, end, error: error instanceof Error ? error.message : 'Invalid interaction' }); }
    }
    markdownStart = end; i = close;
  }
  if (markdownStart < text.length || !parts.length) parts.push({ kind: 'markdown', text: text.slice(markdownStart), start: markdownStart, end: text.length });
  return parts;
}
export function conversationUiFields(node: ConversationUiNode): ConversationUiField[] { return node.type === 'form' ? node.fields : node.type === 'choice' || node.type === 'input' ? [node] : []; }
export function conversationUiText(node: ConversationUiNode, values?: Record<string, JsonValue>): string {
  const lines: string[] = [];
  if (node.action) lines.push(typeof node.action === 'string' ? node.action : node.action.label);
  if (node.type === 'form' && node.label) lines.push(node.label);
  for (const field of conversationUiFields(node)) {
    // Without an observed view, list available options, never imply that all were selected.
    if (field.type === 'choice' && values === undefined) {
      lines.push(`${field.label ?? field.key}：\n${field.options.map(option => `- ${option.label}`).join('\n')}`);
      continue;
    }
    const value = values && Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    const shown = field.type === 'choice' ? (values ? field.options.filter(option => Array.isArray(value) ? value.includes(option.key) : value === option.key) : field.options).map(option => option.label).join('、') : value == null ? '' : String(value);
    const other = field.type === 'choice' && field.allowOther && typeof values?.[`${field.key}:other`] === 'string' ? values[`${field.key}:other`] as string : '';
    lines.push(`${field.label ?? field.key}：${[shown, other].filter(Boolean).join('、')}${field.type === 'input' && shown && field.unit ? ` ${field.unit}` : ''}`);
  }
  if (node.type === 'disclosure') lines.push(node.label ?? '', node.content);
  if (node.type === 'tabs') lines.push(node.label ?? '', ...node.tabs.map(tab => `${tab.label}\n${tab.content}`));
  if (node.type === 'embed' || node.type === 'object') lines.push(node.label ?? '', node.ref);
  return lines.filter(Boolean).join('\n\n');
}
export function migrateConversationUiState(previous: ConversationUiNode, next: ConversationUiNode, values: Record<string, JsonValue>): { values: Record<string, JsonValue>; resetKeys: string[] } {
  const old = new Map(conversationUiFields(previous).map(field => [field.key, field]));
  const result: Record<string, JsonValue> = Object.create(null), resetKeys: string[] = [];
  for (const field of conversationUiFields(next)) {
    const before = old.get(field.key), value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    const other = values[`${field.key}:other`];
    if (value === undefined && !(field.type === 'choice' && field.allowOther && typeof other === 'string')) continue;
    if (!before || before.type !== field.type || before.label !== field.label || field.type === 'input' && before.type === 'input' && (before.inputType !== field.inputType || before.unit !== field.unit)) { resetKeys.push(field.key); continue; }
    if (field.type === 'input' && (field.inputType === 'number' || field.inputType === 'range') && value !== '') {
      const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(numeric) || field.min !== undefined && numeric < field.min || field.max !== undefined && numeric > field.max) { resetKeys.push(field.key); continue; }
    }
    if (field.type === 'choice' && before.type === 'choice') {
      const valid = new Set(field.options.filter(option => before.options.some(oldOption => oldOption.key === option.key && oldOption.label === option.label)).map(option => option.key));
      if (Boolean(field.multiple) !== Boolean(before.multiple)) { resetKeys.push(field.key); continue; }
      if (Array.isArray(value)) {
        const retained = value.filter(v => typeof v === 'string' && valid.has(v));
        if (retained.length !== value.length) resetKeys.push(field.key);
        result[field.key] = retained;
      } else if (value !== undefined && (typeof value !== 'string' || !valid.has(value))) { resetKeys.push(field.key); }
      else if (value !== undefined) result[field.key] = value;
      if (field.allowOther && before.allowOther && typeof other === 'string') result[`${field.key}:other`] = other;
      continue;
    }
    if (value !== undefined) result[field.key] = value;
    if (field.type === 'choice' && field.allowOther && before.type === 'choice' && before.allowOther && typeof values[`${field.key}:other`] === 'string') result[`${field.key}:other`] = values[`${field.key}:other`]!;
  }
  return { values: result, resetKeys };
}

/** Per-message append parser: committed fences retain their node identity as tokens arrive. */
export function createConversationContentParser() {
  let previous = '', stableEnd = 0;
  let stable: ConversationContentPart[] = [], previousParts: ConversationContentPart[] = [];
  return (text: string, options: { role: string; streaming?: boolean }): ConversationContentPart[] => {
    if (options.role !== 'assistant' || !text.startsWith(previous)) { stableEnd = 0; stable = []; }
    const tail = parseConversationContent(text.slice(stableEnd), options).map(part => ({ ...part, start: part.start + stableEnd, end: part.end + stableEnd,
      ...(part.kind === 'ui' ? { fragmentKey: `offset:${part.start + stableEnd}` } : {}) })) as ConversationContentPart[];
    // A closing fence at the token frontier must remain reparsable, but an
    // unchanged complete definition should retain its identity on commit/repaint.
    const prior = new Map(previousParts.map(part => [`${part.kind}:${part.start}:${part.end}`, part]));
    const result = [...stable, ...tail.map(part => {
      const old = prior.get(`${part.kind}:${part.start}:${part.end}`);
      return part.kind === 'ui' && old?.kind === 'ui' && old.raw === part.raw ? old : part;
    })]; previous = text; previousParts = result;
    // Incomplete/fallback trailing content must be re-parsed, since it can still receive a close.
    let last = -1;
    result.forEach((part, index) => { if ((part.kind === 'ui' || part.kind === 'invalid' && part.error !== 'Incomplete interaction') && text[part.end - 1] === '\n') last = index; });
    if (last >= 0) { stable = result.slice(0, last + 1); stableEnd = stable.at(-1)!.end; }
    return result;
  };
}

/** Readable copy/export projection. Raw history and range offsets remain untouched.
 * No view values are inferred: whole-message exports describe available controls.
 * Unsupported, invalid and unfinished content retains its original source. */
export function conversationContentText(text: string, options: { role: string; streaming?: boolean }): string {
  return parseConversationContent(text, options).map(part => {
    if (part.kind === 'markdown') return part.text;
    if (part.kind !== 'ui') return part.raw;
    return conversationUiText(part.node) + (part.raw.endsWith('\n') ? '\n' : '');
  }).join('');
}
