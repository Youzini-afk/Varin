import type { Knowledge } from '../knowledge/store-contract.js';
import { sourceRevision } from './memory-sources.js';

export const maintenanceVersion = (row: Knowledge): string => sourceRevision(JSON.stringify([
  row.id, row.content, row.trigger, row.status, row.createdAt, row.invalidAt ?? null, row.forgottenAt ?? null,
  row.source, row.nature,
]));
export const memoryVersion = (row: Knowledge): string => sourceRevision(JSON.stringify([row.content, row.trigger, row.createdAt]));
export const memoryExpected = (row: Knowledge) => ({ content: row.content, trigger: row.trigger, status: row.status, invalidAt: row.invalidAt ?? null });
