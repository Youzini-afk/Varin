import { parseHTML } from 'linkedom';
import { expect, test } from 'vitest';
import { hasOpenDropdown } from './keyboard-shortcut-dom';

test('blocks shortcuts only while a dropdown or select popup is open', () => {
  const { document } = parseHTML('<html><body><div role="listbox">Prompt navigator</div></body></html>');
  expect(hasOpenDropdown(document)).toBe(false);
  for (const slot of ['dropdown-menu-content', 'select-content']) {
    const popup = document.createElement('div');
    popup.dataset.slot = slot;
    document.body.append(popup);
    expect(hasOpenDropdown(document)).toBe(false);
    popup.setAttribute('data-open', '');
    expect(hasOpenDropdown(document)).toBe(true);
    popup.remove();
    expect(hasOpenDropdown(document)).toBe(false);
  }
});
