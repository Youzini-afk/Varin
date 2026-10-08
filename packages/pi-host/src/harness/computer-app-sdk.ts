import type { ComputerAction, ComputerObservation } from '@varin/protocol';

/** Self-contained: its emitted function is installed inside the existing persistent REPL worker. */
export function installComputerAppSdk(
  computer: Record<string, unknown>,
  call: (method: string, args: unknown[]) => Promise<unknown>,
  write: (text: string) => void,
): void {
  type Options = { desktopId?: string; window?: number | string };
  type ReadOptions = { fresh?: boolean; emit?: boolean; textLimit?: number | 'max'; offset?: number };
  type Binding = { observation: ComputerObservation; automationEpoch: string; readOnly?: boolean };
  computer.getApp = async (selector: string | { pid: number; window?: number | string }, options: Options = {}) => {
    const app = typeof selector === 'string' ? selector : String(selector.pid);
    const bound = await call('getApp', [app, { ...options, ...(typeof selector === 'object' && selector.window !== undefined ? { window: selector.window } : {}) }]) as Binding;
    let state = bound.observation;
    let raster: ComputerObservation | undefined;
    let dirty = false;
    const target = { desktopId: state.desktopId, window: state.windowHandle ?? options.window ?? (typeof selector === 'object' ? selector.window : undefined), automationEpoch: bound.automationEpoch };
    const pid = String(state.app.pid);
    const read = async (screenshot: boolean, options: ReadOptions = {}) => {
      const fresh = dirty || options.fresh || screenshot;
      if (fresh || options.textLimit !== undefined || (state.treePage?.offset ?? 0) !== (options.offset ?? 0)) {
        if (fresh && options.offset) throw new Error('Read the changed app from offset 0 before continuing its tree');
        dirty = true;
        if (screenshot) raster = undefined;
        state = await call('observe', [pid, { desktopId: target.desktopId, window: target.window, includeScreenshot: screenshot, textLimit: options.textLimit,
          ...(!fresh ? { observationId: state.id, offset: options.offset ?? 0 } : {}) }]) as ComputerObservation;
        if (state.screenshot) raster = state;
        dirty = false;
      }
      return state;
    };
    const act = async (operation: Omit<ComputerAction, 'app'>, coordinate = false) => {
      const observation = coordinate ? raster : state;
      if (!observation) throw new Error('Take a screenshot on this bound app before using raster coordinates');
      dirty = true;
      try {
        return await call('act', [{ ...operation, app: pid, window: target.window,
          ...(coordinate || operation.elementIndex !== undefined ? { observationId: observation.id } : {}),
          returnState: 'none' }, target]);
      } catch (error) {
        raster = undefined;
        throw error;
      }
    };
    // An emitted image must not also dump its base64 into the REPL's final-expression text.
    const treeText = (observation: ComputerObservation) => [...observation.treeLines,
      ...(observation.treePage?.nextOffset !== undefined
        ? [`More tree lines: getAXState({offset:${observation.treePage.nextOffset}}) (total ${observation.treePage.total}).`] : [])].join('\n');
    const imageResult = (observation: ComputerObservation, options: ReadOptions) => options.emit === false ? observation : {
      observationId: observation.id, desktopId: observation.desktopId, app: observation.app,
      windowHandle: observation.windowHandle, width: observation.screenshot?.width, height: observation.screenshot?.height,
      treePage: observation.treePage,
    };
    const point = (value: number | [number, number]) => typeof value === 'number'
      ? { elementIndex: value } : { x: value[0], y: value[1] };
    return Object.freeze({
      desktopId: target.desktopId, pid: state.app.pid, window: target.window, name: state.app.name,
      async getAXState(options: ReadOptions = {}) {
        const observation = await read(false, options);
        const text = treeText(observation);
        if (options.emit !== false) write(text);
        return text;
      },
      async getScreenshot(options: ReadOptions = {}) {
        const observation = await read(true, options);
        if (!observation.screenshot) throw new Error('This window did not produce a screenshot; use its accessibility elements');
        if (options.emit !== false) await call('emitImage', [observation]);
        return imageResult(observation, options);
      },
      async getAXStateAndScreenshot(options: ReadOptions = {}) {
        const observation = await read(true, options);
        if (options.emit !== false) {
          write(treeText(observation));
          if (observation.screenshot) await call('emitImage', [observation]);
        }
        return imageResult(observation, options);
      },
      async elements(options: ReadOptions = {}) { return (await read(false, options)).elements; },
      ...(bound.readOnly ? {} : {
        async click(value: number | [number, number], options: Pick<ComputerAction, 'clickCount' | 'mouseButton' | 'clickMethod'> = {}) {
          return act({ ...options, kind: 'click', ...point(value) }, Array.isArray(value));
        },
        async setValue(index: number, value: string) { return act({ kind: 'set_value', elementIndex: index, value }); },
        async typeText(text: string, options: Pick<ComputerAction, 'clickMethod' | 'elementIndex'> = {}) { return act({ ...options, kind: 'type', text }); },
        async pressKey(key: string, options: Pick<ComputerAction, 'clickMethod' | 'elementIndex'> = {}) { return act({ ...options, kind: 'key', key }); },
        async scroll(value: number | [number, number], direction: NonNullable<ComputerAction['direction']>, pages = 1) {
          return act({ kind: 'scroll', ...point(value), direction, pages }, Array.isArray(value));
        },
        async drag(from: [number, number], to: [number, number]) {
          return act({ kind: 'drag', fromX: from[0], fromY: from[1], toX: to[0], toY: to[1] }, true);
        },
        async performSecondaryAction(index: number, action: string) { return act({ kind: 'secondary', elementIndex: index, action }); },
      }),
    });
  };
}
