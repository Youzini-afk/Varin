import type { ChildCodeResult, ChildPreparationProgress } from '@varin/protocol';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SwapText } from '@/components/motion/SwapText';

const states: Record<string, I18nKey> = {
  queued: 'harness.threads.state.queued', preparing: 'harness.threads.state.starting',
  starting: 'harness.threads.state.starting', running: 'harness.threads.state.running',
  ready: 'harness.threads.state.running', stopping: 'chat.children.stopping',
  preparation_failed: 'chat.children.preparationFailed',
  waiting: 'harness.threads.state.waiting', completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed', cancelled: 'harness.threads.state.cancelled',
  settling: 'chat.children.settling',
  waiting_user: 'external.status.waiting_user', interrupted: 'external.status.interrupted',
};
/** A member's state: starting → running → completed change in place. */
export function ChildState({ state }: { state: string }) {
  const { t } = useI18n();
  return <span className={cn('shrink-0 typography-micro', state === 'failed' || state === 'preparation_failed' ? 'text-destructive'
    : state === 'waiting' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
    {/* States are facts the reader acts on: they swap at once, without a hold. */}
    <SwapText text={states[state] ? t(states[state]) : state} hold={0} />
  </span>;
}
const preparationPhases: Record<ChildPreparationProgress['phase'], I18nKey> = {
  source: 'chat.children.preparation.source', source_wait: 'chat.children.preparation.sourceWait',
  inventory: 'chat.children.preparation.inventory', capture: 'chat.children.preparation.capture',
  verify: 'chat.children.preparation.verify', publish: 'chat.children.preparation.publish',
  context: 'chat.children.preparation.context', admission: 'chat.children.preparation.admission',
};
export function ChildPreparation({ progress }: { progress: ChildPreparationProgress }) {
  const { t } = useI18n();
  return <span className="mt-1 flex items-center gap-2 typography-micro text-muted-foreground">
    <span className="min-w-0 truncate">{t(preparationPhases[progress.phase])}</span>
    {progress.completed !== undefined && progress.total !== undefined && <span className="shrink-0 tabular-nums">{progress.completed.toLocaleString()} / {progress.total.toLocaleString()}</span>}
    {progress.completed !== undefined && progress.total === undefined && <span className="shrink-0 tabular-nums">{progress.completed.toLocaleString()}</span>}
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
