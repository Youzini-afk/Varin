import type { ExternalAgentCapabilities } from '@varin/application-client';
import { attachmentMimeType } from '@varin/protocol';

/** Match the Host's native-image route; all other original bytes require a file route. */
export function externalAttachmentSupported(capabilities: ExternalAgentCapabilities | undefined, file: { filename: string; mimeType: string } | File): boolean {
  if (!capabilities) return false;
  if (capabilities.files) return true;
  const supplied = 'mimeType' in file ? file.mimeType : file.type;
  const mimeType = attachmentMimeType('filename' in file ? file.filename : file.name, supplied === 'application/octet-stream' ? '' : supplied);
  return capabilities.images && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType);
}
