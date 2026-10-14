import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { historyParts } from './thread-content';
export async function exportThreadMarkdown(api: ThreadsAPI, identity: ThreadIdentity, title: string): Promise<string> {
  const snapshot = await api.snapshot(identity);
  let items = snapshot.history;
  let previous = snapshot.historyPage.previous;
  const head = snapshot.historyPage.head;
  while (head && previous) {
    const page = await api.historyPage(identity, { headId: head, beforeId: previous });
    items = [...page.items, ...items]; previous = page.previous;
  }
  return [`# ${title}`, `Thread: ${identity.threadId}\nBranch: ${identity.branchId}`, ...items.map(item => {
    const content = historyParts(item.content, item.source).map(part => {
      if (part.kind === 'text' || part.kind === 'status') return part.text;
      if (part.kind === 'media') return `[Media: ${part.media.media_type}]`;
      if (part.kind === 'output') return part.output.parts.map(value => value.kind === 'text' ? value.text : `[Media: ${value.media.media_type}]`).join('\n');
      return JSON.stringify(part.data, null, 2);
    }).join('\n\n');
    return `## ${item.source}\n\n${content}`;
  })].join('\n\n');
}
