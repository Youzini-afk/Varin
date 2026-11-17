import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { HarnessIcon } from './HarnessIcon';
import codex from '@/assets/harness-logos/codex.svg';
import opencode from '@/assets/harness-logos/opencode.svg';
import pi from '@/assets/harness-logos/pi.svg';
import kimi from '@/assets/harness-logos/kimi.png';
import qoder from '@/assets/harness-logos/qoder.svg';
import grok from '@/assets/harness-logos/grok.svg';
import cursorLight from '@/assets/harness-logos/cursor.svg';
import cursorDark from '@/assets/harness-logos/cursor-dark.svg';

const render = (props: React.ComponentProps<typeof HarnessIcon>) =>
  parseHTML(`<html><body>${renderToStaticMarkup(<HarnessIcon {...props} />)}</body></html>`).document;

it('uses dedicated product marks regardless of a profile name and leaves them decorative', () => {
  const document = render({ harness: 'codex', configurationId: 'opencode' });
  const image = document.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(codex);
  expect(image.getAttribute('alt')).toBe('');
  expect(image.getAttribute('draggable')).toBe('false');
});

it('retains known ACP product identity independently of the task or configuration display name', () => {
  expect(render({ harness: 'acp', configurationId: 'opencode' }).querySelector('img')?.getAttribute('src')).toBe(opencode);
  expect(render({ harness: 'acp', configurationId: 'renamed-config', profileId: 'kimi' }).querySelector('img')?.getAttribute('src')).toBe(kimi);
  expect(render({ harness: 'acp', configurationId: 'qoder' }).querySelector('img')?.getAttribute('src')).toBe(qoder);
  expect(render({ harness: 'acp', configurationId: 'grok' }).querySelector('img')?.getAttribute('src')).toBe(grok);
  for (const configurationId of ['custom', 'Claude Code', 'Codex']) {
    const document = render({ harness: 'acp', configurationId });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('use')?.getAttribute('href')).toBe('#varin-terminal');
  }
});

it('uses the bundled Pi outline and preserves color logos without blanket dark inversion', () => {
  expect(render({ harness: 'pi' }).querySelector('img')?.getAttribute('src')).toBe(pi);
  for (const configurationId of ['gemini', 'kimi']) {
    const image = render({ harness: 'acp', configurationId }).querySelector('img')!;
    expect(image.className).not.toContain('invert');
  }
  const cursor = render({ harness: 'acp', configurationId: 'cursor' });
  const images = [...cursor.querySelectorAll('img')];
  expect(images.find(image => image.getAttribute('src') === cursorLight)?.className).toContain('dark:hidden');
  expect(images.find(image => image.getAttribute('src') === cursorDark)?.className).toContain('dark:block');
});
