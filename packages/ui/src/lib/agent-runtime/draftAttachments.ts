import type { ThreadIdentity } from '@varin/application-client';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { useThreadStore, threadIdentityKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
export async function addThreadDraftImage(identity: ThreadIdentity, file: File): Promise<void> {
  const host = useThreadStore.getState().hostKey;
  const attachment = await fileToImageAttachment(file);
  if (host !== useThreadStore.getState().hostKey) throw new Error('Application Host changed while preparing attachment');
  useThreadDraftStore.getState().patch(threadIdentityKey(host, identity), draft => ({ images: [...draft.images, attachment] }));
}
