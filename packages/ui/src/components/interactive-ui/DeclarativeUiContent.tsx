import React from 'react';
import { conversationUiFields, conversationUiText, type ConversationUiField } from '@varin/application-client';
import { useDeclarativeUi, type DeclarativeUiSource } from '@/lib/interactive-ui/useDeclarativeUi';
import { composeUiResult, sendUiResult, type UiComposeInput } from '@/lib/interactive-ui/compose';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { EmbeddedUiContent } from './EmbeddedUiContent';
import { NativeObjectContent } from './NativeObjectContent';
import { useNativeObjectActions } from '@/lib/interactive-ui/native-object-actions';

const controlClass = 'min-w-0 max-w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const buttonClass = 'rounded-md border border-border px-3 py-2 text-sm hover:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
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
    busyRef.current = true; setBusy(true); setFailure(''); setStatus('');
    try {
      if (action.type === 'open') { await objectActions.open(action.ref!); return; }
      if (action.type === 'copy') { const copied = await copyTextToClipboard(text); if (!copied.ok) throw new Error(copied.error); setStatus(t('ui.fragment.copied')); return; }
      if (!view.session) throw new Error(t('ui.fragment.noConversation'));
      let input = pending.current;
      if (!input || action.type !== 'send') {
        // Freeze the displayed selection before asynchronous snapshot preparation.
        const reference = shown.type === 'object' ? await objectActions.reference(shown.ref) : await view.reference(text);
        input = { identity: view.session.identity, host: view.host, sourceKey: props.sourceKey, text, reference };
        if (action.type === 'send') { pending.current = input; setPendingText(input.text); }
      }
      if (action.type === 'send') {
        const receipt = await sendUiResult(input); setStatus(t(receipt.status === 'queued' ? 'ui.fragment.queued' : 'ui.fragment.sent'));
        setSentText(input.text); pending.current = undefined; setPendingText(undefined);
      } else { await composeUiResult(input); setStatus(t('ui.fragment.filled')); }
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const renderField = (field: ConversationUiField) => {
    const fieldId = `${id}:${field.key}`, value = view.values[field.key];
    if (field.type === 'choice') return <fieldset key={field.key} className="space-y-2 min-w-0">
      <legend className="font-medium mb-2">{field.label ?? field.key}{field.required ? ' *' : ''}</legend>
      <div className="flex flex-col gap-2">{field.options.map(option => {
        const checked = Array.isArray(value) ? value.includes(option.key) : value === option.key;
        return <label key={option.key} className={`flex items-start gap-2 ${controlClass} ${checked ? 'border-primary bg-primary/5' : ''}`}>
          <input type={field.multiple ? 'checkbox' : 'radio'} name={fieldId} checked={checked} className="mt-1 shrink-0 accent-primary"
            onChange={() => { view.setValue(field.key, field.multiple ? checked ? (Array.isArray(value) ? value : []).filter(item => item !== option.key) : [...(Array.isArray(value) ? value : []), option.key] : option.key); setStatus(''); }} />
          <span className="whitespace-pre-wrap break-words min-w-0">{option.label}</span>
        </label>;
      })}</div>
      {field.allowOther && <label className="block text-sm">{t('ui.fragment.other')}<input className={`block w-full mt-1 ${controlClass}`} type="text" value={String(view.values[`${field.key}:other`] ?? '')}
        onInput={event => view.setValue(`${field.key}:other`, event.currentTarget.value)} /></label>}
    </fieldset>;
    const inputProps = { id: fieldId, value: String(value ?? ''), placeholder: field.placeholder, required: field.required,
      className: `block w-full mt-1 ${controlClass}`, onInput: (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => view.setValue(field.key, event.currentTarget.value) };
    return <div key={field.key}><label htmlFor={fieldId} className="font-medium">{field.label ?? field.key}{field.unit ? ` (${field.unit})` : ''}{field.required ? ' *' : ''}</label>
      {field.inputType === 'textarea' ? <textarea {...inputProps} rows={3} /> : <input {...inputProps} type={field.inputType} min={field.min} max={field.max} step={field.step} />}
      {field.inputType === 'range' && <output htmlFor={fieldId}>{String(value ?? '')}</output>}
    </div>;
  };
  const selectedTab = shown.type === 'tabs' ? shown.tabs.find(tab => tab.key === view.state.controls.tab) ?? shown.tabs[0] : undefined;
  const Surface = shown.type === 'embed' ? 'div' : 'form';
  return <Surface ref={(element: HTMLDivElement | HTMLFormElement | null) => { surface.current = element; }} onSubmit={event => event.preventDefault()} data-conversation-ui-fragment={props.sourceKey} className="my-3 min-w-0 space-y-3 text-foreground" aria-label={shown.label}
    onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused.current = false; setShown(props.node); } }}>
    {shown !== props.node && <p role="status" className="text-sm text-muted-foreground">{t('ui.fragment.updated')} <button type="button" className={buttonClass} onClick={() => { focused.current = false; setShown(props.node); }}>{t('ui.fragment.applyUpdate')}</button></p>}
    {shown.type === 'form' && shown.label && <p className="font-medium">{shown.label}</p>}
    {fields.map(renderField)}
    {shown.type === 'disclosure' && <details open={view.state.controls.open === true} onToggle={event => { if (event.currentTarget.open !== (view.state.controls.open === true)) view.setControl('open', event.currentTarget.open); }}>
      <summary className="cursor-pointer font-medium">{shown.label ?? t('ui.fragment.details')}</summary><SimpleMarkdownRenderer content={shown.content} variant="tool" />
    </details>}
    {shown.type === 'tabs' && <div><div role="tablist" aria-label={shown.label} className="flex flex-wrap gap-2">{shown.tabs.map(tab => <button type="button" key={tab.key} role="tab" id={`${id}:tab:${tab.key}`} aria-controls={`${id}:panel`} aria-selected={selectedTab?.key === tab.key} tabIndex={selectedTab?.key === tab.key ? 0 : -1}
      className={buttonClass} onClick={() => view.setControl('tab', tab.key)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
        const index = shown.tabs.findIndex(item => item.key === tab.key), next = event.key === 'Home' ? 0 : event.key === 'End' ? shown.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + shown.tabs.length) % shown.tabs.length;
        view.setControl('tab', shown.tabs[next]!.key); document.getElementById(`${id}:tab:${shown.tabs[next]!.key}`)?.focus();
      }}>{tab.label}</button>)}</div>
      {selectedTab && <div role="tabpanel" id={`${id}:panel`} aria-labelledby={`${id}:tab:${selectedTab.key}`}><SimpleMarkdownRenderer content={selectedTab.content} variant="tool" /></div>}
    </div>}
    {shown.type === 'embed' && <EmbeddedUiContent refValue={shown.ref} sourceKey={props.sourceKey} />}
    {shown.type === 'object' && <NativeObjectContent refValue={shown.ref} />}
    {action && <div className="space-y-2">
      {action.type === 'send' && <details><summary className="cursor-pointer text-sm">{t('ui.fragment.preview')}</summary><p className="whitespace-pre-wrap text-sm">{pendingText ?? text}</p></details>}
      <button type="button" className={buttonClass} disabled={busy || action.type === 'send' && sentText === text} onClick={() => void run()}>{action.type === 'send' ? `${t('ui.fragment.send')} · ${action.label}` : action.label}</button>
      {(action.type === 'compose' || action.type === 'reference') && <span className="ml-2 text-xs text-muted-foreground">{t('ui.fragment.draftHint')}</span>}
    </div>}
    {view.resetKeys.length > 0 && <p role="status" className="text-sm text-muted-foreground">{t('ui.fragment.reselect')}: {view.resetKeys.map(key => fields.find(field => field.key === key)?.label ?? key).join(', ')}</p>}
    {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    {view.error && <p role="alert" className="text-sm text-destructive">{t('ui.fragment.unsaved')}: {view.error} <button type="button" className={buttonClass} onClick={view.retry}>{t('ui.fragment.retry')}</button></p>}
  </Surface>;
}, (before, after) => before.node === after.node && before.sourceKey === after.sourceKey
  && before.source === after.source && before.isStreaming === after.isStreaming
  && before.fragment?.messageId === after.fragment?.messageId && before.fragment?.fragmentKey === after.fragment?.fragmentKey
  && before.fragment?.contentIndex === after.fragment?.contentIndex && before.fragment?.contentVersion === after.fragment?.contentVersion);
