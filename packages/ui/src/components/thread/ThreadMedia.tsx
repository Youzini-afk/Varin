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
export function ThreadMedia(props: Scope & { media: StoredMedia; partIndex: number }) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const key = JSON.stringify([host, props.identity, props.holder, props.partIndex, props.media]);
  return <MediaView key={key} {...props} host={host} />;
}
function MediaView({ api, identity, holder, media, partIndex, host }: Scope & { media: StoredMedia; partIndex: number; host: number }) {
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
  const load = async () => {
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
  };
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
  return <figure className="my-2 space-y-1 rounded border p-2" aria-label="Stored media">
    <figcaption className="text-xs text-muted-foreground">{media.media_type}</figcaption>
    {!image && <p>This view cannot display {media.media_type}. You can download the original file.</p>}
    {error && <p role="alert">Media unavailable. {error} Refresh the conversation if it changed, or retry this read.</p>}
    {url && image && !displayFailed && <img src={url} alt="Conversation image" className="max-h-96 max-w-full rounded" onError={() => {
      setDisplayFailed(true); setError('The browser could not display these image bytes. Download the original file to inspect it.');
    }} />}
    {url && <a href={url} download={saveName}>Download original</a>}
    {url && image && runtime?.workspace && <details><summary>Save image to project</summary>
      <div className="my-2 flex flex-wrap gap-2">
        <Input aria-label="Destination folder relative to workspace" placeholder="Project folder relative to workspace" value={saveDirectory} disabled={saving} onChange={event => setSaveDirectory(event.target.value)} />
        <Input aria-label="Image file name" value={saveName} disabled={saving} onChange={event => setSaveName(event.target.value)} />
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void save()}>{saving ? 'Saving image…' : 'Save image'}</Button>
      </div>
      {savedPath && <p role="status">Image saved to {savedPath}</p>}
      {saveError && <p role="alert">{saveError} The original image is still available.</p>}
    </details>}
    {!url && !loading && <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{error ? 'Retry media' : image ? 'View image' : 'Read original media'}</Button>}
    {loading && <><span role="status">Reading media…</span><Button type="button" variant="ghost" size="sm" onClick={() => { clear(); setLoading(false); }}>Cancel media read</Button></>}
    {url && <Button type="button" variant="ghost" size="sm" onClick={() => { clear(); setUrl(undefined); }}>Close media</Button>}
    <details className="text-xs text-muted-foreground"><summary>Media source</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(media.source, null, 2)}</pre></details>
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
