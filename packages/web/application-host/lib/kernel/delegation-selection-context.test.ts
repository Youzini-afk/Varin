import { expect, it } from 'vitest';
import type { DelegationModelRecipe } from './protocol.generated.js';
import { packDelegationSelection, selectionMaterial, selectionPreview, validateDelegationChoice } from './delegation-selection-context.js';

function recipe(): DelegationModelRecipe {
  const candidates = ['first', 'second'].map(id => ({ id, providerId: `secret-channel-${id}`, modelId: 'private-model', configurationFingerprint: 'trusted-fingerprint',
    name: id, channelName: id, description: 'Description 😀 '.repeat(100), input: ['text'], thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'off' }));
  return { catalog: { candidates, selector: null }, choices: candidates.map(candidate => ({ model: candidate.id, thinking: 'off' })),
    input: { task: 'Do the actual task 😀 '.repeat(80), thinking: 'off', tools: ['requested-tool'] },
    execution: { tools: ['resolved-read-tool'], workMode: 'read_only', inputTypes: ['text'] }, messages: [] } as DelegationModelRecipe;
}
const signal = () => new AbortController().signal;
const size = (material: ReturnType<typeof selectionMaterial>) => JSON.stringify(material).length;

it('packs actual model facts without trusted bindings or mutating the frozen recipe', async () => {
  const input = recipe(), original = structuredClone(input);
  const result = await packDelegationSelection(input, async value => size(value) <= 1600, signal());
  expect(size(result)).toBeLessThanOrEqual(1600);
  expect(result.candidates.map(value => value.id)).toEqual(['first', 'second']);
  expect(result.candidates.every(value => value.thinkingLevels.length === 2)).toBe(true);
  expect(result.candidates.every(value => value.description?.includes('omitted'))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-model|secret-channel|trusted-fingerprint/);
  expect(result.execution).toEqual({ tools: ['resolved-read-tool'], workMode: 'read_only', inputTypes: ['text'] });
  expect(JSON.stringify(result)).not.toContain('requested-tool');
  expect(result.fixed).toEqual({ model: null, thinking: 'off' });
  expect(input).toEqual(original);
});

it('never deletes candidates to fit a selector and fails before transport if fixed facts cannot fit', async () => {
  const input = recipe();
  await expect(packDelegationSelection(input, async material => {
    expect(material.candidates).toHaveLength(2);
    expect(material.candidates.every(candidate => candidate.thinkingLevels.includes('high'))).toBe(true);
    return false;
  }, signal())).rejects.toMatchObject({ code: 'delegation-selection-capacity-insufficient' });
});

it('prioritizes the latest user text and recent assistant, preserving chronological presentation', async () => {
  const input = recipe(); input.input.task = 'Actual task'; input.catalog.candidates.forEach(candidate => { delete candidate.description; });
  input.messages = [{ id: 'old', role: 'user', text: 'old '.repeat(200), recentAssistant: false },
    { id: 'answer', role: 'assistant', text: 'recent answer', recentAssistant: true },
    { id: 'latest', role: 'user', text: 'important latest user 😀', recentAssistant: false }];
  const minimum = selectionMaterial(input);
  const budget = size({ ...minimum, conversation: input.messages.slice(1) });
  const result = await packDelegationSelection(input, async value => size(value) <= budget, signal());
  expect(result.conversation).toEqual(input.messages.slice(1));
});

it('truncates by complete Unicode code points with an explicit middle omission', () => {
  const result = selectionPreview('😀'.repeat(60), 30);
  expect(Array.from(result)).toHaveLength(30);
  expect(result).toContain('omitted');
  expect(result.startsWith('😀')).toBe(true); expect(result.endsWith('😀')).toBe(true);
  expect(/[\uD800-\uDFFF]/u.test(result)).toBe(false);
});

it('cancellation during counting ends preparation immediately', async () => {
  const controller = new AbortController();
  await expect(packDelegationSelection(recipe(), async () => { controller.abort(); return true; }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('validates exactly the frozen valid combinations, without normalizing or repairing output', () => {
  const choices = [{ model: 'first', thinking: 'off' }];
  expect(validateDelegationChoice({ model: 'first', thinking: 'off' }, choices)).toBe(choices[0]);
  expect(() => validateDelegationChoice({ model: 'first', thinking: 'off', explanation: 'extra' }, choices)).toThrow(expect.objectContaining({ code: 'delegation-selection-invalid-response' }));
  expect(() => validateDelegationChoice({ model: 'first', thinking: 'high' }, choices)).toThrow(expect.objectContaining({ code: 'delegation-selection-unknown-choice' }));
});
