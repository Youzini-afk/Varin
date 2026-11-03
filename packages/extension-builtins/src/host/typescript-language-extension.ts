import { resolveNodeRuntime } from "@varin/protocol/node/runtime";
import { defineLanguageProvider } from "@varin/extension-sdk";

export default defineLanguageProvider((context) => ({
  providerId: "varin.typescript-language",
  command: resolveNodeRuntime().executable,
  args: [context.assets.path("runtime/typescript-language-server.mjs"), "--stdio"],
  languageIds: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
  initializationOptions: {
    tsserver: {
      fallbackPath: context.assets.path("runtime/typescript/lib/tsserver.js"),
    },
  },
}));
