import React from 'react';
import { createResourceManagementHttpAPI, getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { resolveAutocompleteTrigger } from '@/components/chat/composer/language/triggers';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { normalizePath } from '@/lib/pathNormalization';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type Suggestion = { id: string; label: string; detail?: string; insert: string; path?: string };

/** Suggestions use the selected source and resource catalog. Selecting a file inserts
 * a path reference; it neither reads file contents nor grants filesystem access. */
export function useThreadAutocomplete({ value, editor, workspacePath, skills }: {
  value: string; editor: React.RefObject<ComposerEditorHandle | null>; workspacePath?: string; skills: string[];
}) {
  const { t } = useI18n();
  const [caret, setCaret] = React.useState(value.length);
  const [dismissed, setDismissed] = React.useState('');
  const [confirmed, setConfirmed] = React.useState<Set<string>>(() => new Set());
  const [rows, setRows] = React.useState<Suggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  const projects = useProjectsStore(state => state.projects);
  const projectId = projects.find(project => normalizePath(project.path) === normalizePath(workspacePath))?.id;
  const signature = JSON.stringify([value, caret]);
  const resolved = signature === dismissed ? null : resolveAutocompleteTrigger(value, caret, { inputMode: 'normal' });
  // The Host supports one leading explicit skill command. Inline slashes remain prose.
  const kind = resolved?.kind === 'command' ? 'skill' : resolved?.kind === 'mention' && workspacePath ? 'file' : undefined;
  const query = kind === 'skill' ? resolved!.query.replace(/^skill:/, '') : resolved?.query ?? '';
  const skillKey = JSON.stringify(skills);
  React.useEffect(() => {
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setRows([]); setSelected(0); setError(''); setLoading(Boolean(kind));
    if (!kind) return () => controller.abort();
    const current = () => !controller.signal.aborted && host === getRuntimeEndpointGeneration();
    const read = async () => {
      let next: Suggestion[];
      if (kind === 'file') {
        const files = await useFileSearchStore.getState().searchFiles(workspacePath!, query);
        next = files.map(file => ({ id: file.path, label: file.name, detail: file.relativePath, path: file.relativePath,
          insert: /\s/.test(file.relativePath) ? `\`${file.path}\` ` : `@${file.relativePath} ` }));
      } else {
        const names: string[] = JSON.parse(skillKey);
        const available = names.length ? names.map(name => ({ name, description: '' }))
          : (await createResourceManagementHttpAPI(host).list(projectId ? { projectId } : {}, controller.signal)).resources.filter(skill => skill.active && skill.valid);
        next = available.filter(skill => skill.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map(skill => ({ id: skill.name, label: skill.name, detail: skill.description, insert: `/skill:${skill.name} ` }));
      }
      if (current()) setRows(next);
    };
    void read().catch(cause => { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [kind, query, workspacePath, projectId, skillKey]);
  const choose = (row: Suggestion) => {
    const control = editor.current;
    if (!control || !kind) return;
    const start = kind === 'skill' ? 0 : value.lastIndexOf('@', caret - 1);
    control.replaceRange(start, caret, row.insert);
    if (row.path) setConfirmed(previous => new Set([...previous, row.path!]));
    setDismissed(JSON.stringify([control.getValue(), control.getSelection().end]));
    control.focus();
  };
  const close = () => setDismissed(signature);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!kind || event.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Escape') { event.preventDefault(); close(); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (rows.length) setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length); return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && rows.length) {
      event.preventDefault(); choose(rows[selected] ?? rows[0]!); return true;
    }
    return false;
  };
  const popup = kind ? <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg" role="listbox">
    {loading ? <p className="p-2 typography-meta text-muted-foreground">{t('common.loading')}</p>
      : error ? <p role="alert" className="p-2 typography-meta text-destructive">{error}</p>
      : !rows.length ? <p className="p-2 typography-meta text-muted-foreground">{t('chat.fileMentionAutocomplete.empty')}</p>
      : rows.map((row, index) => <button key={row.id} type="button" role="option" aria-selected={index === selected}
        ref={element => { if (index === selected) element?.scrollIntoView({ block: 'nearest' }); }}
        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left typography-meta hover:bg-interactive-hover', index === selected && 'bg-interactive-selection')}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(row)}>
        <Icon name={kind === 'file' ? 'file-code' : 'book-open'} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0"><span className="block truncate">{row.label}</span>{row.detail && <span className="block truncate typography-micro text-muted-foreground">{row.detail}</span>}</span>
      </button>)}
  </div> : null;
  return { popup, onKeyDown, setCaret, close, confirmed };
}
