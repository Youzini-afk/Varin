import type { ComputerAwaitParams, ComputerQueryResult } from '@varin/protocol';

/** Unknown properties and partial traversals are never evidence of absence. */
export function semanticCondition(params: ComputerAwaitParams, result: ComputerQueryResult, baseline?: string): boolean {
  if (result.status && result.status !== 'ok') return false;
  switch (params.condition) {
    case 'present': return Boolean(result.observation?.elements.length);
    case 'absent': return result.complete && result.observation?.elements.length === 0;
    case 'window_opened': return Boolean(result.observation);
    case 'window_closed': return false; // Only a native original-window loss proves closure.
    case 'property': return params.property !== undefined && result.properties?.[params.property] !== undefined
      && JSON.stringify(result.properties[params.property]) === JSON.stringify(params.equals);
    case 'changed': {
      const current = semanticBaseline(params, result);
      return baseline !== undefined && current !== undefined && current !== baseline;
    }
  }
}

export function semanticBaseline(params: ComputerAwaitParams, result: ComputerQueryResult): string | undefined {
  if (params.property) {
    const value = result.properties?.[params.property];
    return value === undefined ? undefined : JSON.stringify(value);
  }
  if (!result.complete || !result.observation) return undefined;
  return JSON.stringify(result.observation.elements.map(element => ({
    identity: element.nativeElementId ?? element.targetId ?? element.automationId ?? element.runtimeId,
    name: element.name, role: element.role, value: element.value, enabled: element.enabled,
    checked: element.checked, selected: element.selected, expanded: element.expanded,
  })));
}

export function waitForSemanticSample(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** An outline is a display projection, not a claim that fewer native nodes were read. */
export function outlineObservation(observation: import('@varin/protocol').ComputerObservation, view?: 'outline' | 'tree'): import('@varin/protocol').ComputerObservation {
  if (view !== 'outline') return observation;
  const elements = observation.elements;
  const visible = elements.filter(element => element.name || element.value || element.actions?.length
    || element.enabled !== undefined || element.checked !== undefined || element.selected !== undefined
    || element.expanded !== undefined || element.hasMoreChildren);
  const byIndex = new Map(elements.map(element => [element.index, element]));
  const visibleIndexes = new Set(visible.map(element => element.index));
  const treeLines = visible.map(element => {
    let parent = element.parentIndex, depth = 0;
    const seen = new Set<number>([element.index]);
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent); if (visibleIndexes.has(parent)) depth += 1; parent = byIndex.get(parent)?.parentIndex;
    }
    const states = [element.checked !== undefined ? `checked=${element.checked}` : '', element.selected !== undefined ? `selected=${element.selected}` : '',
      element.expanded !== undefined ? `expanded=${element.expanded}` : '', element.enabled === false ? 'disabled' : '', element.hasMoreChildren ? 'more children' : ''].filter(Boolean);
    return `${'  '.repeat(depth)}${element.index} ${element.role ?? element.controlType ?? 'element'}${element.name ? ` ${element.name}` : ''}${element.value ? `: ${element.value}` : ''}${states.length ? ` [${states.join(', ')}]` : ''}`;
  });
  return { ...observation, view, treeLines };
}

/** Node timers overflow above 2^31-1ms; caller deadlines have no such protocol limit. */
export function semanticDeadline(timeoutMs: number, expired: () => void): () => void {
  const end = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = end - Date.now();
    if (remaining <= 0) { expired(); return; }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  return () => clearTimeout(timer);
}
