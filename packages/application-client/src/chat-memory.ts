/** A frozen selection in native message text, using UTF-16 offsets. */
export interface ChatMemoryPassage {
  entryId: string;
  start: number;
  text: string;
  revision?: string;
}

export interface ChatMemoryOwner {
  scope: 'workspace' | 'bot' | 'session' | 'user';
  ownerId: string | null;
}

export type ChatMemoryNature = 'experience' | 'decision' | 'preference' | 'judgment' | 'instruction';

export interface ChatMemoryDraft {
  content: string;
  trigger: string;
  nature: ChatMemoryNature;
  sources: ChatMemoryPassage[];
}

export interface ChatMemoryExtraction {
  owner: ChatMemoryOwner;
  drafts: ChatMemoryDraft[];
}

export interface ChatMemoryReceipt {
  created: boolean;
  owner: ChatMemoryOwner;
  item: {
    id: number;
    content: string;
    trigger: string;
    status: 'suggested' | 'accepted' | 'dismissed';
    invalidAt?: number;
  };
}
