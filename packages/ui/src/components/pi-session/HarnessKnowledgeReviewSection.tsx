import React from 'react';
import { useI18n } from '@/lib/i18n';
import {
  harnessKnowledgeKey,
  type HarnessKnowledgeSuggestion,
} from './harnessKnowledgePresentation';

export interface KnowledgeDraft {
  content: string;
  trigger: string;
  supersedes: number[];
}

export const HarnessKnowledgeReviewSection: React.FC<{
  suggestions: HarnessKnowledgeSuggestion[];
  drafts: Record<string, KnowledgeDraft>;
  busy: boolean;
  embedded?: boolean;
  onDraftChange: (key: string, draft: KnowledgeDraft) => void;
  onAction: (suggestion: HarnessKnowledgeSuggestion, action: 'save' | 'accept' | 'dismiss') => void;
}> = ({ suggestions, drafts, busy, embedded = false, onDraftChange, onAction }) => {
  const { t } = useI18n();
  if (suggestions.length === 0) return null;
  return (
    <section className={embedded ? '' : 'border-b border-border/50 p-2'} aria-label={t('harness.knowledge.title')}>
      {!embedded ? <h3 className="px-1 pb-1.5 typography-meta font-medium uppercase tracking-wide text-muted-foreground">{t('harness.knowledge.title')}</h3> : null}
      <div className="space-y-2">
        {suggestions.map((suggestion) => {
          const key = harnessKnowledgeKey(suggestion);
          const draft = drafts[key] ?? { content: suggestion.content, trigger: suggestion.trigger, supersedes: [] };
          return (
            <div key={key} className="rounded-lg border border-border/50 bg-background/45 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">{t(`harness.knowledge.scope.${suggestion.scope}`)}</span>
              </div>
              <textarea
                value={draft.content}
                aria-label={t('harness.knowledge.content')}
                onChange={(event) => onDraftChange(key, { ...draft, content: event.target.value })}
                className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 typography-meta leading-5 text-foreground outline-none focus:border-primary"
              />
              <input
                value={draft.trigger}
                aria-label={t('harness.knowledge.trigger')}
                placeholder={t('harness.knowledge.triggerPlaceholder')}
                onChange={(event) => onDraftChange(key, { ...draft, trigger: event.target.value })}
                className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1 typography-meta text-foreground outline-none focus:border-primary"
              />
              {suggestion.supersedesCandidates.length > 0 ? (
                <div className="mt-2 space-y-1">
                  <div className="typography-micro text-muted-foreground">{t('harness.knowledge.supersedes')}</div>
                  {suggestion.supersedesCandidates.map((candidate) => (
                    <label key={candidate.id} className="flex items-start gap-1.5 typography-micro text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={draft.supersedes.includes(candidate.id)}
                        onChange={(event) => onDraftChange(key, {
                          ...draft,
                          supersedes: event.target.checked
                            ? [...draft.supersedes, candidate.id]
                            : draft.supersedes.filter((id) => id !== candidate.id),
                        })}
                      />
                      <span className="line-clamp-2">{candidate.content}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex justify-end gap-1">
                <button type="button" disabled={busy} className="rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover disabled:opacity-50" onClick={() => onAction(suggestion, 'dismiss')}>{t('harness.knowledge.dismiss')}</button>
                <button type="button" disabled={busy} className="rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover disabled:opacity-50" onClick={() => onAction(suggestion, 'save')}>{t('harness.knowledge.save')}</button>
                <button type="button" disabled={busy} className="rounded bg-primary px-1.5 py-1 typography-micro text-primary-foreground disabled:opacity-50" onClick={() => onAction(suggestion, 'accept')}>{t('harness.knowledge.accept')}</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
