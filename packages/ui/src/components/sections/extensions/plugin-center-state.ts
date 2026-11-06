export interface PluginCenterView {
  tab: 'discover' | 'installed';
  query: string;
  category: string;
  group: 'all' | 'external' | 'builtin';
  scroll: number;
}
const defaults = (): PluginCenterView => ({ tab: 'discover', query: '', category: 'all', group: 'all', scroll: 0 });
export function readPluginCenterView(hostId: string): PluginCenterView {
  try {
    const saved = JSON.parse(localStorage.getItem(`varin.plugin-center.${hostId}`) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaults();
    return { tab: saved.tab === 'installed' ? 'installed' : 'discover', query: typeof saved.query === 'string' ? saved.query : '',
      category: typeof saved.category === 'string' ? saved.category : 'all', group: ['external', 'builtin'].includes(saved.group) ? saved.group : 'all',
      scroll: Number.isFinite(saved.scroll) && saved.scroll >= 0 ? saved.scroll : 0 };
  } catch { return defaults(); }
}
export function savePluginCenterView(hostId: string, view: PluginCenterView): void {
  try { localStorage.setItem(`varin.plugin-center.${hostId}`, JSON.stringify(view)); } catch { /* Storage may be unavailable. */ }
}
export function matchesPluginQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.filter(Boolean).join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}
