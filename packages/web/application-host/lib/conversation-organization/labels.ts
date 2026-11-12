/** Read presentation names from their actual owners. References and permissions stay in Catalog. */
export async function readConversationOrganizationLabels(input: { botIds: string[]; projectIds: string[] }, owners: {
  bots(): Promise<Array<{id:string;name:string}>>;
  settings(): Promise<{projects?:unknown}>;
}, signal: AbortSignal) {
  const [bots, settings] = await Promise.allSettled([owners.bots(), owners.settings()]);
  const rawProjects = settings.status === 'fulfilled' ? settings.value.projects : undefined;
  const validProjects = rawProjects === undefined || Array.isArray(rawProjects) && rawProjects.every(project => project && typeof project === 'object' && typeof project.id === 'string' && (project.label === undefined || typeof project.label === 'string') && typeof project.path === 'string' && !!project.path.trim());
  const projects = validProjects && Array.isArray(rawProjects) ? rawProjects as Array<{id:string;label?:string;path:string}> : [];
  const botMap = new Map(bots.status === 'fulfilled' ? bots.value.map(bot => [bot.id, bot.name]) : []);
  const projectMap = new Map(projects.map(project => [project.id, project.label || project.path]));
  const labels = (ids: string[], names: Map<string,string>, available: boolean) => [...new Set(ids)].map(id => ({ id, name: names.get(id) ?? null,
    status: !available ? 'unavailable' as const : names.has(id) ? 'available' as const : 'missing' as const }));
  signal.throwIfAborted();
  return { bots: labels(input.botIds, botMap, bots.status === 'fulfilled'), projects: labels(input.projectIds, projectMap, settings.status === 'fulfilled' && validProjects) };
}
