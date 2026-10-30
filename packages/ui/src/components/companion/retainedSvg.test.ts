import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { RetainedSvg } from './retainedSvg';

const surface = () => parseHTML('<html><body><svg></svg></body></html>').document.querySelector('svg')!;
const shape = (node: Node): unknown => node.nodeType === 1 ? {
  name: node.nodeName,
  attributes: [...(node as Element).attributes].map(attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a!.localeCompare(b!)),
  children: [...node.childNodes].map(shape),
} : node.nodeValue;

it('updates real SVG attributes and escaped text like a fresh parse while retaining its nodes', () => {
  const target = surface(), reference = surface(), writer = new RetainedSvg(target);
  const markup = (x: number, title: string) => `<g transform="translate(${x} 2)"><svg viewBox="0 0 ${x} 64"><path d="M0 0 L${x} 10" fill="#fff"/></svg><text x="${x}">${title}</text></g>`;
  writer.update(markup(10, '&lt;旧标题&gt; &amp; &#x4e2d;'));
  const group = target.firstChild, path = target.querySelector('path'), text = target.querySelector('text');
  for (const [x, title] of [[20, '新 &quot;标题&quot; &apos;甲&apos;'], [30, '&lt;script&gt; &amp; 保留文字']] as const) {
    const next = markup(x, title); writer.update(next); reference.innerHTML = next; reference.normalize();
    expect(shape(target)).toEqual(shape(reference));
    expect(target.firstChild).toBe(group); expect(target.querySelector('path')).toBe(path); expect(target.querySelector('text')).toBe(text);
  }
  expect(target.querySelector('script')).toBeNull();
});

it('keeps surviving seats and artwork when a roster changes or changes order', () => {
  const target = surface(), reference = surface(), writer = new RetainedSvg(target);
  const seat = (name: string, x: number, waiting = false) => `<g data-spatial-squad="${name}" transform="translate(${x} 0)"><svg><path d="M0 0 L10 10"/></svg>${waiting ? '<text>等待</text>' : ''}</g>`;
  writer.update(seat('A', 10) + seat('B', 20));
  const a = target.querySelector('[data-spatial-squad="A"]'), b = target.querySelector('[data-spatial-squad="B"]'), face = b!.querySelector('path');
  const next = seat('B', 30, true) + seat('A', 40);
  writer.update(next); reference.innerHTML = next;
  expect(shape(target)).toEqual(shape(reference)); expect(target.firstChild).toBe(b); expect(target.lastChild).toBe(a); expect(b!.querySelector('path')).toBe(face);
  writer.update(seat('B', 35));
  expect(target.firstChild).toBe(b); expect(b!.querySelector('path')).toBe(face); expect(target.querySelector('[data-spatial-squad="A"]')).toBeNull(); expect(target.querySelector('text')).toBeNull();
});
