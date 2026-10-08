export const TODO_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const;
export type TodoItemStatus = typeof TODO_ITEM_STATUSES[number];

export interface TodoItem {
  text: string;
  status: TodoItemStatus;
}

export const isTodoItemStatus = (value: unknown): value is TodoItemStatus => (
  TODO_ITEM_STATUSES.some(status => status === value)
);

const PLAN_MARKERS: Record<TodoItemStatus, string> = {
  pending: ' ', in_progress: '/', completed: 'x', blocked: '!',
};

/** The editable plan block uses the same markers in Host storage and the work overview. */
export function renderTodoPlan(items: readonly TodoItem[]): string {
  if (!Array.isArray(items)) throw new Error('todo.items must be an array.');
  return items.map((item, index) => {
    if (!item || typeof item.text !== 'string') throw new Error(`todo.items[${index}].text must be a string.`);
    const status: unknown = item.status;
    if (!isTodoItemStatus(status)) {
      throw new Error(`todo.items[${index}].status must be pending, in_progress, completed, or blocked.`);
    }
    return `- [${PLAN_MARKERS[status]}] ${item.text}`;
  }).join('\n');
}

export function parseTodoPlan(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^-\s*\[([ xX/!])\]\s*(.+)$/);
    if (!match) continue;
    const marker = match[1]!.toLowerCase();
    const status: TodoItemStatus = marker === 'x' ? 'completed'
      : marker === '/' ? 'in_progress' : marker === '!' ? 'blocked' : 'pending';
    items.push({ text: match[2]!.trim(), status });
  }
  return items;
}
