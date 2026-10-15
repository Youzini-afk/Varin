import { useDirectoryStore } from '@/stores/useDirectoryStore';

/** Navigation workspace is independent of a Thread's admitted execution source. */
export const useEffectiveDirectory = (): string | undefined => (
  useDirectoryStore(state => state.currentDirectory)?.trim() || undefined
);
