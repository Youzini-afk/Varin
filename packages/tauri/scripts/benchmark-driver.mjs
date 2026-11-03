/** Native-only interpreter for the fixed page observer's input requests. */
export async function dispatchBenchmarkInput(send, action) {
  if (!action || typeof action.id !== 'string') throw new Error('Missing input identity');
  if (action.action === 'click') {
    const point = { x: action.x, y: action.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
    try { await send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' }); }
    catch (error) { throw new Error('Renderer input release outcome is unknown', { cause: error }); }
  } else if (action.action === 'scroll') {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY });
  } else if (action.action === 'text') {
    await send('Input.insertText', { text: action.text });
  } else if (action.action === 'key') {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, PageDown: 34, PageUp: 33, Home: 36, End: 35, Backspace: 8, Delete: 46 };
    if (!codes[action.key]) throw new Error('Unsupported renderer key');
    const params = { key: action.key, code: action.key, windowsVirtualKeyCode: codes[action.key], modifiers: action.modifiers ?? 0 };
    await send('Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
    await send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  } else throw new Error('Unknown replay input operation');
}
export async function evaluateBenchmark(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails || !result.result || result.result.type === 'undefined') throw new Error('Fixed product observation did not return a value');
  return result.result.value;
}
export function publicRendererSample(value) {
  // The pending action may contain synthetic composer text. Even that is not
  // part of a numeric performance recording, and never leaves the native driver.
  const { pendingAction: _pending, ...sample } = value;
  return sample;
}
