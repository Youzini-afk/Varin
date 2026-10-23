import React from 'react';
import type { Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The Host persists an explicit user rule; Catalog decides this original action. */
export function ThreadPermission({ operation, enabled, onDecide }: {
  operation: Operation;
  enabled: boolean;
  onDecide: (permissionId: string, decision: 'allow_once' | 'allow_always' | 'deny') => Promise<Operation>;
}) {
  const { t } = useI18n();
  const original = record(record(operation.result?.kind === 'control' ? operation.result.value : undefined)?.permission);
  const [receipt, setReceipt] = React.useState<{ id: string; permission: Record<string, unknown> }>();
  const [pending, setPending] = React.useState(false), [error, setError] = React.useState<string>();
  const active = React.useRef(original?.id); active.current = original?.id ?? receipt?.id;
  const busy = React.useRef(false), mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const permission = receipt && (!original || receipt.id === original.id) ? receipt.permission : original;
  const call = record(permission?.call), scope = record(permission?.scope), persistent = record(scope?.persistent);
  if (!permission || !call || !scope || typeof permission.id !== 'string') return null;
  const id = permission.id;
  const ready = enabled && operation.phase === 'waiting' && !operation.cancel_requested && permission.decision === null;
  const choose = async (decision: 'allow_once' | 'allow_always' | 'deny') => {
    if (!ready || busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const result = await onDecide(id, decision);
      const confirmed = record(record(result.result?.kind === 'control' ? result.result.value : undefined)?.permission);
      if (mounted.current && active.current === id && confirmed?.id === id) setReceipt({ id, permission: confirmed });
    } catch (failure) {
      if (mounted.current && active.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { busy.current = false; if (mounted.current && active.current === id) setPending(false); }
  };
  const tool = String(persistent?.tool ?? call.name), args = record(call.arguments);
  const subject = typeof args?.path === 'string' ? args.path : typeof args?.url === 'string' ? args.url : '';
  return <section aria-label={t('chat.permission.title')} className="thread-permission">
    <h3>{t('chat.permission.title')}</h3>
    <p className="thread-permission-subject">{tool}{subject && <> · {subject}</>}</p>
    {persistent && <p className="thread-permission-scope">{t('chat.permission.scope', { tool })}</p>}
    {persistent?.available === false && permission.decision === null && <p className="text-status-warning typography-meta">{t('chat.permission.unavailable')}</p>}
    <details className="thread-permission-details"><summary>{t('chat.permission.details')}</summary>
      <p>{String(scope.reason)}</p><pre>{JSON.stringify({ arguments: call.arguments, scope, actor: permission.actor }, null, 2)}</pre>
    </details>
    {error && <p role="alert" className="typography-meta text-destructive break-words">{error.includes('permission_persisted_') ? t('chat.permission.savedUnconfirmed') : error}</p>}
    {permission.decision !== null ? <div className="thread-permission-receipt" role="status">
      <Icon name={permission.decision === 'deny' ? 'close' : 'check'} className="size-3.5" />
      <span>{t(permission.decision === 'deny' ? 'chat.permission.denied' : permission.persisted_rule ? 'chat.permission.saved' : 'chat.permission.allowed')}</span>
      {Boolean(permission.persisted_rule) && <p>{t('chat.permission.revokeHint')}</p>}
    </div> : <div className="thread-permission-actions">
      <Button size="sm" disabled={!ready || pending} onClick={() => void choose('allow_once')}>{t('chat.permission.once')}</Button>
      <Button size="sm" variant="outline" disabled={!ready || pending || persistent?.available !== true} onClick={() => void choose('allow_always')}>{t('chat.permission.always')}</Button>
      <Button size="sm" variant="ghost" disabled={!ready || pending} onClick={() => void choose('deny')}>{t('chat.permission.deny')}</Button>
      {pending && <Icon name="loader-4" className="size-3.5 animate-spin motion-reduce:animate-none" />}
    </div>}
  </section>;
}
