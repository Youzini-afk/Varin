import {
  parseVarinExtensionServiceProvision, parseVarinToolJson,
  type JsonValue, type VarinExtensionServiceProvision, type VarinExtensionToolDeclaration,
  type NestedToolInput, type NestedToolReceipt,
} from "@varin/extension-contract";
import type { VarinBrokeredHostContext, VarinHostServiceInvocationContext } from "./index.js";

export type VarinToolServiceDeclaration = VarinExtensionServiceProvision & { tool: VarinExtensionToolDeclaration };
import { VARIN_RUNTIME_TOOLS_CAPABILITY } from '@varin/extension-contract';
export { VARIN_RUNTIME_TOOLS_CAPABILITY } from '@varin/extension-contract';
export type { NestedToolInput, NestedToolReceipt } from '@varin/extension-contract';
export interface VarinToolInvocationContext extends VarinHostServiceInvocationContext {
  readonly tools: { invoke(input: NestedToolInput): Promise<NestedToolReceipt> };
}

/** Register the exact descriptor imported from the package's manifest. The Host compiles its
 * schemas and admits calls; the SDK cannot grant permissions or author execution/resource facts. */
export function provideTool<TInput extends JsonValue = JsonValue>(
  context: VarinBrokeredHostContext,
  declaration: unknown,
  execute: (input: TInput, call: VarinToolInvocationContext) => JsonValue | Promise<JsonValue>,
): void {
  const descriptor = parseVarinExtensionServiceProvision(declaration);
  if (!descriptor.tool) throw new Error("Tool service declaration requires tool metadata");
  const inspection = parseVarinToolJson(descriptor);
  context.services.provide(descriptor, {
    inspect: args => {
      if (args.length !== 0) throw new Error("Tool inspect takes no arguments");
      return parseVarinToolJson(inspection);
    },
    execute: async (args, call) => {
      if (args.length !== 1) throw new Error("Tool execute takes exactly one input");
      call.signal.throwIfAborted();
      const input = parseVarinToolJson(args[0], "tool input") as TInput;
      // A late result is still a real callback completion. Its disposition belongs to the Host.
      const scoped: VarinToolInvocationContext = { ...call, tools: {
        invoke: async value => await call.capabilities.call(VARIN_RUNTIME_TOOLS_CAPABILITY, 'invoke',
          parseVarinToolJson(value)) as unknown as NestedToolReceipt,
      } };
      return parseVarinToolJson(await execute(input, scoped), "tool output");
    },
  });
}
