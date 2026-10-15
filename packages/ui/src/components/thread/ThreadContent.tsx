import type { OutputMediaHolder } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { ThreadContentPart } from '@/lib/agent-runtime/thread-content';
import { ThreadMedia, ThreadOutput } from './ThreadMedia';
import { useI18n } from '@/lib/i18n';

export function ThreadContent({ api, identity, holder, parts, messageId }: {
  api: Pick<ThreadsAPI, 'mediaRead'>; identity: ThreadIdentity; holder: OutputMediaHolder; parts: ThreadContentPart[]; messageId: string;
}) {
  const { t } = useI18n();
  return <>{parts.map((part, index) => {
    switch (part.kind) {
      case 'text': return <MarkdownRenderer key={index} messageId={`${messageId}:${index}`} content={part.text} />;
      case 'media': return <ThreadMedia key={index} api={api} identity={identity} holder={holder} media={part.media} partIndex={part.partIndex} />;
      case 'output': return <ThreadOutput key={index} api={api} identity={identity} holder={holder} output={part.output} messageId={messageId} />;
      case 'data': return <details key={index} className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('chat.toolPart.showRawJson')}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all pt-2">{JSON.stringify(part.data, null, 2)}</pre></details>;
      case 'status': return <p key={index} role="status">{part.text}</p>;
    }
  })}</>;
}
