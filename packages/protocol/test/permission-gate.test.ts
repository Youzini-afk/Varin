import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGate, evaluatePermissionSubjects, mergePolicies, resolvePermissionMode, validatePermissionRule, type PermissionPolicy } from '../src/permission-gate.js';

describe('owner-declared permission subjects', () => {
  const params = { id: 'harness.permissions.mode' };
  it('does not turn an ordinary tool allow or bypass into management authority', () => {
    for (const policy of [
      { mode: 'normal', rules: [{ tool: 'settings_update', decision: 'allow' }] },
      { mode: 'normal', rules: [{ tool: '*', decision: 'allow' }] },
      { mode: 'bypass', rules: [] },
    ] satisfies PermissionPolicy[]) {
      assert.equal(evaluateGate('settings_update', params, policy).decision, 'allow');
      assert.equal(evaluateGate('settings_update', params, policy, 'settings:permissions').decision, 'ask');
    }
  });
  it('retains existing restrictions and admits only the exact delegated authority', () => {
    const allow = validatePermissionRule({ tool: 'settings_update', authority: 'settings:permissions', decision: 'allow' });
    assert.equal(allow.authority, 'settings:permissions');
    assert.equal(evaluateGate('settings_update', params, { mode: 'normal', rules: [allow] }, 'settings:permissions').decision, 'allow');
    assert.equal(evaluateGate('settings_update', params, { mode: 'bypass', rules: [allow] }, 'model-credentials:other').decision, 'ask');
    for (const decision of ['deny', 'ask'] as const) {
      assert.equal(evaluateGate('settings_update', params, { mode: 'bypass', rules: [
        { tool: 'settings_update', match: { param: 'id', pattern: '^harness\\.permissions\\.' }, decision }, allow,
      ] }, 'settings:permissions').decision, decision);
    }
    assert.throws(() => validatePermissionRule({ tool: 'settings_update', authority: '', decision: 'allow' }), /authority/);
  });
  it('evaluates every canonical target, independent of the surrounding batch shape', () => {
    const policy: PermissionPolicy = { mode: 'normal', rules: [
      { tool: 'settings_update', match: { param: 'id', pattern: '^harness\\.permissions\\.' }, decision: 'deny' },
      { tool: 'settings_update', decision: 'allow' },
    ] };
    assert.equal(evaluatePermissionSubjects([
      { tool: 'settings_update', arguments: { id: 'appearance.time-format' } },
      { tool: 'settings_update', arguments: params, authority: 'settings:permissions' },
    ], policy).decision, 'deny');
  });
  it('keeps project constraints ahead of explicit user authority grants', () => {
    const policy = mergePolicies({ mode: 'bypass', rules: [{ tool: 'settings_update', authority: 'settings:permissions', decision: 'allow' }] },
      { mode: 'bypass', rules: [{ tool: 'settings_update', decision: 'deny' }, { tool: '*', decision: 'allow' }] });
    assert.equal(evaluateGate('settings_update', params, policy, 'settings:permissions').decision, 'deny');
    assert.equal(policy.rules.length, 2);
  });
  it('offers Smart judgment only for unmatched ordinary calls after explicit policy', () => {
    const smart: PermissionPolicy = { mode: 'smart', rules: [] };
    assert.deepEqual(resolvePermissionMode('accept-edits'), { configured: 'accept-edits', effective: 'normal', unavailable: 'accept-edits' });
    assert.deepEqual(resolvePermissionMode('smart'), { configured: 'smart', effective: 'smart' });
    assert.equal(evaluateGate('fixture', {}, smart).smartEligible, true);
    assert.equal(evaluateGate('fixture', {}, smart, 'settings:permissions').smartEligible, undefined);
    for (const decision of ['ask', 'deny', 'allow'] as const) {
      const result = evaluateGate('fixture', {}, { ...smart, rules: [{ tool: 'fixture', decision }] });
      assert.equal(result.decision, decision);
      assert.equal(result.smartEligible, undefined);
    }
    assert.equal(mergePolicies(smart, { mode: 'bypass' }).mode, 'smart');
    assert.equal(mergePolicies(smart, { mode: 'normal' }).mode, 'normal');
    assert.equal(mergePolicies({ mode: 'normal', rules: [] }, { mode: 'smart' }).mode, 'normal');
  });
});
