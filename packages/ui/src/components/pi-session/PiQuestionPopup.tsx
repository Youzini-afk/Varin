import React from 'react';
import type { UserQuestionAnswer } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { piDialogResponseKey, usePiInteractionStore, userQuestionRequest } from '@/stores/usePiInteractionStore';

export function PiQuestionPopup() {
  const { t } = useI18n();
  const dialogs = usePiInteractionStore(state => state.dialogs);
  const hidden = usePiInteractionStore(state => state.hiddenQuestions);
  const popupUntil = usePiInteractionStore(state => state.questionPopupUntil);
  const drafts = usePiInteractionStore(state => state.questionDrafts);
  const responding = usePiInteractionStore(state => state.responding);
  const hide = usePiInteractionStore(state => state.hideQuestion);
  const setDraft = usePiInteractionStore(state => state.setQuestionDraft);
  const respond = usePiInteractionStore(state => state.respondDialog);
  const [now, setNow] = React.useState(Date.now);
  const dialog = dialogs.find(dialog => dialog.method === 'question' && !hidden[dialog.id]);
  const question = dialog ? userQuestionRequest(dialog) : null;
  const expiresAt = question ? popupUntil[question.id] ?? question.popupUntil : undefined;

  React.useEffect(() => {
    if (!question || expiresAt === undefined) return;
    const refresh = () => { setNow(Date.now()); if (Date.now() >= expiresAt) hide(question.id); };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [question, expiresAt, hide]);

  if (!question || !dialog || expiresAt === undefined || expiresAt <= now) return null;
  const values = drafts[question.id] ?? {};
  const busy = responding[piDialogResponseKey(question.id)] === true;
  const valueOf = (id: string, prefill?: string) => values[id] ?? prefill;
  const complete = question.questions.every(item => item.type === 'confirm' ? typeof values[item.id] === 'boolean' : typeof valueOf(item.id, item.prefill) === 'string');
  const waiting = question.waitingUntil !== undefined && question.waitingUntil > now;
  const submit = async () => {
    const answers: UserQuestionAnswer[] = question.questions.map(item => ({ id: item.id, type: item.type, value: valueOf(item.id, item.prefill)! }));
    try { await respond(question.id, answers.map(({ id, type, value }) => ({ id, type, value }))); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };

  return <section role="region" aria-label={t('pi.question.title')} className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl border border-border bg-background px-4 py-3 shadow-xl animate-in slide-in-from-bottom-3">
    <header className="mb-3 flex items-center gap-2">
      <Icon name="question" className="size-4 text-primary" />
      <span className="min-w-0 flex-1 typography-ui-label font-medium">{t('pi.question.title')}</span>
      <span className="typography-meta text-muted-foreground">{waiting ? t('pi.question.waiting', { seconds: Math.ceil((question.waitingUntil! - now) / 1000) }) : t('pi.question.continuing')}</span>
      <Button size="icon" variant="ghost" className="size-7" aria-label={t('pi.question.hide')} onClick={() => hide(question.id)}><Icon name="close" className="size-4" /></Button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="max-h-[40vh] space-y-4 overflow-y-auto">
        {question.questions.map(item => <fieldset key={item.id} disabled={busy} className="space-y-2">
          <legend className="mb-2 whitespace-pre-wrap typography-ui-label">{item.question}</legend>
          {item.type === 'select' ? <>
            <div className="grid gap-2 sm:grid-cols-2">{item.options?.map((option, index) => <Button key={index} type="button" variant={values[item.id] === option.value ? 'default' : 'outline'} className="h-auto justify-start whitespace-normal py-2 text-left" onClick={() => setDraft(question.id, item.id, option.value)}>
              <span>{option.label}{option.description ? <span className="mt-1 block typography-meta opacity-75">{option.description}</span> : null}</span>
            </Button>)}</div>
            {item.allowOther !== false ? <Input aria-label={item.question} placeholder={t('pi.question.custom')} value={typeof values[item.id] === 'string' && !item.options?.some(option => option.value === values[item.id]) ? values[item.id] as string : ''} onChange={event => setDraft(question.id, item.id, event.target.value)} /> : null}
          </> : item.type === 'confirm' ? <div className="flex gap-2">{[true, false].map(value => <Button key={String(value)} type="button" variant={values[item.id] === value ? 'default' : 'outline'} onClick={() => setDraft(question.id, item.id, value)}>{t(value ? 'pi.question.yes' : 'pi.question.no')}</Button>)}</div>
            : item.type === 'editor' ? <Textarea aria-label={item.question} rows={4} placeholder={item.placeholder} value={String(valueOf(item.id, item.prefill) ?? '')} onChange={event => setDraft(question.id, item.id, event.target.value)} />
              : <Input aria-label={item.question} placeholder={item.placeholder} value={String(valueOf(item.id, item.prefill) ?? '')} onChange={event => setDraft(question.id, item.id, event.target.value)} />}
        </fieldset>)}
      </div>
      <footer className="mt-3 flex justify-end"><Button type="submit" size="sm" disabled={busy || !complete}>{t('pi.question.submit')}</Button></footer>
    </form>
  </section>;
}
