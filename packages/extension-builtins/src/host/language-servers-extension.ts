import { resolveNodeRuntime } from "@varin/protocol/node/runtime";
import {
  createWorkspaceLanguageClient,
  defineHostExtension,
  type VarinLanguageProviderDescriptor,
} from "@varin/extension-sdk";

const bundledProvider = (
  providerId: string,
  languageIds: readonly string[],
  runtimePath: string,
  args: readonly string[] = [],
  initializationOptions?: VarinLanguageProviderDescriptor["initializationOptions"],
): VarinLanguageProviderDescriptor => ({
  command: resolveNodeRuntime().executable,
  languageIds,
  providerId,
  source: "extension",
  args: [runtimePath, ...args],
  ...(initializationOptions ? { initializationOptions } : {}),
});

export default defineHostExtension(async (context) => {
  const client = createWorkspaceLanguageClient(context.capabilities);
  const descriptors: readonly VarinLanguageProviderDescriptor[] = [
    bundledProvider("varin.python-language", ["python"], context.assets.path("runtime/pyright-langserver.cjs"), ["--stdio"]),
    bundledProvider("varin.html-language", ["html"], context.assets.path("runtime/html-language-server.cjs"), ["--stdio"]),
    bundledProvider("varin.css-language", ["css", "scss", "less"], context.assets.path("runtime/css-language-server.cjs"), ["--stdio"]),
    bundledProvider("varin.json-language", ["json", "jsonc"], context.assets.path("runtime/json-language-server.cjs"), ["--stdio"]),
    bundledProvider(
      "varin.yaml-language",
      ["yaml"],
      context.assets.path("runtime/yaml-language-server.cjs"),
      ["--stdio"],
      { l10nPath: context.assets.path("l10n") },
    ),
    bundledProvider("varin.bash-language", ["shellscript"], context.assets.path("runtime/bash-language-server.cjs"), ["start"]),
  ];
  const registered: string[] = [];
  context.effect(async () => {
    for (const providerId of registered.reverse()) await client.unregisterProvider(providerId);
  });
  for (const descriptor of descriptors) {
    await client.registerProvider(descriptor);
    registered.push(descriptor.providerId);
  }
});
