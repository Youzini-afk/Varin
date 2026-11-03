import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerMenu, type ComposerMenuHandle, type ComposerMenuItem } from './ComposerMenu';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('../useMobileAutocompleteMaxHeight', () => ({ useMobileAutocompleteMaxHeight: () => undefined }));
vi.mock('motion/react', () => ({ motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>) } }));
let root: Root, container: HTMLDivElement;
const menu = React.createRef<ComposerMenuHandle>();
const choose = vi.fn(), close = vi.fn();
const item = (id: string): ComposerMenuItem => ({ id, group: 'Skills', label: id });
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); choose.mockReset(); close.mockReset();
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const render = (items: ComposerMenuItem[], query = '') => act(() => root.render(<ComposerMenu ref={menu} id="menu" scope="host:thread" items={items} query={query} onChoose={choose} onClose={close} />));
it('retains the selected identity through asynchronous insertion, then chooses the nearest survivor', () => {
  render([item('a'), item('b'), item('c')]);
  act(() => { menu.current!.handleKeyDown('ArrowDown'); });
  render([item('new'), item('a'), item('b'), item('c')]);
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('b');
  act(() => { menu.current!.handleKeyDown('Enter'); }); expect(choose).toHaveBeenLastCalledWith('b', 'confirm');
  render([item('new'), item('a'), item('c')]);
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('a');
});
it('distinguishes completion from confirmation and lets an empty menu release Enter and Tab', () => {
  render([item('a')]);
  act(() => { menu.current!.handleKeyDown('Tab'); }); expect(choose).toHaveBeenLastCalledWith('a', 'complete');
  render([]);
  expect(menu.current!.handleKeyDown('Tab')).toBe(false); expect(menu.current!.handleKeyDown('Enter')).toBe(false);
  act(() => { menu.current!.handleKeyDown('Escape'); }); expect(close).toHaveBeenCalledTimes(1);
});
it('query changes discard the old selection, same-name entries keep distinct identities', () => {
  render([item('one'), item('two')]); act(() => { menu.current!.handleKeyDown('ArrowDown'); });
  render([{ ...item('one'), label: 'Review' }, { ...item('two'), label: 'Review' }], 'Review');
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  act(() => { menu.current!.handleKeyDown('Enter'); }); expect(choose).toHaveBeenLastCalledWith('one', 'confirm');
});
