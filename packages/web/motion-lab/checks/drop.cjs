// Drop field (§3.11, drag and drop): system files dragged over the conversation raise a faint lattice
// whose cells brighten near the pointer and trail it; anywhere in the conversation takes the drop,
// the field ripples out and leaves; leaving the window takes it away; an internal drag raises nothing.
// Runs on the send scene (the empty home with the real composer).
const { openLab, assert } = require('./lab.cjs');

const ready = () => window.__send && document.querySelector('[data-conversation-composer-input-frame] .cm-content');

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ width: 1100, height: 760, query: '?scene=send', ready });

  await page.evaluate(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
    window.__dropFiles = () => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
      return transfer;
    };
    window.__drag = (type, x, y, transfer, related = null) => {
      const target = document.elementFromPoint(x, y);
      const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer, relatedTarget: related });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.__field = () => {
      const canvas = document.querySelector('.file-drop-field');
      if (!canvas) return null;
      const box = canvas.getBoundingClientRect();
      return { opacity: Number(getComputedStyle(canvas).opacity), left: box.left, top: box.top, width: canvas.width, ratio: canvas.width / box.width };
    };
    window.__alphaAt = (x, y) => {
      const canvas = document.querySelector('.file-drop-field');
      const box = canvas.getBoundingClientRect();
      const ratio = canvas.width / box.width;
      return canvas.getContext('2d').getImageData(Math.round((x - box.left) * ratio), Math.round((y - box.top) * ratio), 1, 1).data[3];
    };
  });

  const hero = await page.evaluate(() => {
    const box = document.querySelector('h1').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });
  // Drag in and move a little.
  await page.evaluate(({ x, y }) => {
    window.__transfer = window.__dropFiles();
    window.__drag('dragenter', x, y, window.__transfer);
    window.__drag('dragover', x, y, window.__transfer);
  }, hero);
  for (let step = 1; step <= 6; step += 1) {
    await page.waitForTimeout(40);
    await page.evaluate(({ x, y }) => window.__drag('dragover', x, y, window.__transfer), { x: hero.x + step * 20, y: hero.y });
  }
  await page.waitForTimeout(400);
  // `node drop.cjs <out-dir>` keeps a frame of the field for review.
  if (process.argv[2]) await page.screenshot({ path: require('node:path').resolve(process.argv[2], 'drop-field.png') });
  const shown = await page.evaluate(() => window.__field());
  assert(shown && shown.opacity > 0.95, `drag in: the field rises over the conversation (opacity ${shown?.opacity})`, failures);
  const pointer = { x: hero.x + 120, y: hero.y };
  // Cells are 44px from the region's corner; sample the stroke of the cell under the pointer and of a far one.
  const near = await page.evaluate(({ x, y }) => {
    const box = document.querySelector('.file-drop-field').getBoundingClientRect();
    const left = box.left + Math.floor((x - box.left) / 44) * 44 + 2;
    const top = box.top + Math.floor((y - box.top) / 44) * 44 + 22;
    return window.__alphaAt(left, top);
  }, pointer);
  const far = await page.evaluate(() => {
    const box = document.querySelector('.file-drop-field').getBoundingClientRect();
    return window.__alphaAt(box.left + 2, box.top + 22 + 44 * 10);
  });
  assert(near > far * 2 && far > 0, `drag in: cells near the pointer are brighter (stroke alpha ${near} near, ${far} far)`, failures);

  // Drop on the conversation, away from the composer.
  const taken = await page.evaluate(({ x, y }) => window.__drag('drop', x, y, window.__transfer), pointer);
  assert(taken, 'drop: the conversation takes a drop outside the composer', failures);
  await page.waitForTimeout(500);
  const attached = await page.evaluate(() => document.querySelectorAll('[data-conversation-composer-input-frame] img').length);
  assert(attached >= 1, `drop: the file reaches the composer (${attached} image)`, failures);
  assert(await page.evaluate(() => window.__field() === null), 'drop: the field ripples out and leaves', failures);

  // Drag in and leave the window.
  await page.evaluate(({ x, y }) => {
    const transfer = window.__dropFiles();
    window.__drag('dragenter', x, y, transfer);
    window.__drag('dragover', x, y, transfer);
    window.__drag('dragleave', x, y, transfer, null);
  }, hero);
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => window.__field() === null), 'leave: the field goes when the drag leaves', failures);

  // A drag from inside the app (no system files) raises nothing.
  await page.evaluate(({ x, y }) => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-varin-file-path', '/workspace/a.ts');
    window.__drag('dragenter', x, y, transfer);
    window.__drag('dragover', x, y, transfer);
  }, hero);
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => window.__field() === null), 'internal drag: no field', failures);

  assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
