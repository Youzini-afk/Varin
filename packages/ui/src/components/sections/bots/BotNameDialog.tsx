import React from 'react';
import { BOT_FIGURE_PRESETS, defaultBotAppearance, type BotAppearance } from '@varin/application-client';
import { RiShuffleLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BotFigure } from '@/workbenches/bot/BotFigure';

const CHARACTERS = ['varin', ...BOT_FIGURE_PRESETS] as const;
type Character = typeof CHARACTERS[number];
type AppearanceChoice = 'random' | Character;

const characterAppearance = (character: Character): BotAppearance =>
  character === 'varin' ? defaultBotAppearance() : { kind: 'preset', character, color: 'original' };

function CharacterOption({ character }: { character: AppearanceChoice }) {
  const { t } = useI18n();
  const label = character === 'random' ? t('bot.appearance.random') : t(`bot.appearance.character.${character}`);
  return <span className="inline-flex min-w-0 items-center gap-2">
    {character === 'random'
      ? <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><RiShuffleLine className="size-4" aria-hidden="true" /></span>
      : <BotFigure appearance={characterAppearance(character)} state="idle" size={24} still />}
    <span className="truncate">{label}</span>
  </span>;
}

interface BotNameDialogProps {
  mode: 'create' | 'rename';
  open: boolean;
  title: string;
  submitLabel?: string;
  name: string;
  busy?: boolean;
  error?: string | null;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, appearance?: BotAppearance) => void;
}

export const BotNameDialog: React.FC<BotNameDialogProps> = ({
  open,
  mode,
  title,
  submitLabel,
  name,
  busy = false,
  error,
  onNameChange,
  onOpenChange,
  onSubmit,
}) => {
  const { t } = useI18n();
  const [character, setCharacter] = React.useState<AppearanceChoice>('random');
  const drawnCharacter = React.useRef<Character | undefined>(undefined);
  const appearanceLabelId = React.useId();
  const creating = mode === 'create';
  React.useEffect(() => {
    if (!open) {
      setCharacter('random');
      drawnCharacter.current = undefined;
    }
  }, [open]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!creating) {
      if (trimmed) onSubmit(trimmed);
      return;
    }
    const selected = character === 'random'
      ? drawnCharacter.current ??= CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)]!
      : character;
    onSubmit(trimmed || t(`bot.appearance.character.${selected}`), characterAppearance(selected));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-2">
            <span className="typography-ui-label font-medium">{t('settings.bots.name.label')}</span>
            <Input
              autoFocus
              required={!creating}
              value={name}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={creating ? t('bot.appearance.createNamePlaceholder') : t('settings.bots.name.placeholder')}
            />
          </label>
          {creating && <div className="flex flex-col gap-2">
            <span id={appearanceLabelId} className="typography-ui-label font-medium">{t('bot.appearance.title')}</span>
            <Select<AppearanceChoice> value={character} onValueChange={setCharacter} disabled={busy}>
              <SelectTrigger aria-labelledby={appearanceLabelId} size="settings" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent portalToBody align="start" className="flex max-h-[min(18rem,var(--available-height))] flex-col">
                <SelectItem value="random"><CharacterOption character="random" /></SelectItem>
                {CHARACTERS.map(id => <SelectItem key={id} value={id}><CharacterOption character={id} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>}
          {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="submit" className="min-w-20" disabled={busy || (!creating && !name.trim())}>
              {submitLabel ?? t('settings.bots.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
