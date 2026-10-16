/** Streaming JSON value reader. Each code unit is scanned once; unfinished strings are
 * visible without inventing closing quotes, braces or future escape bytes. */
export class PartialJson {
  value: unknown;
  readonly completeFields = new Set<string>();
  private readonly completed = new WeakMap<object, Set<string>>();
  fieldComplete(value: object, key: string) { return this.completed.get(value)?.has(key) ?? false; }
  private stack: { value: Record<string, unknown> | unknown[]; key?: string; expectingKey: boolean }[] = [];
  private string: { key: boolean; parts: string[]; raw: string; escaping: boolean; unicode: string | null } | null = null;
  private primitive = '';
  private assign(value: unknown) {
    const parent = this.stack.at(-1);
    if (!parent) this.value = value;
    else if (Array.isArray(parent.value)) parent.value.push(value);
    else if (parent.key !== undefined) { parent.value[parent.key] = value; delete parent.key; }
  }
  private flushString() {
    const current = this.string; if (!current) return;
    let text = current.parts.join('') + current.raw;
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    const parent = this.stack.at(-1);
    if (!current.key && parent && !Array.isArray(parent.value) && parent.key !== undefined) parent.value[parent.key] = text;
  }
  feed(delta: string): unknown {
    for (const char of delta) {
      const current = this.string;
      if (current) {
        if (current.unicode !== null) {
          current.unicode += char;
          if (current.unicode.length === 4) { current.raw += String.fromCharCode(parseInt(current.unicode, 16)); current.unicode = null; }
        } else if (current.escaping) {
          current.escaping = false;
          if (char === 'u') current.unicode = '';
          else current.raw += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[char] ?? char;
        } else if (char === '\\') current.escaping = true;
        else if (char === '"') {
          const text = current.parts.join('') + current.raw;
          this.string = null;
          const parent = this.stack.at(-1);
          if (current.key && parent) { parent.key = text; parent.expectingKey = false; }
          else {
            if (parent?.key) {
              let keys = this.completed.get(parent.value); if (!keys) { keys = new Set(); this.completed.set(parent.value, keys); }
              keys.add(parent.key);
              if (parent === this.stack[0]) this.completeFields.add(parent.key);
            }
            this.assign(text);
          }
        } else current.raw += char;
        continue;
      }
      if (this.primitive && /[\s,\]}]/.test(char)) {
        try { this.assign(JSON.parse(this.primitive)); } catch { /* A malformed call will fail at its original admission. */ }
        this.primitive = '';
      }
      if (char === '{' || char === '[') {
        const value = char === '{' ? {} : []; this.assign(value);
        this.stack.push({ value, expectingKey: char === '{' });
      } else if (char === '}' || char === ']') this.stack.pop();
      else if (char === '"') this.string = { key: this.stack.at(-1)?.expectingKey ?? false, parts: [], raw: '', escaping: false, unicode: null };
      else if (char === ',') { const parent = this.stack.at(-1); if (parent && !Array.isArray(parent.value)) parent.expectingKey = true; }
      else if (char !== ':' && !/\s/.test(char)) this.primitive += char;
    }
    this.flushString();
    return this.value;
  }
}
