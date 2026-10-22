// The command palette in real Chrome (layout is what jsdom can't check): opened with Alt+R from an ordinary
// page, the switcher keeps the whole window, the palette sits at the top centre, and the page underneath is
// untouched. Once, the <html> element took the palette panel's class and rule (fixed, 660 px, centred), and
// the whole switcher shrank into a column the palette's width.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

let servers, browser;
beforeAll(async () => {
  servers = await startServers();
  servers.serve('/long', Buffer.from(`<!doctype html><meta charset="utf-8"><title>Long page</title>
<body style="margin:0;font:16px system-ui">${Array.from({ length: 80 }, (unused, i) => `<p>Line ${i}</p>`).join('')}</body>`), 'text/html; charset=utf-8');
  ({ browser } = await launch());
});
afterAll(async () => { await browser?.close(); await servers?.close(); });

const altKey = async (page, code) => { await page.keyboard.down('Alt'); await page.keyboard.press(code); await page.keyboard.up('Alt'); };
const switcherFrame = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
// What the switcher page looks like inside the overlay: its document's box, the header's, the palette's.
const layout = (frame) => frame.evaluate(() => {
  const box = (element) => { const bounds = element.getBoundingClientRect(); return { x: Math.round(bounds.x), y: Math.round(bounds.y), w: Math.round(bounds.width), h: Math.round(bounds.height) }; };
  const palette = document.querySelector('[data-testid="palette"]');
  return {
    vw: innerWidth, vh: innerHeight,
    html: box(document.documentElement), header: box(document.querySelector('[data-testid="header"]')),
    palette: palette && !palette.hidden ? box(palette) : null,
    mode: document.documentElement.classList.contains('palette-open'),
    // Opened with Alt+R it is on its own: the switcher behind it isn't drawn, only the dimmed backdrop.
    headerShown: getComputedStyle(document.querySelector('[data-testid="header"]')).visibility !== 'hidden',
    cardsShown: getComputedStyle(document.querySelector('[data-testid="body"]')).visibility !== 'hidden',
    paletteShown: getComputedStyle(palette).visibility !== 'hidden',
    backdrop: getComputedStyle(document.body).backgroundColor,
  };
});

describe('the command palette', () => {
  it('opened with Alt+R from a page, keeps the whole window: the palette at the top centre, the page untouched', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(servers.main + '/long');
    await page.evaluate(() => scrollTo(0, 400));
    await sleep(1500); // the prepared (standby) overlay frame
    await altKey(page, 'KeyR');
    await sleep(1000);
    const frame = switcherFrame(page);
    expect(frame).toBeTruthy();
    const layoutResult = await layout(frame);
    expect(layoutResult.mode).toBe(true);
    expect([layoutResult.headerShown, layoutResult.cardsShown, layoutResult.paletteShown]).toEqual([false, false, true]);
    expect(layoutResult.backdrop).toMatch(/^rgba\(7, 9, 13, 0\.9/); // the overlay's dimmed backdrop (the dark surface), as for the switcher
    expect(layoutResult.html).toEqual({ x: 0, y: 0, w: layoutResult.vw, h: layoutResult.vh }); // the switcher's page fills the overlay
    expect(layoutResult.header.w).toBe(layoutResult.vw); // the header spans the window, not the palette's width
    expect(layoutResult.palette.w).toBeLessThanOrEqual(680);
    expect(Math.abs(layoutResult.palette.x + layoutResult.palette.w / 2 - layoutResult.vw / 2)).toBeLessThanOrEqual(1); // centred
    expect(layoutResult.palette.y).toBeLessThan(120); // at the top, not pushed under the header
    // The overlay frame covers the page, and the page itself didn't move or change size.
    const host = await page.evaluate(() => {
      const overlayFrame = document.querySelector('[data-testid="overlay-frame"]');
      const bounds = overlayFrame.getBoundingClientRect();
      return { frame: [bounds.x, bounds.y, bounds.width, bounds.height], scrollY, w: innerWidth, h: innerHeight };
    });
    expect(host).toEqual({ frame: [0, 0, 1280, 800], scrollY: 400, w: 1280, h: 800 });
    await page.keyboard.press('Escape');
    await page.close();
  });

  it('the mouse wheel scrolls its list, and only its list (not the page under the overlay)', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(servers.main + '/long');
    await sleep(1500);
    await altKey(page, 'KeyR');
    await sleep(1000);
    const frame = switcherFrame(page);
    const list = () => frame.evaluate(() => { const paletteList = document.querySelector('[data-testid="palette-list"]'); const bounds = paletteList.getBoundingClientRect(); return { top: paletteList.scrollTop, max: paletteList.scrollHeight - paletteList.clientHeight, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; });
    const before = await list();
    expect(before.max).toBeGreaterThan(0); // the list of actions is longer than the panel: it has to scroll
    await page.mouse.move(before.x, before.y);
    await page.mouse.wheel({ deltaY: 300 });
    await sleep(400);
    const after = await list();
    expect(after.top).toBeGreaterThan(before.top);
    expect(await page.evaluate(() => scrollY)).toBe(0); // the page itself didn't scroll
    await page.close();
  });
});
