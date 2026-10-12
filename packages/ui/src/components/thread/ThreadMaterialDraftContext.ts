import { createContext } from 'react';
import type { PdfMaterialDraft } from '@/components/materials/PdfMaterialReader';

/** The enclosing Thread's guarded composer callback, shared by all of its PDF entry points. */
export const ThreadMaterialDraftContext = createContext<((region: PdfMaterialDraft) => void) | null>(null);
