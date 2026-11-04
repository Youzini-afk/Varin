import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const native = { mode: 'dark', splash: {
  light: { background: '#fdf6e3', foreground: '#657b83' },
  dark: { background: '#002b36', foreground: '#839496' },
} };

for (const page of ['index.html', 'mini-chat.html']) {
  const html = readFileSync(new URL(`../../web/${page}`, import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes("localStorage.getItem('varin.theme.v1')"))!;
  assert.ok(script, `${page} must have its production prepaint script`);
  const paint = (options: { stored?: string; native?: unknown; dark?: boolean; denied?: boolean } = {}) => {
    const classes: string[] = [], attributes = new Map<string, string>(), styles = new Map<string, string>();
    let writes = 0;
    vm.runInNewContext(script, {
      window: { __VARIN_STARTUP_THEME__: options.native, matchMedia: () => ({ matches: options.dark ?? false }) },
      localStorage: {
        getItem: () => { if (options.denied) throw new Error('Storage denied'); return options.stored ?? null; },
        setItem: () => { writes++; },
      },
      document: { documentElement: {
        classList: { add: (value: string) => classes.push(value) },
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        style: { setProperty: (name: string, value: string) => styles.set(name, value) },
      } },
      CSS: { supports: (_: string, value: string) => /^#[a-f0-9]{6}$/i.test(value) },
      console,
    });
    assert.equal(writes, 0, 'First paint must not impersonate a migration import');
    return { classes, attributes, styles };
  };

  test(`${page}: fresh desktop paints saved palette before frontend import`, () => {
    const first = paint({ native });
    assert.deepEqual(first.classes, ['dark']);
    assert.equal(first.attributes.get('data-splash-variant'), 'dark');
    assert.equal(first.styles.get('--splash-background-dark'), '#002b36');
    assert.equal(first.styles.get('--splash-stroke-light'), '#657b83');
  });
  test(`${page}: existing frontend preferences stay authoritative`, () => {
    const current = paint({ native, stored: JSON.stringify({ mode: 'light', splash: {
      light: { background: '#123456', foreground: '#654321' },
    } }) });
    assert.deepEqual(current.classes, ['light']);
    assert.equal(current.styles.get('--splash-background-light'), '#123456');
  });
  test(`${page}: absent native data retains web defaults and system mode follows the OS`, () => {
    assert.deepEqual(paint({ dark: true }).classes, ['dark']);
    assert.equal(paint().styles.size, 1);
    assert.deepEqual(paint({ native: { ...native, mode: 'system' }, dark: false }).classes, ['light']);
  });
  test(`${page}: inaccessible or malformed storage falls back without changing it`, () => {
    for (const options of [{ denied: true }, { stored: '{invalid' }, { stored: '{"mode":"unknown"}' }]) {
      assert.equal(paint({ native, ...options }).styles.get('--splash-background-dark'), '#002b36');
    }
  });
  test(`${page}: invalid colors cannot become CSS while valid colors survive`, () => {
    const invalid = paint({ native: { mode: 'dark', splash: { dark: {
      background: '</script><script>throw new Error()</script>', foreground: '#ffffff',
    } } } });
    assert.equal(invalid.styles.has('--splash-background-dark'), false);
    assert.equal(invalid.styles.get('--splash-stroke-dark'), '#ffffff');
  });
}
