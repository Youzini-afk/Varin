import type { VarinExtensionServiceProvision } from '@varin/extension-contract';
import { imageToolContract, type ImageToolPurpose } from '@varin/protocol';
export const VARIN_BUILTIN_IMAGES_EXTENSION_ID = 'varin.builtin.images';
export const IMAGES_CAPABILITY = 'images';
export const IMAGE_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = (['generation', 'editing'] as const).map(purpose => ({
  id: `varin.images.${purpose}`, version: 1,
  tool: { ...imageToolContract(purpose), operation: 'effect', completion: 'result',
    outputSchema: { type: 'object' } },
}));
/** Narrow the shared declaration to parameters provided by the chosen adapter. */
export function imageToolDeclaration(declaration: VarinExtensionServiceProvision, model: { parameters: readonly string[]; supportsMask: boolean }): VarinExtensionServiceProvision {
  const next = structuredClone(declaration);
  next.tool!.inputSchema = imageToolContract(declaration.id.split('.').at(-1) as ImageToolPurpose, model).inputSchema;
  return next;
}
