import React from 'react';
import { DEFAULT_LOCAL_STT_MODEL, getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged,
    type LocalSttModelStatus } from '@varin/application-client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Radio } from '@/components/ui/radio';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { speechLanguageLabel } from '@/lib/voice/speech-language';

const languageKey = (code: string) => {
    const base = code.toLowerCase().split('-')[0]!;
    return base === 'tl' ? 'fil' : base === 'jw' ? 'jv' : base;
};

export function LocalSttModelPicker({ selectedModelId, onSelect, language = '', onLanguageChange }: {
    selectedModelId: string;
    onSelect: (id: string, language: string) => void;
    language?: string;
    onLanguageChange?: (language: string) => void;
}) {
    const { t, locale } = useI18n();
    const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
    const [models, setModels] = React.useState<LocalSttModelStatus[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [pending, setPending] = React.useState(new Set<string>());
    const [spokenLanguage, setSpokenLanguage] = React.useState(language);
    const wanted = React.useRef<{ id: string; language: string } | null>(null);
    const alive = React.useRef(false);
    const requestSequence = React.useRef(0);
    const inFlight = React.useRef<{ generation: number; promise: Promise<void> } | null>(null);
    const names = React.useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
    const refresh = React.useCallback(() => {
        if (inFlight.current?.generation === generation) return inFlight.current.promise;
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
                if (sequence !== requestSequence.current || getRuntimeEndpointGeneration() !== generation) return;
                setModels(data.models);
                setError(null);
            } catch (failure) {
                if (sequence === requestSequence.current && getRuntimeEndpointGeneration() === generation) {
                    setError(failure instanceof Error ? failure.message : String(failure));
                }
            } finally {
                if (sequence === requestSequence.current && getRuntimeEndpointGeneration() === generation) setLoading(false);
            }
        })().finally(() => { if (inFlight.current?.promise === task) inFlight.current = null; });
        inFlight.current = { generation, promise: task };
        return task;
    }, [generation]);
    React.useEffect(() => {
        alive.current = true; wanted.current = null; setModels([]);
        setLoading(true);
        setPending(new Set());
        void refresh();
        return () => {
            alive.current = false; wanted.current = null; requestSequence.current += 1;
            if (inFlight.current?.generation === generation) inFlight.current = null;
        };
    }, [refresh, generation]);
    const downloading = models.some(model => model.downloading);
    React.useEffect(() => {
        if (!downloading) return;
        const timer = setInterval(() => { void refresh(); }, 2000);
        return () => clearInterval(timer);
    }, [downloading, refresh]);
    React.useEffect(() => {
        if (getRuntimeEndpointGeneration() !== generation || !wanted.current) return;
        const intent = wanted.current;
        const candidate = models.find(model => model.id === intent.id);
        if (candidate?.installed) { wanted.current = null; onSelect(candidate.id, candidate.supportsLanguageSelection ? intent.language : ''); }
        else if (candidate?.downloadError) wanted.current = null;
    }, [models, generation, onSelect]);
    const preferred = languageKey(spokenLanguage);
    const fits = (model: LocalSttModelStatus) => !preferred || model.languages.some(code => languageKey(code) === preferred);
    const languages = [...new Set(models.flatMap(model => model.languages.map(languageKey)))].sort((a,b) => speechLanguageLabel(names,a).localeCompare(speechLanguageLabel(names,b), locale));

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
            if (alive.current && getRuntimeEndpointGeneration() === generation) {
                // An earlier status response may predate this mutation.
                await inFlight.current?.promise;
                if (alive.current && getRuntimeEndpointGeneration() === generation) await refresh();
            }
        } catch (failure) {
            if (alive.current && getRuntimeEndpointGeneration() === generation) { if (wanted.current?.id === id) wanted.current = null; setError(failure instanceof Error ? failure.message : String(failure)); }
        } finally {
            if (alive.current && getRuntimeEndpointGeneration() === generation) setPending(current => { const next = new Set(current); next.delete(id); return next; });
        }
    };

    const choose = (model: LocalSttModelStatus) => {
        if (!fits(model)) return;
        if (model.installed) { wanted.current = null; onSelect(model.id, model.supportsLanguageSelection ? preferred : ''); return; }
        if (wanted.current?.id === model.id && (pending.has(model.id) || model.downloading)) return;
        wanted.current = { id: model.id, language: preferred };
        if (!model.downloading && !pending.has(model.id)) void manage(model.id, 'download');
    };

    return <div className="space-y-2">
        {onLanguageChange && <label className="flex flex-wrap items-center justify-between gap-2 py-2 typography-settings-field-label">{t('settings.voice.mainLanguage')}
            <Select value={preferred || 'auto'} onValueChange={value => { wanted.current = null;
                    const next = value === 'auto' ? '' : value; setSpokenLanguage(next);
                    const current = models.find(model => model.id === selectedModelId);
                    // Filtering must not break the current recognizer while another model downloads.
                    if (current?.supportsLanguageSelection && (!next || current.languages.some(code => languageKey(code) === next))) onLanguageChange(next); }}>
                <SelectTrigger size="settings" aria-label={t('settings.voice.mainLanguage')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="auto">{t('settings.voice.page.stt.autoLanguage')}</SelectItem>
                    {preferred && !languages.includes(preferred) && <SelectItem value={preferred} disabled>{speechLanguageLabel(names,preferred)}</SelectItem>}
                    {languages.map(code => <SelectItem key={code} value={code}>{speechLanguageLabel(names,code)}</SelectItem>)}
                </SelectContent>
            </Select></label>}
        <p className="typography-micro text-muted-foreground">{t('settings.voice.chooseHint')}</p>
        {loading ? <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" /> : null}
        {error ? <div className="flex items-center gap-2 typography-meta">
            <span role="alert" className="text-destructive">{error}</span>
            <Button size="xs" variant="ghost" onClick={() => void refresh()}>{t('settings.voice.page.stt.modelRetry')}</Button>
        </div> : null}
        <div role="radiogroup" aria-label={t('settings.voice.page.field.model')} className="grid w-full grid-cols-1 gap-3 @xl:grid-cols-2">
            {[...models].sort((a,b) => Number(fits(b)) - Number(fits(a))).map(model => {
                const selected = selectedModelId === model.id;
                const languages = model.languages.map(code => speechLanguageLabel(names, code)).join(' · ');
                return <div key={model.id} className={cn('rounded-lg border border-[var(--interactive-border)] p-3 transition-colors',
                    !fits(model) && 'opacity-60', selected && 'border-[var(--primary-base)] bg-[var(--primary-base)]/5')}>
                    <div className="flex items-start gap-2">
                        <Radio checked={selected} disabled={!fits(model)} onChange={() => choose(model)} ariaLabel={model.name} />
                        <button type="button" className="min-w-0 flex-1 space-y-1.5 text-left" disabled={!fits(model)} onClick={() => choose(model)}>
                            <span className="flex flex-wrap items-center gap-2 typography-ui-label">
                                {model.name}
                                {model.id === DEFAULT_LOCAL_STT_MODEL ? <span className="rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">
                                    {t('settings.voice.page.stt.defaultModel')}
                                </span> : null}
                            </span>
                            <span className="block typography-meta text-muted-foreground" title={languages}>
                                {model.languages.length <= 5 ? languages : t('settings.voice.page.stt.languageCount', { count: model.languages.length })}
                            </span>
                            {!fits(model) && <span className="block typography-micro">{t('settings.voice.unsupported')}</span>}
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
                            </span> : null}
                        </div>
                    </div>
                    {model.downloadError ? <p role="alert" className="mt-2 typography-meta text-destructive">{model.downloadError}</p> : null}
                </div>;
            })}
        </div>
    </div>;
}
