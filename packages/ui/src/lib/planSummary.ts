import { parseTodoPlan, type TodoItem } from '@varin/protocol';

export interface PlanSummary { items: TodoItem[]; total: number; done: number; blocked: number }

export const summarizePlan = (content: string): PlanSummary => {
  const items = parseTodoPlan(content);
  return { items, total: items.length, done: items.filter(item => item.status === 'completed').length, blocked: items.filter(item => item.status === 'blocked').length };
};
