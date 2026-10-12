import React, { act } from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { I18nProvider } from '@/lib/i18n';
import type { ServiceRoutingOption } from '@/lib/extensions/service-routing-options';
import { ServiceRoutingControl, type ServiceRoutingControlProps } from './ServiceRoutingControl';

const serviceId = 'review.context';
const key = (name: string) => `${name}:host:${serviceId}@1`;
const providers: ServiceRoutingOption[] = ['a', 'b', 'c'].map((name) => ({
  descriptor: { id: serviceId, version: 1, multiple: true, contract: { composition: 'ordered', methods: {} } },
  extensionId: name, providerKey: key(name), status: 'declared',
}));
let root: Root | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();
const setGlobal = (name: string, value: unknown) => {
  if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

async function mount(selection: ServiceRoutingControlProps['selection'], options: { composition?: 'ordered' } = { composition: 'ordered' }) {
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  setGlobal('window', window);
  setGlobal('document', window.document);
  setGlobal('HTMLElement', window.HTMLElement);
  setGlobal('Element', window.Element);
  setGlobal('Node', window.Node);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const selections: ServiceRoutingControlProps['selection'][] = [];
  function Field() {
    const [value, setValue] = React.useState(selection);
    return <I18nProvider><ServiceRoutingControl busy={false} composition={options.composition}
      extensionNames={new Map([['a', 'A'], ['b', 'B'], ['c', 'C']])} providers={providers}
      selection={value} onSelect={(next) => { selections.push(next); setValue(next); }} /></I18nProvider>;
  }
  root = createRoot(window.document.getElementById('app')!);
  await act(async () => root!.render(<Field />));
  const click = async (label: string) => {
    const button = [...window.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label);
    assert.ok(button, label);
    await act(async () => button!.click());
  };
  const members = () => [...window.document.querySelectorAll('[data-provider-key]')].map((row) => row.getAttribute('data-provider-key'));
  const selectedText = () => window.document.querySelector('[data-slot="select-value"]')?.textContent;
  return { click, document: window.document, members, selectedText, selections };
}

test('the actual ordered control adds, removes and reorders exactly the selected providers', async () => {
  const ui = await mount([key('a'), key('b')]);
  assert.deepEqual(ui.members(), [key('a'), key('b')]);
  assert.deepEqual(ui.selections, []);
  await ui.click('Move B earlier');
  assert.deepEqual(ui.members(), [key('b'), key('a')]);
  await ui.click('Remove A');
  assert.deepEqual(ui.members(), [key('b')]);
  await ui.click('Add A');
  assert.deepEqual(ui.members(), [key('b'), key('a')]);
  await ui.click('Move B later');
  assert.deepEqual(ui.members(), [key('a'), key('b')]);
  assert.deepEqual(ui.selections, [[key('b'), key('a')], [key('b')], [key('b'), key('a')], [key('a'), key('b')]]);
  assert.equal(ui.selectedText(), 'Ordered provider list');
});

test('missing collection members remain visible in full when no ordered contract is available', async () => {
  const ui = await mount([key('missing'), key('a')], {});
  assert.deepEqual(ui.members(), [key('missing'), key('a')]);
  assert.equal(ui.selectedText(), 'Ordered provider list');
  assert.ok(ui.document.body.textContent?.includes(key('missing')));
  assert.match(ui.document.body.textContent ?? '', /Unavailable provider/);
  assert.match(ui.document.body.textContent ?? '', /No installed contract currently declares ordered composition\./);
  assert.deepEqual(ui.selections, []);
  await ui.click('Move A earlier');
  assert.deepEqual(ui.selections, [[key('a'), key('missing')]]);
});

for (const [selection, label] of [
  [null, 'Automatic'],
  [[key('a')], 'Ordered provider list'],
  [[], 'No providers (explicit empty list)'],
] as const) test(`renders ${label} without silently changing routing`, async () => {
  const ui = await mount(selection);
  assert.equal(ui.selectedText(), label);
  assert.deepEqual(ui.selections, []);
});

test('removing the last member sends an explicit empty list rather than automatic routing', async () => {
  const ui = await mount([key('a')]);
  await ui.click('Remove A');
  assert.deepEqual(ui.selections, [[]]);
  assert.equal(ui.selectedText(), 'No providers (explicit empty list)');
  assert.match(ui.document.body.textContent ?? '', /No providers run for this scope\./);
  await ui.click('Add B');
  assert.deepEqual(ui.selections, [[], [key('b')]]);
});

test('single-contract selection uses the same one-element array', async () => {
  const ui = await mount([key('a')], {});
  assert.equal(ui.selectedText(), 'Single provider: A');
  assert.deepEqual(ui.selections, []);
});
