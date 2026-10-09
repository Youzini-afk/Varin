import type { Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** A permission decision is deliberately separate from free-form clarification answers. */
export function ThreadPermission({ operation, enabled, onDecide }: {
  operation: Operation;
  enabled: boolean;
  onDecide: (permissionId: string, decision: 'allow_once' | 'deny') => Promise<unknown>;
}) {
  const permission = record(record(operation.result)?.permission);
  const call = record(permission?.call);
  const scope = record(permission?.scope);
  const actor = record(permission?.actor);
  if (!permission || !call || !scope || typeof permission.id !== 'string' || !operation.waiting_on?.startsWith('permission:')) return null;
  const id = permission.id;
  const ready = enabled && operation.phase === 'waiting' && !operation.cancel_requested && permission.decision === null;
  return <section aria-label="Tool permission request" className="space-y-2 p-2">
    <div className="font-medium">Allow this tool action?</div>
    <div>{String(call.name)} · owner {String(scope.ownerReference)} · generation {String(scope.ownerGeneration)}</div>
    {actor && <div className="text-xs text-muted-foreground">Account {String(actor.account)} · {String(actor.authority)}</div>}
    <p className="text-xs text-muted-foreground">{String(scope.reason)}. Approval applies only to this action with these arguments.</p>
    <details><summary className="cursor-pointer">Review exact arguments</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(call.arguments, null, 2)}</pre></details>
    {permission.decision !== null ? <div className="text-xs">{permission.decision === 'allow_once' ? 'Allowed once' : 'Denied'}</div> : <div className="flex gap-2">
      <Button size="sm" disabled={!ready} onClick={() => void onDecide(id, 'allow_once')}>Allow once</Button>
      <Button size="sm" variant="outline" disabled={!ready} onClick={() => void onDecide(id, 'deny')}>Deny</Button>
    </div>}
  </section>;
}
