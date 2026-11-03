import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerMenu, type ComposerMenuHandle, type ComposerMenuItem } from './ComposerMenu';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('../useMobileAutocompleteMaxHeight', () => ({ useMobileAutocompleteMaxHeight: () => undefined }));
vi.mock('motion/react', () => ({ useIsPresent: () => true, motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>) } }));
let root: Root, container: HTMLDivElement;
const menu = React.createRef<ComposerMenuHandle>();
const choose = vi.fn(), close = vi.fn();
const item = (id: string): ComposerMenuItem => ({ id, group: 'Skills', label: id });
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
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

it('subview Enter never falls through to the ordinary composer submit path', () => {
  act(() => root.render(<ComposerMenu ref={menu} id="menu" scope="host:thread" items={[item('model')]} query="model" onChoose={choose} onClose={close} title="Model" onBack={close}><input aria-label="name" /></ComposerMenu>));
  expect(menu.current!.handleKeyDown('Enter')).toBe(true);
  const input = container.querySelector('input')!;
  const event = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'key', { value: 'Enter' });
  act(() => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true); expect(choose).not.toHaveBeenCalled();
});

it('keeps embedded panel button actions while preventing their default outer-form submission', () => {
  const action = vi.fn();
  act(() => root.render(<form><ComposerMenu ref={menu} id="menu" scope="host:thread" items={[]} query="goal" onChoose={choose} onClose={close} title="Goal"><button onClick={action}>Create goal</button></ComposerMenu></form>));
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Create goal')!;
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  act(() => button.dispatchEvent(event));
  expect(action).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
});

it('keeps retry and pagination controls outside the listbox option semantics', () => {
  const retry = vi.fn();
  act(() => root.render(<ComposerMenu ref={menu} id="menu" scope="host:thread" items={[item('one')]} query="" onChoose={choose} onClose={close} status={<button type="button" onClick={retry}>Retry files</button>} />));
  const button = container.querySelector('button')!;
  expect(button.closest('[role="listbox"]')).toBeNull();
  act(() => button.click()); expect(retry).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="listbox"] [role="option"]')?.textContent).toContain('one');
});
