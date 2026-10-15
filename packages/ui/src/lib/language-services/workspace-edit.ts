import type { VarinLanguageWorkspaceEdit } from '@varin/application-client';
import type { DocumentWorkspaceEditInput } from '@/lib/documents/types';

export const toDocumentWorkspaceEditInput = (
  workspaceId: string,
  origin: string,
  edit: VarinLanguageWorkspaceEdit,
): DocumentWorkspaceEditInput => {
  return {
    workspaceId,
    origin,
    changes: edit.documentChanges.map(change => {
      if (change.kind === 'rename') return { ...change };
      const { resource, ...rest } = change;
      return { ...rest, identity: resource };
    }),
    ...(edit.changeAnnotations ? { changeAnnotations: edit.changeAnnotations } : {}),
  };
};
