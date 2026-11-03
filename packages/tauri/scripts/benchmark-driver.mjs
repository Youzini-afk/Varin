/** Native-only interpreter for the fixed page observer's input requests. */
export async function dispatchBenchmarkInput(send, action, { uploadFile } = {}) {
  if (!action || typeof action.id !== 'string') throw new Error('Missing input identity');
  if (action.action === 'file') {
    if (!uploadFile) throw new Error('The private synthetic upload was not prepared');
    const document = await send('DOM.getDocument', {});
    const { nodeId } = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#upload-input' });
    if (!nodeId) throw new Error('Original fixture file input is unavailable');
    await send('DOM.setFileInputFiles', { nodeId, files: [uploadFile] });
  } else if (action.action === 'click') {
    const point = { x: action.x, y: action.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
    try { await send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' }); }
    catch (error) { throw new Error('Renderer input release outcome is unknown', { cause: error }); }
  } else if (action.action === 'scroll') {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY });
  } else if (action.action === 'text') {
    await send('Input.insertText', { text: action.text });
  } else if (action.action === 'key') {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, PageDown: 34, PageUp: 33, Home: 36, End: 35, Backspace: 8, Delete: 46, a: 65 };
    if (!codes[action.key]) throw new Error('Unsupported renderer key');
    const params = { key: action.key, code: action.key === 'a' ? 'KeyA' : action.key, windowsVirtualKeyCode: codes[action.key], modifiers: action.modifiers ?? 0 };
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

export function remoteTargetExpression(origin) {
  const expected = new URL(origin);
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1') throw new Error('Remote benchmark must bind the original loopback Host');
  return `Boolean(window.__VARIN_RUNTIME_APIS__ && window.__VARIN_API_BASE_URL__ && new URL(window.__VARIN_API_BASE_URL__).origin === ${JSON.stringify(expected.origin)})`;
}
