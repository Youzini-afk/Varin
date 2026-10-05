import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { expect, test } from 'vitest';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './select';

const selectedText = (node: React.ReactElement) => (
  parseHTML(renderToStaticMarkup(node)).document.querySelector('[data-slot="select-value"]')?.textContent
);

test('shows the menu label before opening, including grouped options and updated translations', () => {
  const render = (value: string, defaultLabel: string) => selectedText(
    <Select value={value}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>
        <SelectItem value="__default__">{defaultLabel}</SelectItem>
        {['global', 'high'].map((option) => <SelectItem key={option} value={option}>{option === 'global' ? '全局' : '高'}</SelectItem>)}
      </SelectGroup></SelectContent>
    </Select>,
  );
  expect(render('global', 'Pi 默认值')).toBe('全局');
  expect(render('high', 'Pi 默认值')).toBe('高');
  expect(render('__default__', 'Pi 默认值')).toBe('Pi 默认值');
  expect(render('__default__', 'Pi default')).toBe('Pi default');
});

test('keeps empty-value placeholders, explicit item labels and custom value renderers', () => {
  expect(selectedText(<Select value=""><SelectValue placeholder="选择一个选项" /></Select>)).toBe('选择一个选项');
  expect(selectedText(<Select value="global" items={{ global: 'Explicit label' }}>
    <SelectValue /><SelectContent><SelectItem value="global">Menu label</SelectItem></SelectContent>
  </Select>)).toBe('Explicit label');
  expect(selectedText(<Select value="global"><SelectValue>{value => `Custom: ${value}`}</SelectValue></Select>)).toBe('Custom: global');
});
