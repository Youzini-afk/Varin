import type { CDPSession, Frame, Page } from 'puppeteer-core';

/** The original page owns one visibility-emulation lease shared by actual work
 * and viewers. It neither shows nor focuses an OS window. */
export class NativeBrowserActivity {
  private readonly pages = new Map<Page, { references: number; enabled: boolean; serial: Promise<unknown>; session: CDPSession }>();
  async acquire(page: Page): Promise<() => Promise<void>> {
    let entry = this.pages.get(page);
    if (!entry) {
      entry = { references: 0, enabled: false, serial: Promise.resolve(), session: (page.mainFrame() as Frame & { client: CDPSession }).client };
      this.pages.set(page, entry);
    }
    const original = entry; original.references++;
    const prepare = original.serial.catch(() => undefined).then(async () => {
      if (!original.enabled) { await original.session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); original.enabled = true; }
    });
    original.serial = prepare;
    try { await prepare; } catch (error) { original.references--; throw error; }
    let released = false;
    return async () => {
      if (released) return; released = true; original.references--;
      const release = original.serial.catch(() => undefined).then(async () => {
        if (!original.references) { await original.session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); original.enabled = false; if (!original.references) this.pages.delete(page); }
      });
      original.serial = release; await release;
    };
  }
  forget(page: Page) { this.pages.delete(page); }
}
