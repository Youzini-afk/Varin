import { afterEach, expect, test } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { LOCALES } from '@varin/application-client/locale';
import { getNativeLocale, localizeNativeMenu, nativeContextMenuLabels, nativeText, setNativeLocale } from './native-i18n.js';

afterEach(() => setNativeLocale('en'));

test('native menu roles follow app language and keep accelerators, callbacks and native behavior', () => {
  const click = () => {};
  const source: MenuItemConstructorOptions[] = [{ label: 'Edit', submenu: [
    { role: 'undo' }, { label: 'Copy', accelerator: 'CmdOrCtrl+C', click }, { type: 'separator' }, { role: 'paste' },
  ] }];
  setNativeLocale('zh_Hant_TW');
  expect(getNativeLocale()).toBe('zh-TW');
  const menu = localizeNativeMenu(source);
  expect(menu[0]?.label).toBe('編輯');
  expect(menu[0]?.submenu).toEqual([
    { role: 'undo', label: '復原' }, { label: '複製', accelerator: 'CmdOrCtrl+C', click },
    { type: 'separator' }, { role: 'paste', label: '貼上' },
  ]);
  expect(source[0]?.label).toBe('Edit');
  setNativeLocale('fr-FR');
  expect(localizeNativeMenu(source)[0]?.label).toBe('Édition');
});

test('already registered context labels update without new handlers and preserve selection placeholders', () => {
  const labels = nativeContextMenuLabels;
  setNativeLocale('zh-CN');
  expect(labels.copy).toBe('复制');
  expect(labels.lookUpSelection).toBe('查询“{selection}”');
  setNativeLocale('ja-JP');
  expect(labels.copy).toBe('コピー');
  expect(nativeText('Connect to “{label}”?', { label: 'My $& server' })).toBe('「My $& server」に接続しますか？');
  setNativeLocale('unsupported');
  expect(labels.copy).toBe('Copy');
});

test('every supported language provides native actions, dialogs and control handoff text', () => {
  for (const locale of LOCALES) {
    setNativeLocale(locale);
    for (const key of ['File', 'Quit Varin?', 'Select Folder', 'Take over'] as const) {
      expect(nativeText(key)).toBeTruthy();
      if (locale !== 'en') expect(nativeText(key)).not.toBe(key);
    }
    expect(nativeText('{count} awaiting approval', { count: 3 })).toContain('3');
  }
});
