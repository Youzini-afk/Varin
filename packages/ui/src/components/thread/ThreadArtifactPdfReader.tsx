import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, ThreadRequestError } from '@varin/application-client';
import { PdfMaterialReader, type PdfMaterialDraft, type PdfMaterialReaderPort } from '@/components/materials/PdfMaterialReader';
import type { ResearchFactsOwner } from '@/workbenches/research/researchFacts';
import { ThreadMaterialDraftContext } from './ThreadMaterialDraftContext';

/** The selected original research Run ingests the artifact; retained pages belong to its Thread. */
export function ThreadArtifactPdfReader({ owner, artifact, title, onOpenChange }: {
  owner: ResearchFactsOwner;
  artifact: { attemptId: string; artifactId: string };
  title: string;
  onOpenChange(open: boolean): void;
}) {
  const addRegion = React.useContext(ThreadMaterialDraftContext);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const authority = React.useMemo(() => ({ owner, host, active: true }), [owner, host]);
  const current = React.useRef(authority); current.current = authority;
  const close = React.useRef(onOpenChange); close.current = onOpenChange;
  const [retired, setRetired] = React.useState(false);
  React.useEffect(() => {
    authority.active = host === getRuntimeEndpointGeneration();
    const stop = subscribeRuntimeEndpointWillChange(() => {
      authority.active = false;
      setRetired(true);
      close.current(false);
    });
    return () => { authority.active = false; stop(); };
  }, [authority, host]);
  const reader = React.useMemo<PdfMaterialReaderPort>(() => {
    const selection = { ...owner.selection };
    const identity = { runtime: selection.runtime, threadId: selection.threadId, branchId: selection.branchId };
    const isCurrent = () => current.current === authority && authority.active && host === getRuntimeEndpointGeneration();
    return {
      key: JSON.stringify([host, selection.threadId, selection.branchId, selection.sourceRunId, artifact.attemptId, artifact.artifactId]),
      isCurrent,
      ...(addRegion ? { addRegion(region: PdfMaterialDraft) {
        if (!isCurrent()) throw new Error('Research source changed');
        addRegion(region);
      } } : {}),
      async read(request, signal) {
        // Source-kind framing only. The original material owner decodes document selectors and policy.
        if (request.path !== undefined || Boolean(request.snapshotId) === Boolean(request.artifact)) {
          throw new Error('Choose an original research artifact or its retained PDF snapshot');
        }
        try {
          if (request.artifact) return await owner.materials.readArtifact(selection, { ...request, artifact: request.artifact }, signal);
          return await owner.materials.read(identity, { ...request, snapshotId: request.snapshotId! }, signal);
        } catch (error) {
          if (error instanceof ThreadRequestError) throw new Error(error.status === 403
            ? `Access to this PDF artifact is denied (${error.code}).`
            : error.status === 404 ? `This PDF artifact is no longer available (${error.code}).`
              : `Could not read this PDF artifact (${error.code}).`);
          throw error;
        }
      },
    };
  }, [addRegion, artifact.attemptId, artifact.artifactId, authority, host, owner]);
  return <PdfMaterialReader key={reader.key} reader={reader} title={title} artifact={artifact}
    open={!retired} onOpenChange={onOpenChange} />;
}
