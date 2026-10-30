const SVG_NS = 'http://www.w3.org/2000/svg';

type Slot = { node: number; attribute?: string; raw: string };
type Binding = Slot & { target: Element | Text; namespace?: string | null };

/** Lex only the SVG emitted by our scene generators. Values remain separate from structure,
 * so animation frames can update the existing DOM without parsing a new SVG document. */
function describe(markup: string): { structure: string; slots: Slot[] } {
  const slots: Slot[] = [];
  let node = -1;
  const structure = markup.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g, token => {
    if (token.startsWith('</') || token.startsWith('<!--')) return token;
    const index = ++node;
    if (!token.startsWith('<')) { slots.push({ node: index, raw: token }); return '\u0001'; }
    return token.replace(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_match, attribute: string, double: string | undefined, single: string | undefined) => {
      slots.push({ node: index, attribute, raw: double ?? single ?? '' });
      return `${attribute}="\u0001"`;
    });
  });
  return { structure, slots };
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name: string) => {
  if (!name.startsWith('#')) return entities[name] ?? match;
  return String.fromCodePoint(parseInt(name.slice(name[1]?.toLowerCase() === 'x' ? 2 : 1), name[1]?.toLowerCase() === 'x' ? 16 : 10));
});

/** Keys are local to siblings. Seats and their children retain their authored identities
 * across a roster change; unkeyed primitives retain their position within the same shape. */
function key(node: Node): string | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  for (const name of ['id', 'data-spatial-squad', 'data-project-slot', 'data-child-key', 'data-lead-position', 'data-spatial-behind']) {
    if (element.hasAttribute(name)) return `${element.nodeName}:${name}:${element.getAttribute(name)}`;
  }
  return null;
}
const compatible = (a: Node, b: Node) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function attributes(target: Element, source: Element) {
  for (const attribute of [...target.attributes]) {
    if (!source.hasAttributeNS(attribute.namespaceURI, attribute.localName)) target.removeAttributeNS(attribute.namespaceURI, attribute.localName);
  }
  for (const attribute of [...source.attributes]) {
    if (target.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value)
      target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
}

function reconcile(target: Element, source: Element) {
  const keyed = new Map([...target.childNodes].flatMap(node => { const value = key(node); return value === null ? [] : [[value, node] as const]; }));
  let cursor: Node | null = target.firstChild;
  for (const next of [...source.childNodes]) {
    const identity = key(next);
    let current: Node | undefined = identity !== null ? keyed.get(identity) : cursor && key(cursor) === null && compatible(cursor, next) ? cursor : undefined;
    if (!current || !compatible(current, next)) {
      current = next.cloneNode(true);
      target.insertBefore(current, cursor);
    } else {
      if (current !== cursor) target.insertBefore(current, cursor);
      if (current.nodeType === 1) { attributes(current as Element, next as Element); reconcile(current as Element, next as Element); }
      else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; target.removeChild(cursor); cursor = next; }
}

/** A scene layer's retained DOM. A structural change is parsed once and reconciled; ordinary
 * frames only assign changed attribute/text values. This does not change authored timing. */
export class RetainedSvg {
  private markup: string | null = null;
  private structure: string | null = null;
  private bindings: Binding[] = [];
  constructor(private readonly target: Element) {}

  update(markup: string): void {
    if (this.markup === markup) return;
    const description = describe(markup);
    if (description.structure !== this.structure) {
      const source = this.target.ownerDocument.createElementNS(SVG_NS, 'svg');
      source.innerHTML = markup;
      reconcile(this.target, source);
      // Entity decoding may produce adjacent Text nodes; one authored text run is one binding.
      this.target.normalize();
      const nodes: Node[] = [];
      const walker = this.target.ownerDocument.createTreeWalker(this.target, 1 | 4); // Element and Text.
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      this.bindings = description.slots.map(slot => {
        const target = nodes[slot.node] as Element | Text;
        return { ...slot, target, namespace: slot.attribute ? (target as Element).getAttributeNode(slot.attribute)?.namespaceURI ?? null : null };
      });
      this.structure = description.structure;
    } else {
      for (let i = 0; i < this.bindings.length; i++) {
        const binding = this.bindings[i]!, raw = description.slots[i]!.raw;
        if (binding.raw === raw) continue;
        const value = decode(raw);
        if (binding.attribute) (binding.target as Element).setAttributeNS(binding.namespace ?? null, binding.attribute, value);
        else binding.target.nodeValue = value;
        binding.raw = raw;
      }
    }
    this.markup = markup;
  }
}
