import { isAgentAvatarId } from '@varin/protocol';
import { COMPANION_PROJECT_VISIBLE_LIMIT, type DesktopCompanionPortfolio, type DesktopCompanionTeam } from '@varin/application-client/desktop';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const count = (v: unknown) => v === null || Number.isSafeInteger(v) && (v as number) >= 0;
/** Copies only bounded, inert presentation fields; no task text, markup or resource URLs. */
export function readCompanionPortfolio(input: unknown, readTeam: (value: unknown) => DesktopCompanionTeam): DesktopCompanionPortfolio {
  if (!object(input) || !['overview','intake','inspection','attention','result'].includes(String(input.mode))
    || !Array.isArray(input.projects) || input.projects.length > COMPANION_PROJECT_VISIBLE_LIMIT || !count(input.overflowCards)) throw new Error('Invalid director portfolio');
  const keys = new Set<string>(), labels = new Set<string>();
  const projects: DesktopCompanionPortfolio['projects'] = input.projects.map(raw => {
    if (!object(raw) || !key(raw.key) || keys.has(raw.key) || !['A','B','C'].includes(String(raw.label)) || labels.has(String(raw.label))
      || !object(raw.lead) || !isAgentAvatarId(raw.lead.avatar) || !['project-lead','child-agent'].includes(String(raw.lead.role))
      || !['needs-user','uncertain','active','settling','result','available','unknown'].includes(String(raw.status))
      || raw.caption !== undefined && (typeof raw.caption !== 'string' || [...raw.caption].length > 24 || !raw.caption.trim() || raw.caption.replace(/\s+/gu, ' ').trim() !== raw.caption || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw.caption))
      || raw.notice !== undefined && !['permission','question','mixed','inspect','unknown'].includes(String(raw.notice))
      || !count(raw.requestCount) || !count(raw.uncertainCount)
      || raw.detail !== undefined && !['reading','editing','searching','executing','computing','organizing','verifying','delegating','generating','waiting'].includes(String(raw.detail))) throw new Error('Invalid director project');
    keys.add(raw.key); labels.add(String(raw.label));
    return { key: raw.key, ...(raw.caption === undefined ? {} : { caption: raw.caption as string }), label: raw.label as 'A'|'B'|'C', lead: { avatar: raw.lead.avatar, role: raw.lead.role as 'project-lead'|'child-agent' },
      ...(raw.notice === undefined ? {} : { notice: raw.notice as NonNullable<DesktopCompanionPortfolio['projects'][number]['notice']> }), status: raw.status as DesktopCompanionPortfolio['projects'][number]['status'], requestCount: raw.requestCount as number|null,
      uncertainCount: raw.uncertainCount as number|null, ...(raw.detail === undefined ? {} : { detail: raw.detail as NonNullable<DesktopCompanionPortfolio['projects'][number]['detail']> }) };
  });
  if (![input.inspectedKey,input.subjectKey].every(v => v === null || typeof v === 'string' && keys.has(v))) throw new Error('Director subject is not a visible project');
  let team: DesktopCompanionPortfolio['team'];
  if (input.team !== undefined) {
    if (!object(input.team) || !key(input.team.projectKey) || !keys.has(input.team.projectKey) || input.team.projectKey !== input.inspectedKey) throw new Error('Director team has no inspected owner');
    team = { ...readTeam(input.team), projectKey: input.team.projectKey };
  }
  return { mode: input.mode as DesktopCompanionPortfolio['mode'], projects, inspectedKey: input.inspectedKey as string|null,
    subjectKey: input.subjectKey as string|null, overflowCards: input.overflowCards as number|null, ...(team ? { team } : {}) };
}
