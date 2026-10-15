import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import type { HistoryItem } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { getReviewTransferDirection, reviewableAssistantText, transferReviewMessage } from '@/lib/reviewFlow';
import { useReviewFlowStore } from '@/stores/useReviewFlowStore';

export function ReviewTransferActions({ identity, item }: { identity: ThreadIdentity; item: HistoryItem }) {
  useReviewFlowStore(state => state.linksByOriginal);
  const direction = getReviewTransferDirection(identity);
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string>();
  if (!direction || !reviewableAssistantText(item)) return null;
  return <div className="text-xs">
    <Button type="button" size="sm" variant="ghost" disabled={pending || sent} onClick={() => {
      setPending(true); setError(undefined);
      void transferReviewMessage(identity, item).then(() => setSent(true), error => setError(error instanceof Error ? error.message : 'Transfer unavailable')).finally(() => setPending(false));
    }}>{sent ? 'Review message sent' : pending ? 'Sending review message' : error ? 'Retry original delivery' : direction === 'review-to-original' ? 'Send feedback to implementation' : 'Send response to reviewer'}</Button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
