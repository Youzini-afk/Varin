import React from 'react';
import type { ThreadModel, ThreadModelInfo, ThreadThinkingLevel } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, sameThreadModel, useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';

const EMPTY_MODEL: ThreadModel = { providerId: '', modelId: '', thinkingLevel: 'off' };

export function threadConfigurationModel(configuration: unknown): ThreadModel | undefined {
  const value = configuration as { providerId?: string; model?: string; catalogModelId?: string;
    thinkingLevel?: ThreadThinkingLevel; modelOptions?: { temperature?: number } } | undefined;
  return value?.providerId && value.model ? {
    providerId: value.providerId, modelId: value.catalogModelId ?? value.model,
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
    ...(value.modelOptions?.temperature === undefined ? {} : { temperature: value.modelOptions.temperature }),
  } : undefined;
}

function availableThinking(model: ThreadModel | undefined, models: readonly ThreadModelInfo[]): ThreadModel | undefined {
  if (!model) return model;
  const levels = models.find(item => item.providerId === model.providerId && item.modelId === model.modelId)?.thinkingLevels;
  return levels?.length && !levels.includes(model.thinkingLevel ?? 'off') ? { ...model, thinkingLevel: levels[0] } : model;
}

/** Run observations seed the next input once per transition. They never drive the active picker through a draft write. */
export function useThreadModelSelection({ draftKey, draft, ready, active, delegated, runId, runModel, preferredModel,
  inheritWorkbenchModel, preferenceReady, models }: {
  draftKey: string; draft: ThreadDraft; ready: boolean; active: boolean; delegated: boolean;
  runId?: string; runModel?: ThreadModel; preferredModel?: ThreadModel | null;
  inheritWorkbenchModel: boolean; preferenceReady: boolean; models: readonly ThreadModelInfo[];
}): ThreadModel {
  React.useEffect(() => {
    if (!ready) return;
    const store = useThreadDraftStore.getState();
    const current = store.drafts[draftKey] ?? EMPTY_THREAD_DRAFT;
    let model = current.model;
    const previous = current.modelObservation;
    let observation = previous;
    const observedRun = previous?.run;
    // Include the finishing snapshot, then leave later idle edits alone. A reopened idle
    // conversation uses its retained draft; an empty ordinary draft may use its last Run.
    if (runId && runModel && (active || observedRun?.id === runId && observedRun.active)) {
      if (observedRun?.id !== runId || observedRun.active !== active || !sameThreadModel(observedRun.model, runModel)) {
        observation = { ...observation, run: { id: runId, active, model: runModel } };
        if (!current.firstSend && (observedRun?.id !== runId || !sameThreadModel(observedRun.model, runModel))) model = runModel;
      }
    } else if (!model?.providerId && !model?.modelId && preferredModel === undefined && !current.firstSend) {
      model = runModel ?? model;
    }
    if (preferenceReady && preferredModel === undefined && previous?.preference) observation = { ...observation, preference: undefined };
    if (preferenceReady && preferredModel !== undefined && (previous?.preference?.inheritWorkbench !== inheritWorkbenchModel
      || !sameThreadModel(previous?.preference?.model, preferredModel))) {
      observation = { ...observation, preference: { inheritWorkbench: inheritWorkbenchModel, model: preferredModel } };
      // A configured Bot default is a change event. Workbench inheritance only seeds an
      // empty draft, and neither default rewrites an accepted Run or a frozen first send.
      if (!active && !current.firstSend && (!inheritWorkbenchModel || !model?.providerId && !model?.modelId)) model = preferredModel ?? EMPTY_MODEL;
    }
    if (!active && !delegated && !current.firstSend) model = availableThinking(model, models);
    if (observation !== previous || !sameThreadModel(current.model, model)) store.patch(draftKey, { model, modelObservation: observation });
  }, [draftKey, draft.model, draft.firstSend, ready, active, delegated, runId, runModel, preferredModel, inheritWorkbenchModel, preferenceReady, models]);

  return (active ? runModel ?? draft.model : !delegated && !draft.firstSend ? availableThinking(draft.model, models) : draft.model) ?? EMPTY_MODEL;
}
