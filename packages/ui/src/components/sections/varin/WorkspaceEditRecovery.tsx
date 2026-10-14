import React from 'react';
import type { VarinWorkspaceEditBuffer, VarinWorkspaceEditReceipt } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/** Ordinary document refactors share the existing Recovery settings, without an Agent Run. */
export const WorkspaceEditRecovery: React.FC<{ workspaceIds: string[] }> = ({ workspaceIds }) => {
  const { documents } = useRuntimeAPIs();
  const { t } = useI18n();
  const [operations, setOperations] = React.useState<VarinWorkspaceEditReceipt[]>([]);
  const [drafts, setDrafts] = React.useState<Record<string, VarinWorkspaceEditBuffer[]>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const workspacesKey = [...new Set(workspaceIds)].sort().join('\0');
  React.useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all(
      workspacesKey
        .split('\0')
        .filter(Boolean)
        .map((workspaceId) => documents.listWorkspaceEdits({ workspaceId }))
    )
      .then((results) => {
        if (active)
          setOperations(
            results.flat().filter((result) => result.status === 'needs-attention' || result.status === 'pending')
          );
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [documents, workspacesKey]);
  if (!operations.length && !error) return null;
  return (
    <section className="space-y-3 border-t border-border/60 pt-5">
      <h3 className="typography-settings-group-title">{t('filesView.workspaceEdit.recoveryTitle')}</h3>
      {error ? (
        <p role="alert" className="typography-meta text-destructive">
          {error}
        </p>
      ) : null}
      {operations.map((operation) => (
        <div key={operation.operationId} className="space-y-2 rounded border border-border p-3">
          <p className="typography-meta">
            {operation.operationId} · {operation.status}
          </p>
          {(
            operation.resourceResults ??
            operation.affectedResources.map((resource) => ({ resource, status: operation.status }))
          ).map((result) => (
            <p key={result.resource.resourceId} className="typography-meta">
              {result.resource.resourceId} · {result.status}
            </p>
          ))}
          {operation.failures.map((failure, index) => (
            <p key={index} className="typography-meta text-muted-foreground">
              {failure.resource?.resourceId ? `${failure.resource.resourceId}: ` : ''}
              {failure.message}
            </p>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(operation.operationId);
              setError(null);
              try {
                const result = await documents.readWorkspaceEditRecovery({
                  workspaceId: operation.workspaceId,
                  operationId: operation.operationId,
                });
                setOperations((current) =>
                  current.map((entry) => (entry.operationId === operation.operationId ? result.receipt : entry))
                );
                setDrafts((current) => ({ ...current, [operation.operationId]: result.buffers }));
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(null);
              }
            }}
          >
            {t('filesView.workspaceEdit.recoveryDrafts')}
          </Button>
          {drafts[operation.operationId]?.map((buffer) => (
            <div key={buffer.documentInstanceId} className="space-y-1">
              <p className="typography-meta">{buffer.resource.resourceId}</p>
              <textarea
                readOnly
                aria-label={buffer.resource.resourceId}
                value={buffer.buffer}
                className="h-40 w-full resize-y rounded border border-border bg-background p-2 font-mono typography-code"
              />
            </div>
          ))}
          {drafts[operation.operationId]?.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('filesView.workspaceEdit.recoveryNoDrafts')}</p>
          ) : null}
        </div>
      ))}
    </section>
  );
};
