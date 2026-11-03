import type { SourceResourceOwner } from '@varin/protocol';
import type { ThreadSource } from './threads.js';

/** Metadata query over an admitted Source. A continuation belongs to this source/query/type. */
export interface ThreadSourceFileOptions {
  query?: string;
  type?: 'file' | 'directory' | 'all';
  /** Page size, default 50. This is not a total discovery limit. */
  limit?: number;
  cursor?: string;
}
export interface ThreadSourceFilesOptions extends ThreadSourceFileOptions { source?: ThreadSource }
export interface ThreadDraftFileOptions extends ThreadSourceFileOptions { source: { resourceOwner: SourceResourceOwner; path: string } }
export interface ThreadSourceFileEntry {
  /** Relative to this exact Source, never implicitly a path on the coordinating Host. */
  path: string;
  relativePath: string;
  name: string;
  type: 'file' | 'directory';
}
export interface ThreadSourceFilePage { entries: ThreadSourceFileEntry[]; nextCursor: string | null }
