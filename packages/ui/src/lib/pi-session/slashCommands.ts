export interface ParsedSlashCommand { name: string; argument: string }
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!.toLowerCase(), argument: match[2]?.trim() ?? '' } : null;
}
