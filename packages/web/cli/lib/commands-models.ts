import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestThreadApi } from './cli-runtime.js';
import { isJsonMode, printJson } from '../cli-output.js';
import type { CliOptions } from './cli-types.js';
import type { ThreadModelInfo } from '@varin/application-client';

const formatModelsOutput = (models: ThreadModelInfo[]): string => {
  const lines = models.map(model => `- ${model.providerId}/${model.modelId}${model.name ? ` (${model.name})` : ''}${model.thinkingLevels?.length ? `; thinking: ${model.thinkingLevels.join(', ')}` : ''}`);
  return `Available models:\n${lines.length ? lines.join('\n') : '- none'}\n`;
};

async function modelsCommand(options: CliOptions = {}, action = 'show'): Promise<void> {
  if (action === 'help') {
    process.stdout.write(`Varin Models Commands\n\nUSAGE:\n  varin models [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       Varin server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'show') {
    throw new TunnelCliError(`Unknown models command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const availableModels = await requestThreadApi<ThreadModelInfo[]>(port, 'models', {}, options);
  const result = { availableModels };

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  process.stdout.write(formatModelsOutput(availableModels));
}

export { modelsCommand, formatModelsOutput };
