import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import type { EditorViewState } from '@/lib/workbench/editors/types';

export function DiffLayoutControl({ value = 'auto', onChange }: {
  value?: EditorViewState['diffLayout'];
  onChange(value: NonNullable<EditorViewState['diffLayout']>): void;
}) {
  const { t } = useI18n();
  const label = (mode: NonNullable<EditorViewState['diffLayout']>) => t(mode === 'auto'
    ? 'workbench.editor.diffAuto' : mode === 'inline' ? 'workbench.editor.diffInline' : 'workbench.editor.diffSplit');
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <button type="button" className="workbench-icon-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        aria-label={`${t('workbench.editor.diffLayout')}: ${label(value)}`} title={`${t('workbench.editor.diffLayout')}: ${label(value)}`}>
        <Icon name={value === 'inline' ? 'file-code' : 'layout-column'} className="size-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {(['auto', 'inline', 'split'] as const).map(mode => <DropdownMenuItem key={mode} onSelect={() => onChange(mode)}>
        <span className="flex-1">{label(mode)}</span>{value === mode ? <Icon name="check" className="size-3.5" /> : null}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
