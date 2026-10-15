import { saveDesktopMarkdownFile } from '@/lib/desktop';

export const downloadAsMarkdown = (content: string, filename: string): void => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

export const saveAsMarkdownDesktop = async (
  content: string,
  filename: string,
): Promise<string | null> => {
  const desktopPath = await saveDesktopMarkdownFile(filename, content);
  return desktopPath || null;
};

export const buildExportFilename = (sessionTitle?: string | null): string => {
  const base = sessionTitle?.trim() || 'session';
  const safe = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const date = new Date().toISOString().split('T')[0];
  return `${safe || 'session'}-${date}.md`;
};
