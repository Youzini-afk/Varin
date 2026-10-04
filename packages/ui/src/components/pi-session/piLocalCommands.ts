import { parseSlashCommand } from '@/lib/pi-session/slashCommands';

export type PiLocalCommand = {
  kind: 'tree';
  query: string;
} | {
  customInstructions?: string;
  kind: 'compact';
};

export const parsePiLocalCommand = (text: string): PiLocalCommand | null => {
  const command = parseSlashCommand(text);
  if (command?.name === 'tree') return { kind: 'tree', query: command.argument };
  if (command?.name === 'compact') {
    return command.argument.length > 0
      ? { customInstructions: command.argument, kind: 'compact' }
      : { kind: 'compact' };
  }
  return null;
};
