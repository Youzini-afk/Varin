import type { ChildCodeResult } from '@varin/protocol';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const states: Record<string, I18nKey> = {
  queued: 'harness.threads.state.queued', preparing: 'harness.threads.state.starting',
  starting: 'harness.threads.state.starting', running: 'harness.threads.state.running',
  ready: 'harness.threads.state.running', stopping: 'chat.children.stopping',
  preparation_failed: 'chat.children.preparationFailed',
  waiting: 'harness.threads.state.waiting', completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed', cancelled: 'harness.threads.state.cancelled',
  settling: 'chat.children.settling',
};
export function ChildState({ state }: { state: string }) {
  const { t } = useI18n();
  return <span className={cn('shrink-0 typography-micro', state === 'failed' || state === 'preparation_failed' ? 'text-destructive'
    : state === 'waiting' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
    {states[state] ? t(states[state]) : state}
  </span>;
}
export function ChildFileResult({ result }: { result: ChildCodeResult }) {
  const { t } = useI18n();
  const label: Partial<Record<ChildCodeResult['kind'], I18nKey>> = {
    published: 'chat.children.filesPublished', no_changes: 'chat.children.noChanges',
    pending: 'chat.children.settling', settling: 'chat.children.settling', candidate: 'chat.children.settling', unavailable: 'chat.children.filesUnavailable',
  };
  const key = label[result.kind];
  return key ? <p className={cn('typography-meta', result.kind === 'unavailable' ? 'text-destructive' : 'text-muted-foreground')}
    title={result.kind === 'unavailable' ? result.code : undefined}>{t(key)}</p> : null;
}
