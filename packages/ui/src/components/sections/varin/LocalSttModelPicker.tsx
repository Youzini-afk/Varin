import React from 'react';
import { DEFAULT_LOCAL_STT_MODEL, getRuntimeKey, runtimeFetch, subscribeRuntimeEndpointChanged,
    type LocalSttModelStatus } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Radio } from '@/components/ui/radio';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { speechLanguageLabel } from '@/lib/voice/speech-language';

export function LocalSttModelPicker({ selectedModelId, onSelect, onSelectionInfo }: {
    selectedModelId: string;
    onSelect: (id: string) => void;
    onSelectionInfo: (model: LocalSttModelStatus | undefined) => void;
}) {
    const { t, locale } = useI18n();
    const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
    const [models, setModels] = React.useState<LocalSttModelStatus[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [pending, setPending] = React.useState(new Set<string>());
    const requestSequence = React.useRef(0);
    const inFlight = React.useRef<{ runtimeKey: string; promise: Promise<void> } | null>(null);
    const names = React.useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
    const refresh = React.useCallback(() => {
        if (inFlight.current?.runtimeKey === runtimeKey) return inFlight.current.promise;
        const sequence = ++requestSequence.current;
        const task = (async () => {
            try {
                const response = await runtimeFetch('/api/dictation/status', { query: { provider: 'local' } });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json() as { models: LocalSttModelStatus[] };
                if (!Array.isArray(data.models) || !data.models.every(model => model && typeof model.id === 'string'
                    && typeof model.name === 'string' && Array.isArray(model.languages)
                    && model.languages.every(code => typeof code === 'string')
                    && typeof model.supportsLanguageSelection === 'boolean'
                    && typeof model.downloadBytes === 'number' && Number.isFinite(model.downloadBytes))) {
                    throw new Error('Invalid speech model catalog');
                }
                if (sequence !== requestSequence.current || getRuntimeKey() !== runtimeKey) return;
                setModels(data.models);
                setError(null);
            } catch (failure) {
                if (sequence === requestSequence.current && getRuntimeKey() === runtimeKey) {
                    setError(failure instanceof Error ? failure.message : String(failure));
                }
            } finally {
                if (sequence === requestSequence.current && getRuntimeKey() === runtimeKey) setLoading(false);
            }
        })().finally(() => { if (inFlight.current?.promise === task) inFlight.current = null; });
        inFlight.current = { runtimeKey, promise: task };
        return task;
    }, [runtimeKey]);
    React.useEffect(() => {
        setModels([]);
        setLoading(true);
        setPending(new Set());
        void refresh();
        return () => {
            requestSequence.current += 1;
            if (inFlight.current?.runtimeKey === runtimeKey) inFlight.current = null;
        };
    }, [refresh, runtimeKey]);
    const downloading = models.some(model => model.downloading);
    React.useEffect(() => {
        if (!downloading) return;
        const timer = setInterval(() => { void refresh(); }, 2000);
        return () => clearInterval(timer);
    }, [downloading, refresh]);
    React.useEffect(() => {
        onSelectionInfo(models.find(model => model.id === selectedModelId));
    }, [models, selectedModelId, onSelectionInfo]);

    const manage = async (id: string, action: 'download' | 'delete') => {
        setPending(current => new Set([...current, id]));
        setError(null);
        try {
            const url = `/api/dictation/models/${encodeURIComponent(id)}${action === 'download' ? '/download' : ''}`;
            const response = await runtimeFetch(url, { method: action === 'download' ? 'POST' : 'DELETE' });
            if (!response.ok) {
                const data = await response.json() as { error?: string };
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            if (getRuntimeKey() === runtimeKey) {
                // An earlier status response may predate this mutation.
                await inFlight.current?.promise;
                if (getRuntimeKey() === runtimeKey) await refresh();
            }
        } catch (failure) {
            if (getRuntimeKey() === runtimeKey) setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            if (getRuntimeKey() === runtimeKey) setPending(current => { const next = new Set(current); next.delete(id); return next; });
        }
    };

    return <div className="space-y-2">
        {loading ? <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" /> : null}
        {error ? <div className="flex items-center gap-2 typography-meta">
            <span role="alert" className="text-destructive">{error}</span>
            <Button size="xs" variant="ghost" onClick={() => void refresh()}>{t('settings.voice.page.stt.modelRetry')}</Button>
        </div> : null}
        <div role="radiogroup" aria-label={t('settings.voice.page.field.model')} className="grid w-full grid-cols-1 gap-3 @xl:grid-cols-2">
            {models.map(model => {
                const selected = selectedModelId === model.id;
                const languages = model.languages.map(code => speechLanguageLabel(names, code)).join(' · ');
                return <div key={model.id} className={cn('rounded-lg border border-[var(--interactive-border)] p-3 transition-colors',
                    selected && 'border-[var(--primary-base)] bg-[var(--primary-base)]/5')}>
                    <div className="flex items-start gap-2">
                        <Radio checked={selected} onChange={() => onSelect(model.id)} ariaLabel={model.name} />
                        <button type="button" className="min-w-0 flex-1 space-y-1.5 text-left" onClick={() => onSelect(model.id)}>
                            <span className="flex flex-wrap items-center gap-2 typography-ui-label">
                                {model.name}
                                {model.id === DEFAULT_LOCAL_STT_MODEL ? <span className="rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">
                                    {t('settings.voice.page.stt.defaultModel')}
                                </span> : null}
                            </span>
                            <span className="block typography-meta text-muted-foreground" title={languages}>
                                {model.languages.length <= 5 ? languages : t('settings.voice.page.stt.languageCount', { count: model.languages.length })}
                            </span>
                            <span className="block typography-meta tabular-nums text-muted-foreground">
                                {t('settings.voice.page.stt.downloadSize', { size: `${Math.ceil(model.downloadBytes / 1_000_000)} MB` })}
                            </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
                            {model.installed ? <>
                                <Icon name="checkbox-circle" className="size-4 text-[var(--status-success)]" aria-label={t('settings.voice.page.stt.modelInstalled')} />
                                <Button size="xs" variant="ghost" disabled={pending.has(model.id)} className="size-6 p-0"
                                    onClick={() => void manage(model.id, 'delete')} aria-label={t('settings.voice.page.stt.modelDelete')} title={t('settings.voice.page.stt.modelDelete')}>
                                    <Icon name="delete-bin" className="size-4" />
                                </Button>
                            </> : model.downloading || pending.has(model.id) ? <span className="flex items-center gap-1 typography-meta tabular-nums text-muted-foreground">
                                <Icon name="loader-4" className="size-4 animate-spin" />
                                {model.downloadProgress !== null ? `${model.downloadProgress}%` : ''}
                            </span> : <Button size="xs" variant="ghost" className="size-6 p-0" onClick={() => void manage(model.id, 'download')}
                                aria-label={t('settings.voice.page.stt.modelDownload')} title={t('settings.voice.page.stt.modelDownload')}>
                                <Icon name="download" className="size-4" />
                            </Button>}
                        </div>
                    </div>
                    {model.downloadError ? <p role="alert" className="mt-2 typography-meta text-destructive">{model.downloadError}</p> : null}
                </div>;
            })}
        </div>
    </div>;
}
