import React from 'react';
import { MaterialLinkContext } from '@/components/materials/MaterialLinkContext';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatPdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import type { ThreadMaterialAttachment } from '@/stores/useThreadDraftStore';

export function ThreadMaterialAttachments({ materials, locked, onRemove }: {
  materials: readonly ThreadMaterialAttachment[]; locked: boolean; onRemove: (snapshotId: string) => void;
}) {
  const { t } = useI18n();
  const open = React.useContext(MaterialLinkContext);
  if (!materials.length) return null;
  return <ul aria-label={t('chat.fileAttachment.pdfAttachments')} className="flex flex-wrap gap-2">
    {materials.map(material => <li key={material.snapshotId} className="flex items-center gap-1 rounded border px-2 py-1 text-sm">
      <Button type="button" variant="ghost" size="sm" disabled={!open}
        onClick={() => open?.(formatPdfMaterialCitationUrl({ ...material, page: 1 }), material.filename)}>
        {t('harness.pdf.openReader')} · {material.filename}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={locked}
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: material.filename })}
        onClick={() => onRemove(material.snapshotId)}>×</Button>
    </li>)}
  </ul>;
}
