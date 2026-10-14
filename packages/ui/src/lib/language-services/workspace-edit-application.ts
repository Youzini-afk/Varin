import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentRegistry } from '@/lib/documents/registry';
import type { VarinLanguageWorkspaceEdit } from '@varin/application-client';
import { requestWorkspaceEditReview, type WorkspaceEditReviewKind } from './workspace-edit-review';
import { toDocumentWorkspaceEditInput } from './workspace-edit';

export type LanguageWorkspaceEditApplicationResult =
  | { status: 'applied'; groupId: string; changedFiles: number }
  | { status: 'cancelled' }
  | { status: 'rejected'; message: string };

type WorkspaceEditRegistry = Pick<
  DocumentRegistry,
  'prepareWorkspaceEdit' | 'applyWorkspaceEdit' | 'discardWorkspaceEdit'
>;

export const applyLanguageWorkspaceEdit = async (options: {
  edit: VarinLanguageWorkspaceEdit;
  kind: WorkspaceEditReviewKind;
  isCancelled?: () => boolean;
  label?: string;
  origin: string;
  registry?: WorkspaceEditRegistry;
  review?: typeof requestWorkspaceEditReview;
  workspaceId: string;
}): Promise<LanguageWorkspaceEditApplicationResult> => {
  const registry = options.registry ?? getDocumentRegistry();
  const prepared = await registry.prepareWorkspaceEdit(toDocumentWorkspaceEditInput(
    options.workspaceId,
    options.origin,
    options.edit,
  ));
  if (prepared.status === 'rejected') {
    return { status: 'rejected', message: prepared.failures[0]?.message ?? 'Workspace edit was rejected' };
  }
  if (options.isCancelled?.()) {
    registry.discardWorkspaceEdit(prepared.groupId);
    return { status: 'cancelled' };
  }
  if (prepared.files.length === 0) {
    registry.discardWorkspaceEdit(prepared.groupId);
    return { status: 'applied', groupId: prepared.groupId, changedFiles: 0 };
  }
  if (prepared.files.length > 1 || prepared.requiresConfirmation) {
    const accepted = await (options.review ?? requestWorkspaceEditReview)(prepared, {
      kind: options.kind,
      ...(options.label ? { label: options.label } : {}),
    });
    if (!accepted) {
      registry.discardWorkspaceEdit(prepared.groupId);
      return { status: 'cancelled' };
    }
    if (options.isCancelled?.()) {
      registry.discardWorkspaceEdit(prepared.groupId);
      return { status: 'cancelled' };
    }
  }
  const applied = await registry.applyWorkspaceEdit(prepared.groupId);
  return applied.status === 'applied'
    ? { status: 'applied', groupId: applied.groupId, changedFiles: prepared.files.length }
    : { status: 'rejected', message: applied.failures[0]?.message ?? 'Workspace edit became stale' };
};
