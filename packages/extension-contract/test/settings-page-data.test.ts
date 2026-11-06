import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVarinSettingsPageContributionData } from '../src/surface-contributions.js';

test('settings pages preserve optional primary entry and reject ambiguous value types', () => {
  const data = { slug: 'account', title: 'Account' };
  assert.equal(parseVarinSettingsPageContributionData(data).primary, undefined);
  assert.equal(parseVarinSettingsPageContributionData({ ...data, primary: true }).primary, true);
  assert.equal(parseVarinSettingsPageContributionData({ ...data, primary: false }).primary, false);
  assert.throws(() => parseVarinSettingsPageContributionData({ ...data, primary: 'yes' }), /primary must be a boolean/);
});
