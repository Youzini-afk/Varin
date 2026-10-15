export interface HarnessSessionBlock {
  label: string;
  content: string;
  updatedBy: 'agent' | 'memory-agent' | 'user';
  cursorTurn?: number;
  updatedAt: number;
}

export interface HarnessSessionBlockResponse {
  blocks: HarnessSessionBlock[];
  branchLeafId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const parseHarnessSessionBlocks = (value: unknown): HarnessSessionBlock[] => {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return [];
  return value.blocks.flatMap((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.label !== 'string'
      || typeof candidate.content !== 'string'
      || (candidate.updatedBy !== 'agent' && candidate.updatedBy !== 'memory-agent' && candidate.updatedBy !== 'user')
      || typeof candidate.updatedAt !== 'number') return [];
    return [{
      label: candidate.label,
      content: candidate.content,
      updatedBy: candidate.updatedBy as HarnessSessionBlock['updatedBy'],
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.cursorTurn === 'number' ? { cursorTurn: candidate.cursorTurn } : {}),
    }];
  }).sort((left, right) => left.label.localeCompare(right.label));
};

export const parseHarnessSessionBlockResponse = (value: unknown): HarnessSessionBlockResponse => ({
  blocks: parseHarnessSessionBlocks(value),
  branchLeafId: isRecord(value) && typeof value.branchLeafId === 'string' ? value.branchLeafId : null,
});
