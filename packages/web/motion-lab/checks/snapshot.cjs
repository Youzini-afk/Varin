// Screenshot mid-scenario: `node snapshot.cjs <out-dir> [delayMs] [stream|process|file|tray|send] [name]`.
// `send` types a message on the empty home, presses Enter and captures after `delayMs`;
// a comma-separated delay (`80,200,400`) captures one image per moment of the same send.
const path = require('node:path');
const { openLab } = require('./lab.cjs');

(async () => {
  const [outDir = '.', delay = '2600', scenario = 'stream', name = `motion-lab-${scenario}`] = process.argv.slice(2);
  if (scenario === 'send') {
    const ready = () => window.__send && document.querySelector('[data-conversation-composer-input-frame] .cm-content');
    const { browser, page } = await openLab({ width: 1100, height: 760, query: '?scene=send', ready });
    await page.click('[data-conversation-composer-input-frame] .cm-content');
    await page.keyboard.type('把登录模块重构一下');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('保留现有的接口，再补上测试');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.resolve(outDir, `${name}-0.png`) });
    const started = Date.now();
    await page.keyboard.press('Enter');
    for (const moment of delay.split(',').map(Number)) {
      await page.waitForTimeout(Math.max(0, moment - (Date.now() - started)));
      const out = path.resolve(outDir, `${name}-${moment}.png`);
      await page.screenshot({ path: out });
      console.log(out);
    }
    await browser.close();
    return;
  }
  const { browser, page } = await openLab({ width: 1100, height: 760 });
  const running = page.evaluate((kind) => kind === 'process' ? window.__lab.process()
    : kind === 'file' ? window.__lab.fileEdit({ pace: 3, pathLast: true })
      : kind === 'tray' ? window.__lab.tray()
      : window.__lab.stream({ chars: 1400, cps: 150, interval: 100, rich: true }), scenario);
  await page.waitForTimeout(Number(delay));
  const out = path.resolve(outDir, `${name}.png`);
  await page.screenshot({ path: out });
  console.log(out);
  await running;
  await browser.close();
})();
