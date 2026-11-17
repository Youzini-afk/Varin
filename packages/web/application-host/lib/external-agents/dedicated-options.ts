import type { ExternalInput } from '@varin/application-client';

const fields = ['model', 'thinking', 'mode'] as const;
type Options = Pick<ExternalInput, typeof fields[number]>;

export function dedicatedOptions(
  input: ExternalInput,
  name: string,
  modes?: ReadonlyArray<{ id: string }>,
): Options {
  const options: Options = {};
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (key !== 'model' && key !== 'thinking' && key !== 'mode')
      throw new Error(`${name} does not expose configuration option ${key}`);
    if (!value) throw new Error(`${name} configuration option ${key} must not be empty`);
    options[key] = value;
  }
  for (const key of fields) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value || (options[key] !== undefined && options[key] !== value))
      throw new Error(`${name} has a conflicting or empty ${key} selection`);
    options[key] = value;
  }
  if (options.mode !== undefined && !modes?.some(mode => mode.id === options.mode))
    throw new Error(`${name} does not offer mode ${options.mode} for this session`);
  return options;
}
