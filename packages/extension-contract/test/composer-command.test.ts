import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVarinCommandContributionData } from '../src/surface-contributions.js';

test('composer commands are explicit optional contributions with validated names and interactions', () => {
  assert.deepEqual(parseVarinCommandContributionData({ title: 'Export' }), { title: 'Export' });
  assert.deepEqual(parseVarinCommandContributionData({ title: 'Export', composer: { name: '导出:notes', group: 'conversation', interaction: 'select' } }), {
    title: 'Export', composer: { name: '导出:notes', group: 'conversation', interaction: 'select' },
  });
  for (const composer of [
    { name: '/export', group: 'conversation', interaction: 'action' },
    { name: 'export notes', group: 'conversation', interaction: 'action' },
    { name: 'export', group: 'unknown', interaction: 'action' },
    { name: 'export', group: 'conversation', interaction: 'automatic' },
  ]) assert.throws(() => parseVarinCommandContributionData({ title: 'Export', composer }), /Invalid composer command/);
});
