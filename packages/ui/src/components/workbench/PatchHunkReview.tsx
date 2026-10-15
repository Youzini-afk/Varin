import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeEndpointGeneration, type ThreadIdentity } from '@varin/application-client';
import { applyPatchDecisionsToDocument } from '@/lib/agent-editor/document-write';
import { parseUnifiedHunks } from '@/lib/agent-editor/patch';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import type { HunkDecision } from '@/lib/agent-editor/types';

type PatchHunkReviewProps = {
  resolveTarget(): Promise<{ workspaceId: string; resourceId: string; root: string }>;
  thread: ThreadIdentity;
  patch: string;
  entryId?: string;
  toolCallId?: string;
};

export const PatchHunkReview: React.FC<PatchHunkReviewProps> = ({
  resolveTarget,
  thread,
  patch,
  entryId,
  toolCallId,
}) => {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const hunks = React.useMemo(() => parseUnifiedHunks(patch), [patch]);
  const [decisions, setDecisions] = React.useState<HunkDecision[]>(() => hunks.map(() => 'accept'));

  React.useEffect(() => {
    setDecisions(hunks.map(() => 'accept'));
  }, [hunks]);

  const apply = async (direction: 'apply' | 'revert', next: HunkDecision[]) => {
    if (busy) return;
    const host = getRuntimeEndpointGeneration();
    setBusy(true);
    try {
      const target = await resolveTarget();
      if (host !== getRuntimeEndpointGeneration()) return;
      const identity = { workspaceId: target.workspaceId, resourceId: target.resourceId };
      const result = await applyPatchDecisionsToDocument({
        identity,
        patch,
        decisions: next,
        direction,
      });
      if (result.status === 'applied') {
        toast.success(t('workbench.patch.written'));
        return;
      }
      if (result.status === 'conflict') {
        toast.error(t('workbench.patch.conflict'));
        revealResourceInEditor({
          workspaceId: identity.workspaceId,
          resourceId: identity.resourceId,
          workspaceRoot: target.root,
          thread,
          ...(entryId ? { entryId } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        });
        return;
      }
      toast.error(t('workbench.patch.failed', { message: result.status === 'failure' ? result.errorMessage : result.status }));
    } catch (error) {
      if (host === getRuntimeEndpointGeneration() && !(error instanceof DOMException && error.name === 'AbortError'))
        toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  if (hunks.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {hunks.map((hunk, index) => (
        <div key={hunk.header} className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 px-2 py-1">
          <span className="min-w-0 flex-1 truncate font-mono typography-micro">{hunk.header}</span>
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={decisions[index] === 'accept'}
            onClick={() => setDecisions((current) => current.map((item, at) => (at === index ? 'accept' : item)))}
          >
            {t('workbench.patch.acceptHunk')}
          </Button>
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={decisions[index] === 'reject'}
            onClick={() => setDecisions((current) => current.map((item, at) => (at === index ? 'reject' : item)))}
          >
            {t('workbench.patch.rejectHunk')}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void apply('apply', decisions)}>
          {t('workbench.patch.applyAccepted')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void apply('revert', decisions.map((item) => (item === 'reject' ? 'accept' : 'reject')))}
        >
          {t('workbench.patch.revertRejected')}
        </Button>
      </div>
    </div>
  );
};
