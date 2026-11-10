import React from 'react';
import { beginContentReferenceInsertion } from '@/lib/agent-editor/attachments';
import { declarativeDiscussionText } from '@/lib/interactive-ui/discussion';
import { conversationUiFields, conversationUiText, type ConversationUiField } from '@varin/application-client';
import { useDeclarativeUi, type DeclarativeUiSource } from '@/lib/interactive-ui/useDeclarativeUi';
import { composeUiResult, sendUiResult, beginUiComposeInsertion, type UiComposeInput } from '@/lib/interactive-ui/compose';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { EmbeddedUiContent } from './EmbeddedUiContent';
import { NativeObjectContent } from './NativeObjectContent';
import { useNativeObjectActions } from '@/lib/interactive-ui/native-object-actions';
import { InteractionDisclosure } from './InteractionDisclosure';
import { UiRevisionLink } from './UiRevisionLink';
import { Icon } from '@/components/icon/Icon';
import { QuestionChoices, QuestionSupplement } from '@/components/ui/question-controls';

const controlClass = 'conversation-ui-control min-w-0 max-w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const buttonClass = 'conversation-ui-action rounded-md border border-border px-3 py-2 text-sm hover:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
export const DeclarativeUiContent = React.memo(function DeclarativeUiContent(props: DeclarativeUiSource) {
  const [shown, setShown] = React.useState(props.node);
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setShown(props.node); }, [props.node]);
  const shownSource = React.useRef(props.source);
  if (shown === props.node) shownSource.current = props.source;
  const view = useDeclarativeUi({ ...props, node: shown, source: shownSource.current });
  const { t } = useI18n();
  const objectActions = useNativeObjectActions();
  const id = React.useId();
  const surface = React.useRef<HTMLElement | null>(null);
  const [status, setStatus] = React.useState('');
  const [statusText, setStatusText] = React.useState('');
  const [failure, setFailure] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const pending = React.useRef<UiComposeInput | undefined>(undefined);
  const [pendingText, setPendingText] = React.useState<string>();
  const [sentText, setSentText] = React.useState<string>();
  const action = typeof shown.action === 'string' ? { type: 'compose' as const, label: shown.action } : shown.action;
  const text = conversationUiText(shown, view.values);
  const fields = conversationUiFields(shown);
  const missing = fields.filter(field => {
    const value = view.values[field.key];
    return field.required && (value == null || value === '' || Array.isArray(value) && !value.length) && !(field.type === 'choice' && view.values[`${field.key}:other`]);
  });
  const run = async () => {
    if (!action || busyRef.current || action.type === 'send' && sentText === text) return;
    if (!pending.current && (missing.length || !surface.current || surface.current.tagName === 'FORM' && !(surface.current as HTMLFormElement).reportValidity())) { setFailure(t('ui.fragment.required')); return; }
    busyRef.current = true; setBusy(true); setFailure(''); setStatus(''); setStatusText(text);
    const insertion = action.type === 'compose' && view.session ? beginUiComposeInsertion(view.session.identity) : undefined;
    try {
      if (action.type === 'open') { await objectActions.open(action.ref!); return; }
      if (action.type === 'copy') { const copied = await copyTextToClipboard(text); if (!copied.ok) throw new Error(copied.error); setStatus(t('ui.fragment.copied')); return; }
      if (!view.session) throw new Error(t('ui.fragment.noConversation'));
      let input = pending.current;
      if (!input || action.type !== 'send') {
        // Freeze the displayed selection before asynchronous snapshot preparation.
        const reference = shown.type === 'object' ? await objectActions.reference(shown.ref) : await view.reference(text);
        input = { identity: view.session.identity, host: view.host, sourceKey: props.sourceKey, text, reference, insertion };
        if (action.type === 'send') { pending.current = input; setPendingText(input.text); }
      }
      if (action.type === 'send') {
        const receipt = await sendUiResult(input); setStatusText(input.text); setStatus(t(receipt.status === 'queued' ? 'ui.fragment.queued' : 'ui.fragment.sent'));
        setSentText(input.text); pending.current = undefined; setPendingText(undefined);
      } else { await composeUiResult(input); setStatusText(input.text); setStatus(t('ui.fragment.filled')); }
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { insertion?.dispose(); busyRef.current = false; setBusy(false); }
  };
  const quote = async () => {
    if (!view.session || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFailure('');
    const insertion = beginContentReferenceInsertion(view.session.identity);
    try {
      const reference = shown.type === 'object' ? await objectActions.reference(shown.ref)
        : await view.reference(declarativeDiscussionText(shown, view.state));
      if (reference) insertion.add(reference);
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { insertion.dispose(); busyRef.current = false; setBusy(false); }
  };
  const renderField = (field: ConversationUiField, index: number) => {
    const fieldId = `${id}:${field.key}`, value = view.values[field.key];
    const heading = <>{fields.length > 1 && <span className="question-field-number">{String(index + 1).padStart(2, '0')}</span>}<span>{field.label ?? field.key}{field.type === 'input' && field.unit ? ` (${field.unit})` : ''}{field.required ? ' *' : ''}</span>{field.type === 'choice' && field.multiple && <span className="question-field-meta">{t('ui.question.multiple')}</span>}</>;
    if (field.type === 'choice') return <fieldset key={field.key} className="question-field">
      <legend id={`${fieldId}:label`} className="question-field-title">{heading}</legend>
      <QuestionChoices name={fieldId} labelledBy={`${fieldId}:label`} options={field.options.map(option => ({ id: option.key, label: option.label }))}
        selected={Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []} multiple={field.multiple}
        onChange={selected => { view.setValue(field.key, field.multiple ? selected : selected[0] ?? ''); setStatus(''); }} />
      {field.allowOther && <QuestionSupplement value={String(view.values[`${field.key}:other`] ?? '')}
        onChange={value => { view.setValue(`${field.key}:other`, value); setStatus(''); }} />}
    </fieldset>;
    const inputProps = { id: fieldId, value: String(value ?? ''), placeholder: field.placeholder, required: field.required,
      className: `block w-full mt-1 ${controlClass}`, onInput: (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => { view.setValue(field.key, event.currentTarget.value); setStatus(''); } };
    if (field.inputType === 'range') {
      const min = field.min ?? 0, max = field.max ?? 100;
      const number = Number(value ?? min), current = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
      const progress = max > min ? (current - min) / (max - min) * 100 : 0;
      return <div key={field.key} className="question-field conversation-ui-range">
        <div className="conversation-ui-range-heading"><label htmlFor={fieldId} className="question-field-title">
          {fields.length > 1 && <span className="question-field-number">{String(index + 1).padStart(2, '0')}</span>}<span>{field.label ?? field.key}{field.required ? ' *' : ''}</span>
        </label><output htmlFor={fieldId}>{current}{field.unit && <span> {field.unit}</span>}</output></div>
        <input {...inputProps} className="conversation-ui-range-input" type="range" value={String(current)} min={min} max={max} step={field.step}
          style={{ '--range-progress': `${progress}%` } as React.CSSProperties} />
      </div>;
    }
    return <div key={field.key} className="question-field"><label htmlFor={fieldId} className="question-field-title">{heading}</label>
      {field.inputType === 'textarea' ? <textarea {...inputProps} className="question-text-input" rows={3} /> : <input {...inputProps} type={field.inputType} min={field.min} max={field.max} step={field.step} />}
    </div>;
  };
  const selectedTab = shown.type === 'tabs' ? shown.tabs.find(tab => tab.key === view.state.controls.tab) ?? shown.tabs[0] : undefined;
  const Surface = shown.type === 'embed' ? 'div' : 'form';
  return <Surface ref={(element: HTMLDivElement | HTMLFormElement | null) => { surface.current = element; }} onSubmit={event => event.preventDefault()} data-conversation-ui-fragment={props.sourceKey} data-chat-view-ref={view.session?.viewRef} data-chat-revision-ref={props.source?.ref} className="conversation-ui-fragment my-3 min-w-0 space-y-3 text-foreground" aria-label={shown.label}
    onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused.current = false; setShown(props.node); } }}>
    {shown.type !== 'embed' && view.session && <button type="button" className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-interactive-hover focus-visible:outline-2 focus-visible:outline-primary"
      disabled={busy} onClick={() => void quote()}><Icon name="chat-quote" className="size-3.5" />{t('chat.context.quoteContent')}</button>}
    {shown !== props.node && <p role="status" className="text-sm text-muted-foreground">{t('ui.fragment.updated')} <button type="button" className={buttonClass} onClick={() => { focused.current = false; setShown(props.node); }}>{t('ui.fragment.applyUpdate')}</button></p>}
    {shown.type === 'form' && shown.label && <p className="font-medium">{shown.label}</p>}
    {fields.length > 0 && <div className="conversation-ui-fields">{fields.map(renderField)}</div>}
    {shown.type === 'disclosure' && <InteractionDisclosure open={view.state.controls.open === true} onOpenChange={open => view.setControl('open', open)} title={shown.label ?? t('ui.fragment.details')}>
      <SimpleMarkdownRenderer content={shown.content} variant="tool" />
    </InteractionDisclosure>}
    {shown.type === 'tabs' && <div><div role="tablist" aria-label={shown.label} className="conversation-ui-tablist">{shown.tabs.map(tab => <button type="button" key={tab.key} role="tab" id={`${id}:tab:${tab.key}`} aria-controls={`${id}:panel:${tab.key}`} aria-selected={selectedTab?.key === tab.key} tabIndex={selectedTab?.key === tab.key ? 0 : -1}
      className="conversation-ui-tab" onClick={() => view.setControl('tab', tab.key)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
        const index = shown.tabs.findIndex(item => item.key === tab.key), next = event.key === 'Home' ? 0 : event.key === 'End' ? shown.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + shown.tabs.length) % shown.tabs.length;
        view.setControl('tab', shown.tabs[next]!.key); document.getElementById(`${id}:tab:${shown.tabs[next]!.key}`)?.focus();
      }}>{tab.label}</button>)}</div>
      <div className="conversation-ui-tabs">{shown.tabs.map(tab => <div key={tab.key} className="conversation-ui-reveal" data-open={selectedTab?.key === tab.key} role="tabpanel" id={`${id}:panel:${tab.key}`} aria-labelledby={`${id}:tab:${tab.key}`} aria-hidden={selectedTab?.key !== tab.key} inert={selectedTab?.key !== tab.key}><div><div className="conversation-ui-tab-content"><SimpleMarkdownRenderer content={tab.content} /></div></div></div>)}</div>
    </div>}
    {shown.type === 'embed' && <EmbeddedUiContent refValue={shown.ref} sourceKey={props.sourceKey} />}
    {shown.type === 'object' && <NativeObjectContent refValue={shown.ref} />}
    {action && <div className="conversation-ui-actions" data-choice={fields.length === 1 && fields[0]?.type === 'choice' || undefined}>
      {action.type === 'send' && <InteractionDisclosure title={t('ui.fragment.preview')}><p className="whitespace-pre-wrap text-sm">{pendingText ?? text}</p></InteractionDisclosure>}
      <div className="conversation-ui-action-row">
        <button type="button" className="conversation-ui-submit" data-conversation-ui-action={action.type}
          title={action.type === 'compose' || action.type === 'reference' ? t('ui.fragment.compose') : undefined}
          aria-label={action.type === 'compose' || action.type === 'reference' ? `${t('ui.fragment.compose')} · ${action.label}` : undefined}
          disabled={busy || action.type === 'send' && sentText === text} onClick={() => void run()}>
          <span>{typeof shown.action === 'string' ? t('ui.fragment.compose') : action.type === 'send' ? `${t('ui.fragment.send')} · ${action.label}` : action.label}</span>
          <Icon name={busy ? 'loader-4' : action.type === 'send' ? 'arrow-up' : action.type === 'copy' ? 'file-copy' : 'arrow-right-up'} aria-hidden="true" className={busy ? 'animate-spin motion-reduce:animate-none' : undefined} />
        </button>
        <span className="conversation-ui-status" role="status">{status && statusText === text && <><Icon name="check" aria-hidden="true" />{status}</>}</span>
      </div>
    </div>}
    {view.resetKeys.length > 0 && <p role="status" className="text-sm text-muted-foreground">{t('ui.fragment.reselect')}: {view.resetKeys.map(key => fields.find(field => field.key === key)?.label ?? key).join(', ')}</p>}
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    {view.error && <p role="alert" className="text-sm text-destructive">{t('ui.fragment.unsaved')}: {view.error} <button type="button" className={buttonClass} onClick={view.retry}>{t('ui.fragment.retry')}</button></p>}
    {!props.session && shown.type !== 'embed' && shown.type !== 'object' && view.session && <UiRevisionLink session={view.session} />}
  </Surface>;
}, (before, after) => before.node === after.node && before.sourceKey === after.sourceKey && before.session === after.session
  && before.source === after.source && before.isStreaming === after.isStreaming
  && before.fragment?.messageId === after.fragment?.messageId && before.fragment?.fragmentKey === after.fragment?.fragmentKey
  && before.fragment?.contentIndex === after.fragment?.contentIndex && before.fragment?.contentVersion === after.fragment?.contentVersion);
