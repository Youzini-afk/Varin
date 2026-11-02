import type { ExternalInput } from '@varin/application-client';

/** Dedicated protocols expose only controls that their native owner implements. */
export function dedicatedOptions(
  input: ExternalInput,
  name: string,
): { model?: string; thinking?: string } {
  if (input.mode !== undefined) throw new Error(`${name} does not expose a mode control`);
  const options: { model?: string; thinking?: string } = {};
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (key !== 'model' && key !== 'thinking')
      throw new Error(`${name} does not expose configuration option ${key}`);
    if (!value) throw new Error(`${name} configuration option ${key} must not be empty`);
    options[key] = value;
  }
  for (const key of ['model', 'thinking'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value || (options[key] !== undefined && options[key] !== value))
      throw new Error(`${name} has a conflicting or empty ${key} selection`);
    options[key] = value;
  }
  return options;
}
