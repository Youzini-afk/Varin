import React from 'react';
import { MaterialLinkContext } from './MaterialLinkContext';
import { PDF_MATERIAL_OPEN_EVENT, pdfMaterialUrlFromMarkdownHref } from '@/lib/materials/pdfMaterialCitation';

export const usePdfMaterialLinkInteractions = ({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) => {
  const openMaterial = React.useContext(MaterialLinkContext);
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[data-varin-material-link="true"]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      event.stopPropagation();
      const href = pdfMaterialUrlFromMarkdownHref(anchor.getAttribute('href') ?? '');
      if (!href) return;
      if (openMaterial) { openMaterial(href, anchor.textContent?.trim() ?? ''); return; }
      window.dispatchEvent(new CustomEvent(PDF_MATERIAL_OPEN_EVENT, {
        detail: { href, title: anchor.textContent?.trim() ?? '' },
      }));
    };
    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [containerRef, openMaterial]);
};
