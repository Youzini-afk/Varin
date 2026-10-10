import type { ContextCheckpoint } from '@varin/application-client';
import type { AgentResourceInstruction, AgentResourceReference } from '@varin/protocol';
import { Button } from '@/components/ui/button';

/** Metadata only. Captured bodies stay with the frozen runtime checkpoint. */
export function ThreadResources({ checkpoint, pending, onRefresh }: {
  checkpoint: ContextCheckpoint;
  pending: boolean;
  onRefresh(): void;
}) {
  const resources = checkpoint.resources;
  if (!resources) return null;
  const { snapshot, source } = resources;
  const instructions = [
    ...(snapshot.system ? [{ label: 'System', instruction: snapshot.system }] : []),
    ...(snapshot.appendSystem ? [{ label: 'Append system', instruction: snapshot.appendSystem }] : []),
    ...snapshot.instructions.map(instruction => ({ label: 'Instruction', instruction })),
  ];
  return <details aria-label="Instructions and skills" className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Instructions and skills · checkpoint {checkpoint.revision}</summary>
    <div className="space-y-3 py-3 break-words">
      <div>
        <p>Frozen resource version: {snapshot.id}</p>
        <p>Context checkpoint: {checkpoint.id}</p>
        <p>Source: {source ? `${source.mode} · ${source.workspace_id}${source.branch_id ? ` · ${source.branch_id}` : ''}${source.revision !== null ? ` · revision ${source.revision}` : ''}` : 'No workspace source'}</p>
        <p>Directory: {snapshot.scope.cwd}</p>
        {snapshot.scope.sourceIdentity && <p>Source identity: {snapshot.scope.sourceIdentity}</p>}
      </div>
      <div>
        <p className="font-medium text-foreground">Instructions</p>
        {instructions.length ? <ul className="space-y-2">
          {instructions.map(({ label, instruction }, index) => <li key={`${label}:${instruction.reference.canonicalId}:${index}`}>
            <span>{label} · </span><InstructionMetadata instruction={instruction} />
          </li>)}
        </ul> : <p>No root instructions captured.</p>}
        {snapshot.instructionScopes.map(scope => <div key={scope.directory} className="mt-2">
          <p>Instruction scope: {scope.directory}</p>
          {scope.instructions.length ? <ul className="space-y-2">
            {scope.instructions.map((instruction, index) => <li key={`${instruction.reference.canonicalId}:${index}`}><InstructionMetadata instruction={instruction} /></li>)}
          </ul> : <p>No instructions captured for this scope.</p>}
        </div>)}
      </div>
      <div>
        <p className="font-medium text-foreground">Skills · {snapshot.skills.length}</p>
        {snapshot.skills.length ? <ul className="space-y-2">
          {snapshot.skills.map(skill => <li key={skill.id}>
            <p>{skill.name} · {skill.origin}{skill.disableModelInvocation ? ' · Hidden from automatic model discovery' : ''}</p>
            <ReferenceMetadata reference={skill.reference} />
          </li>)}
        </ul> : <p>No skills captured.</p>}
      </div>
      {snapshot.diagnostics.length > 0 && <div aria-label="Resource diagnostics">
        <p className="font-medium text-foreground">Diagnostics</p>
        <ul className="space-y-2">{snapshot.diagnostics.map((diagnostic, index) => <li key={index}>
          <p>{diagnostic.kind}{diagnostic.status ? ` · ${diagnostic.status}` : ''}: {diagnostic.message}</p>
          <p>{diagnostic.location.path} · {diagnostic.location.domainId} · {diagnostic.location.viewId}</p>
        </li>)}</ul>
      </div>}
      <p>Refresh applies to the next model request. Requests already in flight keep their frozen version.</p>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRefresh}>Refresh instructions and skills</Button>
    </div>
  </details>;
}

function InstructionMetadata({ instruction }: { instruction: AgentResourceInstruction }) {
  return <><span>{instruction.origin}{instruction.appliesTo ? ` · applies to ${instruction.appliesTo}` : ''}</span><ReferenceMetadata reference={instruction.reference} /></>;
}

function ReferenceMetadata({ reference }: { reference: AgentResourceReference }) {
  return <><p>{reference.path}</p><p>{reference.domainId} · {reference.viewId} · version {reference.version}</p></>;
}
