const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i;
const COLOR_CANDIDATE = /#[\da-f]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\r\n]*\)/gi;
const EXCLUDED = 'pre, code, a, kbd, samp, svg, math, .katex, [data-md-color], [data-md-action], [data-markdown="mermaid-block"]';

const literalColor = (value: string): boolean => HEX_COLOR.test(value)
  || COLOR_FUNCTION.test(value) && typeof CSS !== 'undefined' && CSS.supports('color', value);

/** Decorate sanitized reading content. Swatches contain no text and never enter copied source. */
export function decorateColorSwatches(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const wrap = (content: Node, color: string) => {
    const value = doc.createElement('span');
    value.setAttribute('data-md-color', color);
    value.title = color;
    // A single validated color property, never arbitrary model-authored style/HTML.
    value.style.setProperty('--md-color', color);
    value.append(content);
    return value;
  };
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.parentElement?.closest(EXCLUDED)) continue;
    const color = code.textContent?.trim() ?? '';
    if (!literalColor(color)) continue;
    const parent = code.parentNode;
    if (!parent) continue;
    const next = code.nextSibling;
    parent.insertBefore(wrap(code, color), next);
  }
  // Reject whole code/diagram subtrees; a large highlighted fence need not be scanned token by token.
  const walker = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: node => node.nodeType === 1
      ? (node as Element).matches(EXCLUDED) ? 2 /* REJECT */ : 3 /* SKIP */
      : 1 /* ACCEPT */,
  });
  const texts: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType !== 3) continue;
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest(EXCLUDED)) texts.push(node);
  }
  for (const node of texts) {
    const text = node.data;
    const matches = [...text.matchAll(COLOR_CANDIDATE)].filter(match => {
      const before = text[match.index! - 1] ?? '';
      const after = text.slice(match.index! + match[0].length);
      return !/[\w/#?=&.%\\-]/.test(before) && !/^[\w/\\-]|^\.\w/.test(after) && literalColor(match[0]);
    });
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(doc.createTextNode(text.slice(offset, match.index)));
      const label = doc.createElement('span');
      label.textContent = match[0];
      fragment.append(wrap(label, match[0]));
      offset = match.index! + match[0].length;
    }
    fragment.append(doc.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
}
