export interface FilePurgeProgress {
  phase: 'files' | 'records';
  completed: number;
  total: number;
  removedNodes: number;
}
export interface FilePurgeScope {
  roots: readonly string[];
  preservedRoots?: readonly string[];
}

/** The private writer owns the captured rows; each step returns its queue to
 * interactive knowledge work. Aborting never interrupts an admitted native write. */
export interface FilePurgePort {
  beginFilePurge(scope: FilePurgeScope): Promise<number>;
  stepFilePurge(id: number): Promise<FilePurgeProgress & { done: boolean }>;
  releaseFilePurge(id: number): Promise<void>;
}

export async function purgeFiles(port: FilePurgePort, scope: FilePurgeScope, options?: {
  signal?: AbortSignal;
  onProgress?: (progress: FilePurgeProgress) => void;
}): Promise<{ removedNodes: number }> {
  options?.signal?.throwIfAborted();
  const id = await port.beginFilePurge(scope);
  try {
    for (;;) {
      options?.signal?.throwIfAborted();
      const step = await port.stepFilePurge(id);
      options?.onProgress?.(step);
      if (step.done) return { removedNodes: step.removedNodes };
    }
  } finally { await port.releaseFilePurge(id); }
}
