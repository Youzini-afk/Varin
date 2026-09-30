import * as React from 'react';
import { runtimeFetch } from '@varin/application-client';
import type { ExperimentAttemptView, FollowUpDefinitionView, FollowUpSource } from '@varin/protocol';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { saveFollowUp } from '@/lib/followUpsApi';
import { selectActivePiSessions, usePiSessionStore } from '@/stores/usePiSessionStore';
import { regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { piSessionTitle } from '@/components/pi-session/sessionPresentation';

type EditableKind = 'time' | 'file' | 'experiment' | 'external' | 'manual';
const editableKinds: EditableKind[] = ['time', 'file', 'experiment', 'external', 'manual'];
const localTime = (at: number) => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

interface Props {
  open: boolean;
  entry?: FollowUpDefinitionView | null;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}

export function FollowUpEditorDialog(props: Props) {
  const { t } = useI18n();
  const [saving, setSaving] = React.useState(false);
  return <Dialog open={props.open} onOpenChange={(open) => { if (!saving) props.onOpenChange(open); }}>
    <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" showCloseButton={!saving}>
      <DialogTitle>{t(props.entry ? 'followupEditor.edit' : 'followupEditor.create')}</DialogTitle>
      <DialogDescription>{t('followupEditor.description')}</DialogDescription>
      {props.open ? <FollowUpForm key={props.entry?.id ?? 'new'} {...props} saving={saving} setSaving={setSaving} /> : null}
    </DialogContent>
  </Dialog>;
}

function FollowUpForm({ entry, onSaved, onOpenChange, saving, setSaving }: Props & { saving: boolean; setSaving(value: boolean): void }) {
  const { t, locale } = useI18n();
  const allSessions = usePiSessionStore(selectActivePiSessions);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const botSessionIndex = useBotSessionIndex();
  const sessions = React.useMemo(
    () => regularPiSessions(allSessions, botSessionIndex, runtimeKey),
    [allSessions, botSessionIndex, runtimeKey],
  );
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const defaultSession = sessions.find((session) => session.id === currentSessionId && session.workspace?.kind !== 'unbound')
    ?? sessions.find((session) => session.workspace?.kind !== 'unbound');
  const [sessionId, setSessionId] = React.useState(entry?.sessionId ?? defaultSession?.id ?? '');
  const [instruction, setInstruction] = React.useState(entry?.instruction ?? '');
  const [kind, setKind] = React.useState<FollowUpSource['kind']>(entry?.source.kind ?? 'time');
  const [at, setAt] = React.useState(localTime(entry?.source.kind === 'time' ? entry.source.at : Date.now() + 15 * 60_000));
  const [filePath, setFilePath] = React.useState(entry?.source.kind === 'file' ? entry.source.path : '');
  const [fileCondition, setFileCondition] = React.useState<'exists' | 'changed' | 'ready'>(entry?.source.kind === 'file' ? entry.source.condition : 'exists');
  const [attemptId, setAttemptId] = React.useState(entry?.source.kind === 'experiment' ? entry.source.attemptId : '');
  const [branch, setBranch] = React.useState(entry?.source.kind === 'external' ? entry.source.branch ?? '' : '');
  const [prCondition, setPrCondition] = React.useState<'exists' | 'open' | 'merged' | 'closed'>(entry?.source.kind === 'external' ? entry.source.condition : 'merged');
  const [attempts, setAttempts] = React.useState<ExperimentAttemptView[]>([]);
  const [attemptsLoading, setAttemptsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attemptsError, setAttemptsError] = React.useState<string | null>(null);
  const [sourceChanged, setSourceChanged] = React.useState(false);
  const supported = editableKinds.includes(kind as EditableKind);
  const [sessionQuery, setSessionQuery] = React.useState('');
  const visibleSessions = sessions.filter((session) => piSessionTitle(session, session.id).toLocaleLowerCase().includes(sessionQuery.toLocaleLowerCase()));
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const selectedSessionLabel = session ? piSessionTitle(session, session.id) : sessionId;

  React.useEffect(() => {
    if (usePiSessionStore.getState().catalogLoaded) return;
    void usePiSessionStore.getState().loadCatalog().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  React.useEffect(() => {
    if (kind !== 'experiment' || !sessionId) return;
    const controller = new AbortController();
    setAttemptsLoading(true);
    setAttemptsError(null);
    void runtimeFetch(`/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Experiment list failed (${response.status})`);
        const body = await response.json();
        if (!Array.isArray(body?.attempts)) throw new Error('Invalid experiment list response');
        if (!controller.signal.aborted) setAttempts(body.attempts);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setAttemptsError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setAttemptsLoading(false); });
    return () => controller.abort();
  }, [kind, sessionId]);

  const buildSource = (): FollowUpSource | undefined => {
    // Editing only the instruction must retain Agent-created advanced sources,
    // deadlines and source-specific options that this simple form did not change.
    if (entry && !sourceChanged) return undefined;
    if (kind === 'time') {
      const timestamp = new Date(at).getTime();
      if (!Number.isFinite(timestamp)) throw new Error(t('followupEditor.invalidTime'));
      return { kind, at: timestamp, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    if (kind === 'file') return { ...(entry?.source.kind === kind ? entry.source : {}), kind, path: filePath.trim(), condition: fileCondition };
    if (kind === 'experiment') return { ...(entry?.source.kind === kind ? entry.source : {}), kind, attemptId };
    if (kind === 'external') {
      const source: Extract<FollowUpSource, { kind: 'external' }> = { ...(entry?.source.kind === kind ? entry.source : {}), kind, provider: 'github-pr', condition: prCondition };
      if (branch.trim()) source.branch = branch.trim();
      else delete source.branch;
      return source;
    }
    if (kind === 'manual') return { ...(entry?.source.kind === kind ? entry.source : {}), kind };
    return undefined;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const source = buildSource();
      await saveFollowUp(sessionId, { instruction: instruction.trim(), ...(source ? { source } : {}) }, entry ?? undefined);
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <form onSubmit={(event) => void submit(event)} className="space-y-4">
    <div className="space-y-1.5">
      <label className="typography-meta font-medium" htmlFor="followup-session">{t('followupEditor.session')}</label>
      <Select value={sessionId} onValueChange={(value) => { if (value !== null) { setSessionId(value); setAttemptId(''); setAttempts([]); } }} disabled={Boolean(entry) || saving}>
        <SelectTrigger id="followup-session" className="w-full"><SelectValue>{selectedSessionLabel || t('followupEditor.chooseSession')}</SelectValue></SelectTrigger>
        <SelectContent>
          <div className="px-2 pb-2"><Input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder={t('tasksHub.search')} aria-label={t('followupEditor.chooseSession')} onKeyDown={(event) => event.stopPropagation()} /></div>
          {visibleSessions.map((item) => <SelectItem key={item.id} value={item.id} disabled={item.workspace?.kind === 'unbound'}>{piSessionTitle(item, item.id)}</SelectItem>)}
        </SelectContent>
      </Select>
      {!defaultSession && !entry ? <p className="typography-micro text-muted-foreground">{t('followupEditor.noSessions')}</p> : null}
    </div>
    <div className="space-y-1.5">
      <label className="typography-meta font-medium" htmlFor="followup-instruction">{t('followupEditor.instruction')}</label>
      <Textarea id="followup-instruction" required value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4} disabled={saving} />
    </div>
    <div className="space-y-1.5">
      <label className="typography-meta font-medium" htmlFor="followup-kind">{t('followupEditor.condition')}</label>
      <Select value={kind} onValueChange={(value) => { if (value && editableKinds.includes(value as EditableKind)) { setKind(value as EditableKind); setSourceChanged(true); } }} disabled={saving}>
        <SelectTrigger id="followup-kind" className="w-full"><SelectValue>{supported ? t(`followupEditor.kind.${kind as EditableKind}`) : t('followupEditor.keepSource')}</SelectValue></SelectTrigger>
        <SelectContent>{editableKinds.map((value) => <SelectItem key={value} value={value}>{t(`followupEditor.kind.${value}`)}</SelectItem>)}</SelectContent>
      </Select>
      {!supported ? <p className="typography-micro text-muted-foreground">{entry?.waitingSummary}</p> : null}
    </div>
    {kind === 'time' ? <label className="block space-y-1.5 typography-meta">{t('followupEditor.at')}
      <Input type="datetime-local" value={at} required disabled={saving} onChange={(event) => { setAt(event.target.value); setSourceChanged(true); }} />
      <span className="block typography-micro text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
    </label> : null}
    {kind === 'file' ? <div className="space-y-2">
      <label className="block space-y-1.5 typography-meta">{t('followupEditor.path')}<Input required value={filePath} disabled={saving} onChange={(event) => { setFilePath(event.target.value); setSourceChanged(true); }} /></label>
      <Select value={fileCondition} onValueChange={(value) => { if (value) { setFileCondition(value as typeof fileCondition); setSourceChanged(true); } }} disabled={saving}><SelectTrigger className="w-full" aria-label={t('followupEditor.condition')}><SelectValue>{t(`followupEditor.file.${fileCondition}`)}</SelectValue></SelectTrigger><SelectContent>{(['exists', 'changed', 'ready'] as const).map((value) => <SelectItem key={value} value={value}>{t(`followupEditor.file.${value}`)}</SelectItem>)}</SelectContent></Select>
    </div> : null}
    {kind === 'experiment' ? <div className="space-y-1.5">
      <Select value={attemptId} onValueChange={(value) => { if (value) { setAttemptId(value); setSourceChanged(true); } }} disabled={saving || attemptsLoading}><SelectTrigger className="w-full" aria-label={t('followupEditor.chooseExperiment')}><SelectValue placeholder={t('followupEditor.chooseExperiment')} /></SelectTrigger><SelectContent>{attempts.map((attempt) => <SelectItem key={attempt.attemptId} value={attempt.attemptId}>{new Date(attempt.createdAt).toLocaleString(locale)} · {t(`research-facts.attempt.${attempt.state}`)} · {attempt.attemptId.slice(-6)}</SelectItem>)}</SelectContent></Select>
      {attemptsError ? <p role="alert" className="typography-micro text-[var(--status-error)]">{attemptsError}</p> : !attemptsLoading && attempts.length === 0 ? <p className="typography-micro text-muted-foreground">{t('research-facts.emptyAttempts')}</p> : null}
    </div> : null}
    {kind === 'external' ? <div className="space-y-2">
      <label className="block space-y-1.5 typography-meta">{t('followupEditor.branch')}<Input value={branch} disabled={saving} onChange={(event) => { setBranch(event.target.value); setSourceChanged(true); }} /></label>
      <Select value={prCondition} onValueChange={(value) => { if (value) { setPrCondition(value as typeof prCondition); setSourceChanged(true); } }} disabled={saving}><SelectTrigger className="w-full" aria-label={t('followupEditor.condition')}><SelectValue>{t(`followupEditor.pr.${prCondition}`)}</SelectValue></SelectTrigger><SelectContent>{(['exists', 'open', 'merged', 'closed'] as const).map((value) => <SelectItem key={value} value={value}>{t(`followupEditor.pr.${value}`)}</SelectItem>)}</SelectContent></Select>
    </div> : null}
    {error ? <p role="alert" className="typography-meta text-[var(--status-error)]">{error}</p> : null}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{t('sessions.scheduledTasks.editor.actions.cancel')}</Button>
      <Button type="submit" disabled={saving || !sessionId || !instruction.trim() || (kind === 'experiment' && !attemptId)}>{saving ? <Icon name="loader-4" className="mr-1 size-4 animate-spin" /> : null}{t(entry ? 'sessions.scheduledTasks.editor.actions.save' : 'tasksHub.create')}</Button>
    </div>
  </form>;
}
