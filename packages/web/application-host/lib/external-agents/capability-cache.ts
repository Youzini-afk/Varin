import type { ExternalAgentCapabilities, ExternalAgentConfiguration } from '@varin/application-client';

/** Only launch identity affects reuse. Presentation and draft defaults do not. */
export const capabilityConfiguration = (configuration: ExternalAgentConfiguration) => ({
  harness: configuration.harness, command: configuration.command, args: configuration.args,
});

/** Protocol metadata only: never authentication methods, credentials or transient errors. */
export function cacheableCapabilities(capabilities: ExternalAgentCapabilities): ExternalAgentCapabilities {
  const { resume, images, files, steering, models, current, modes, commands, configOptions, protocol, resumeMethods } = capabilities;
  return structuredClone({ resume, images, steering, models,
    ...(files ? { files } : {}), ...(current ? { current } : {}), ...(modes ? { modes } : {}),
    ...(commands ? { commands } : {}), ...(configOptions ? { configOptions } : {}),
    ...(protocol ? { protocol } : {}), ...(resumeMethods ? { resumeMethods } : {}),
  });
}
