import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { ChatReadingAnchor } from './chatReadingAnchor';

it('keeps a disclosure in place across growth and shrink without double-correcting list compensation', () => {
  const { document } = parseHTML('<html><body><main><button>Details</button></main></body></html>');
  const viewport = document.querySelector('main')!, button = document.querySelector('button')!;
  viewport.scrollTop = 400;
  let contentTop = 450;
  viewport.getBoundingClientRect = () => ({ top: 0, height: 600 } as DOMRect);
  button.getBoundingClientRect = () => ({ top: contentTop - viewport.scrollTop, height: 32 } as DOMRect);
  const anchor = new ChatReadingAnchor(viewport); anchor.pin(button);
  contentTop += 260; anchor.restore();
  expect(viewport.scrollTop).toBe(660);
  contentTop -= 100; viewport.scrollTop -= 100; anchor.restore();
  expect(viewport.scrollTop).toBe(560);
  contentTop -= 70; anchor.restore(); expect(viewport.scrollTop).toBe(490);
  button.remove(); anchor.restore(); expect(viewport.scrollTop).toBe(490);
});
