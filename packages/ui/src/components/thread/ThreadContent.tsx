import type { OutputMediaHolder } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { ThreadContentPart } from '@/lib/agent-runtime/thread-content';
import { ThreadMedia, ThreadOutput } from './ThreadMedia';

export function ThreadContent({ api, identity, holder, parts, messageId }: {
  api: Pick<ThreadsAPI, 'mediaRead'>; identity: ThreadIdentity; holder: OutputMediaHolder; parts: ThreadContentPart[]; messageId: string;
}) {
  return <>{parts.map((part, index) => {
    switch (part.kind) {
      case 'text': return <MarkdownRenderer key={index} messageId={`${messageId}:${index}`} content={part.text} />;
      case 'media': return <ThreadMedia key={index} api={api} identity={identity} holder={holder} media={part.media} partIndex={part.partIndex} />;
      case 'output': return <ThreadOutput key={index} api={api} identity={identity} holder={holder} output={part.output} messageId={messageId} />;
      case 'data': return <pre key={index} className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(part.data, null, 2)}</pre>;
      case 'status': return <p key={index} role="status">{part.text}</p>;
    }
  })}</>;
}
