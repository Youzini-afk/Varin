import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { Input } from '@/components/ui/input';
import { ThreadMaterialLinks } from './ThreadMaterials';
import type { OutputBody, OutputMediaHolder, StoredMedia } from '@varin/protocol';
import { getRuntimeEndpointGeneration, readThreadMedia, ThreadRequestError, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

type Reader = Pick<ThreadsAPI, 'mediaRead'>;
type Scope = { api: Reader; identity: ThreadIdentity; holder: OutputMediaHolder };

/** Only an explicit typed part reaches the byte reader. The holder supplies authority. */
export function ThreadMedia(props: Scope & { media: StoredMedia; partIndex: number; thumbnail?: boolean; imageReference?: number }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const key = JSON.stringify([host, props.identity, props.holder, props.partIndex, props.media]);
  return <MediaView key={key} {...props} host={host} />;
}
function MediaView({ api, identity, holder, media, partIndex, host, thumbnail = false, imageReference }: Scope & { media: StoredMedia; partIndex: number; host: number; thumbnail?: boolean; imageReference?: number }) {
  const { t } = useI18n();
  const figure = React.useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const runtime = React.useContext(RuntimeAPIContext);
  const [saveDirectory, setSaveDirectory] = React.useState('');
  const [saveName, setSaveName] = React.useState(`image-${partIndex}.${media.media_type === 'image/jpeg' ? 'jpg' : media.media_type.split('/')[1] || 'bin'}`);
  const [saving, setSaving] = React.useState(false);
  const [savedPath, setSavedPath] = React.useState<string>();
  const [saveError, setSaveError] = React.useState<string>();
  const savingRef = React.useRef(false);
  const loaded = React.useRef<Blob | null>(null);
  const [url, setUrl] = React.useState<string>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [displayFailed, setDisplayFailed] = React.useState(false);
  const pending = React.useRef<AbortController | null>(null);
  const objectUrl = React.useRef<string | undefined>(undefined);
  const clear = React.useCallback(() => {
    pending.current?.abort(); pending.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = undefined; loaded.current = null;
  }, []);
  React.useEffect(() => clear, [clear]);
  const image = media.media_type.startsWith('image/');
  const load = React.useCallback(async () => {
    clear();
    const controller = new AbortController(); pending.current = controller;
    setUrl(undefined); setError(undefined); setDisplayFailed(false); setLoading(true);
    try {
      const bytes = await readThreadMedia(api, { ...identity, holder, partIndex }, media, controller.signal);
      if (controller.signal.aborted || pending.current !== controller || host !== getRuntimeEndpointGeneration()) return;
      const blob = new Blob([bytes], { type: media.media_type });
      const next = URL.createObjectURL(blob); loaded.current = blob;
      objectUrl.current = next; setUrl(next);
    } catch (value) {
      if (!controller.signal.aborted && pending.current === controller && host === getRuntimeEndpointGeneration()) {
        setError(value instanceof ThreadRequestError ? value.status === 404 ? 'The original media is missing.'
          : value.status === 403 ? 'Access to the original media is unavailable.'
          : value.status === 409 ? 'The original media holder changed. Refresh the conversation before retrying.'
          : `Could not read original media (${value.code}).`
          : value instanceof Error ? value.message : 'Could not read original media.');
      }
    } finally {
      if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [api, identity, holder, partIndex, media, host, clear]);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    const element = figure.current;
    if (!image || !element) return;
    if (typeof IntersectionObserver === 'undefined') { if (thumbnail) void loadRef.current(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void loadRef.current(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [image, thumbnail]);
  const save = async () => {
    if (!runtime?.workspace || !loaded.current || savingRef.current || host !== getRuntimeEndpointGeneration()) return;
    if (!saveName.trim() || /[/\\]/.test(saveName) || saveName === '.' || saveName === '..') { setSaveError('Enter a file name without a directory.'); return; }
    const destination = saveDirectory.trim();
    const file = new File([loaded.current], saveName, { type: media.media_type });
    savingRef.current = true; setSaving(true); setSaveError(undefined); setSavedPath(undefined);
    try {
      // The selected Host's existing upload/file owner handles writes and recovery.
      // This operation never calls the image provider or changes its retained resource.
      const result = await runtime.workspace.upload(destination, [file]);
      if (host !== getRuntimeEndpointGeneration()) return;
      const entry = result.entries.find(value => value.type === 'file');
      if (!result.success || !entry?.path) throw new Error('The file service did not confirm an image save.');
      setSavedPath(entry.path);
    } catch (error) {
      if (host === getRuntimeEndpointGeneration()) setSaveError(error instanceof Error ? error.message : 'Image save failed. The original image is still available.');
    } finally { savingRef.current = false; setSaving(false); }
  };
  const actions = <>
    {url && <div className="flex items-center gap-3 typography-micro text-muted-foreground">
      <a href={url} download={saveName} className="inline-flex items-center gap-1 hover:text-foreground"><Icon name="download" className="size-3.5" />{t('chat.media.download')}</a>
      <button type="button" className="hover:text-foreground" onClick={() => { setExpanded(false); clear(); setUrl(undefined); }}>{t('chat.media.close')}</button>
    </div>}
    {url && image && runtime?.workspace && <details className="typography-meta text-muted-foreground"><summary className="cursor-pointer">{t('chat.media.saveToProject')}</summary>
      <div className="my-2 flex flex-wrap gap-2">
        <Input aria-label={t('chat.media.folder')} placeholder={t('chat.media.folder')} value={saveDirectory} disabled={saving} onChange={event => setSaveDirectory(event.target.value)} />
        <Input aria-label={t('chat.media.filename')} value={saveName} disabled={saving} onChange={event => setSaveName(event.target.value)} />
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void save()}>{t(saving ? 'chat.media.saving' : 'chat.media.save')}</Button>
      </div>
      {savedPath && <p role="status">{t('chat.media.saved', { path: savedPath })}</p>}
      {saveError && <p role="alert">{saveError}</p>}
    </details>}
  </>;
  return <figure ref={figure} className={thumbnail ? "tool-viewed-image-media" : "my-2 max-w-full space-y-2"} aria-label="Stored media">
    {imageReference !== undefined && <figcaption className="typography-micro text-muted-foreground">{t('chat.imageReference.token', { number: imageReference })}</figcaption>}
    {!image && <figcaption className="typography-meta text-muted-foreground">{media.media_type}</figcaption>}
    {error && <p role="alert" className={thumbnail ? "sr-only" : "typography-meta text-destructive"}>{error}</p>}
    {url && image && !displayFailed && <button type="button" className={thumbnail ? "tool-viewed-image" : "block max-w-full overflow-hidden rounded-lg border border-border/70 bg-background"} onClick={() => setExpanded(true)} aria-label={t('chat.media.view')}>
      <img src={url} alt={t('chat.media.image')} className={thumbnail ? "h-full w-full object-contain" : "max-h-[32rem] max-w-full object-contain"} decoding="async" onError={() => {
        setDisplayFailed(true); setError('The browser could not display this image.');
      }} />
    </button>}
    {!thumbnail && actions}
    {(!url || displayFailed) && !loading && <Button type="button" variant="ghost" size="sm" title={error} onClick={() => void load()}>{t(error ? 'chat.media.retry' : image ? 'chat.media.view' : 'chat.media.read')}</Button>}
    {loading && <span role="status" className="inline-flex items-center gap-2 typography-meta text-muted-foreground"><Icon name="loader-4" className="size-3.5 animate-spin" />{t('chat.media.loading')}</span>}
    {url && image && <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-w-[90vw] p-2"><DialogTitle className="sr-only">{t('chat.media.image')}</DialogTitle><img src={url} alt={t('chat.media.image')} className={thumbnail ? "max-h-[75vh] w-full object-contain" : "max-h-[85vh] w-full object-contain"} />{thumbnail && <div className="px-2 pb-2">{actions}</div>}</DialogContent></Dialog>}
  </figure>;
}

export function ThreadOutput({ api, identity, holder, output, messageId }: Scope & { output: OutputBody; messageId: string }) {
  return <div aria-label="Typed output">
    <ThreadMaterialLinks data={output.data} />
    {output.parts.map((part, index) => part.kind === 'text'
      ? <MarkdownRenderer key={index} messageId={`${messageId}:${index}`} content={part.text} />
      : <ThreadMedia key={index} api={api} identity={identity} holder={holder} media={part.media} partIndex={index} />)}
    <details><summary>Output data</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(output.data, null, 2)}</pre></details>
  </div>;
}
