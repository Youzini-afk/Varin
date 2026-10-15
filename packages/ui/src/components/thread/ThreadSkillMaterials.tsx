import { historySkillMaterials } from '@/lib/agent-runtime/thread-projection';

export function ThreadSkillMaterials({ content }: { content: unknown }) {
  const materials = historySkillMaterials(content);
  if (!materials.length) return null;
  return <aside aria-label="Skill materials" className="my-2 rounded border p-2 text-xs text-muted-foreground break-words">
    <p className="font-medium text-foreground">Skill material</p>
    <ul className="space-y-2">{materials.map(material => <li key={`${material.resourceId}:${material.ordinal}`}>
      <p>{material.name} · version {material.reference.version}</p>
      <p>Source: {material.reference.path} · {material.reference.domainId} · {material.reference.viewId}</p>
    </li>)}</ul>
  </aside>;
}
