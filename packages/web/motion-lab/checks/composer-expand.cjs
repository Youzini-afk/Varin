// Expansion uses the real composer and CodeMirror editor; inspect geometry after each browser paint.
const { openLab, assert } = require('./lab.cjs');
const ready = () => window.__send && document.querySelector('[data-conversation-composer-input-frame] .cm-content');
const largestStep = values => values.slice(1).reduce((largest, value, index) => Math.max(largest, Math.abs(value - values[index])), 0);

(async () => {
  const failures = [];
  const { browser, page, errors } = await openLab({ query: '?scene=send', ready });
  try {
    if (process.env.LAB_THEME) {
      await page.evaluate(mode => window.__theme.mode(mode), process.env.LAB_THEME);
      await page.waitForTimeout(500);
    }
    const record = async action => {
      await page.evaluate(() => window.__send.record());
      await action(); await page.waitForTimeout(1000);
      return page.evaluate(() => window.__send.stopRecording());
    };
    const expand = async value => {
      const before = await page.locator('[data-conversation-composer-input-frame]').boundingBox();
      const samples = await record(() => page.evaluate(value => window.__send.expand(value), value));
      const heights = [before.height, ...samples.map(sample => sample.frame.height)];
      const tops = [before.y, ...samples.map(sample => sample.frame.top)];
      const heightChange = Math.abs(heights.at(-1) - heights[0]);
      const positionChange = Math.abs(tops.at(-1) - tops[0]);
      assert(heightChange > 100 && largestStep(heights) < heightChange * .45 && largestStep(tops) < positionChange * .45,
        `${value ? 'expand' : 'collapse'} follows the input rectangle continuously`, failures);
      assert(samples.every(sample => sample.frame.footerBottom <= sample.frame.top + sample.frame.height + 2),
        `${value ? 'expand' : 'collapse'} keeps the toolbar inside the frame`, failures);
      const lines = samples.map(sample => sample.frame.lineHeight);
      assert(Math.max(...lines) - Math.min(...lines) < .1, 'editor text keeps its size during expansion', failures);
    };
    await expand(true); await expand(false);
    await page.click('.cm-content'); await page.keyboard.type('保留草稿和选择范围');
    await page.evaluate(() => { window.__expansionEditor = document.querySelector('.cm-content'); window.__send.select(2, 5); });
    const draft = await page.evaluate(() => window.__send.draft());
    await record(async () => {
      await page.evaluate(() => window.__send.expand(true)); await page.waitForTimeout(90);
      await page.evaluate(() => window.__send.expand(false)); await page.waitForTimeout(90);
      await page.evaluate(() => window.__send.expand(true));
    });
    await expand(false);
    const preserved = await page.evaluate(() => ({ editor: window.__expansionEditor === document.querySelector('.cm-content'),
      focused: document.activeElement === window.__expansionEditor, selection: window.__send.selection(), text: window.__send.draft() }));
    assert(preserved.editor && preserved.focused && preserved.selection.start === 2 && preserved.selection.end === 5 && preserved.text === draft,
      'reversing expansion preserves the editor, focus, selection and draft', failures);
    assert(await page.locator('[data-conversation-composer-input-frame]').evaluate(element => getComputedStyle(element).overflowX === 'visible'),
      'settled expansion releases clipping for composer menus', failures);
    assert(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, failures);
  } finally { await browser.close(); }
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exitCode = 1; }
  else console.log('\nall passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
