import type {
  VarinCommandExecutionContextV1, VarinMessageRendererPropsV1, VarinSessionDecorationPropsV1,
  VarinSettingsPageMountPropsV1, VarinToolRendererPropsV1,
} from '@varin/extension-contract';
import type { VarinSurfaceMount, VarinSurfaceMountImplementation } from './index.js';

export type {
  VarinCommandContributionDataV1, VarinCommandExecutionContextV1, VarinSettingsPageContributionDataV1,
  VarinSettingsPageMountPropsV1, VarinMessageRendererPropsV1, VarinToolRendererPropsV1, VarinSessionDecorationPropsV1,
} from '@varin/extension-contract';
export { VARIN_CONVERSATION_SLOTS } from '@varin/extension-contract';

export interface VarinCommandImplementationV1 {
  execute(context: VarinCommandExecutionContextV1): void | Promise<void>;
  isAvailable?(context: VarinCommandExecutionContextV1): boolean;
}
export const defineCommand = (
  implementation: VarinCommandImplementationV1 | VarinCommandImplementationV1['execute'],
): VarinCommandImplementationV1 => typeof implementation === 'function' ? { execute: implementation } : implementation;

export const defineSettingsPageMount = (
  implementation: VarinSurfaceMount<VarinSettingsPageMountPropsV1> | VarinSurfaceMountImplementation<VarinSettingsPageMountPropsV1>,
): VarinSurfaceMountImplementation<VarinSettingsPageMountPropsV1> => typeof implementation === 'function' ? { mount: implementation } : implementation;

/** Matching only chooses presentation. It cannot change the original message, operation or receipt. */
export interface VarinMatchRenderer<TProps extends object> extends VarinSurfaceMountImplementation<TProps> {
  matches(input: Readonly<TProps>): boolean;
}
export const defineMessageRenderer = (renderer: VarinMatchRenderer<VarinMessageRendererPropsV1>): VarinMatchRenderer<VarinMessageRendererPropsV1> => renderer;
export const defineToolRenderer = (renderer: VarinMatchRenderer<VarinToolRendererPropsV1>): VarinMatchRenderer<VarinToolRendererPropsV1> => renderer;
export const defineSessionDecoration = (renderer: VarinMatchRenderer<VarinSessionDecorationPropsV1>): VarinMatchRenderer<VarinSessionDecorationPropsV1> => renderer;
