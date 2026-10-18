// The command palette in real Chrome (layout is what jsdom can't check): opened with Alt+R from an ordinary
// page, the switcher keeps the whole window, the palette sits at the top centre, and the page underneath is
// untouched. Once, the <html> element took the palette panel's class and rule (fixed, 660 px, centred), and
// the whole switcher shrank into a column the palette's width.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './harness.js';

let servers, browser;
beforeAll(async () => {
  servers = await startServers();
  servers.serve('/long', Buffer.from(`<!doctype html><meta charset="utf-8"><title>Long page</title>
<body style="margin:0;font:16px system-ui">${Array.from({ length: 80 }, (_, i) => `<p>Line ${i}</p>`).join('')}</body>`), 'text/html; charset=utf-8');
  ({ browser } = await launch());
});
afterAll(async () => { await browser?.close(); await servers?.close(); });

const altKey = async (page, code) => { await page.keyboard.down('Alt'); await page.keyboard.press(code); await page.keyboard.up('Alt'); };
const switcherFrame = (page) => page.frames().find((f) => f.url().includes('switcher.html'));
// What the switcher page looks like inside the overlay: its document's box, the header's, the palette's.
const layout = (frame) => frame.evaluate(() => {
  const box = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const pal = document.querySelector('[data-testid="palette"]');
  return {
    vw: innerWidth, vh: innerHeight,
    html: box(document.documentElement), header: box(document.querySelector('[data-testid="header"]')),
    palette: pal && !pal.hidden ? box(pal) : null,
    mode: document.documentElement.classList.contains('palette-open'),
    // Opened with Alt+R it is on its own: the switcher behind it isn't drawn, only the dimmed backdrop.
    headerShown: getComputedStyle(document.querySelector('[data-testid="header"]')).visibility !== 'hidden',
    cardsShown: getComputedStyle(document.querySelector('[data-testid="body"]')).visibility !== 'hidden',
    paletteShown: getComputedStyle(pal).visibility !== 'hidden',
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
    const l = await layout(frame);
    expect(l.mode).toBe(true);
    expect([l.headerShown, l.cardsShown, l.paletteShown]).toEqual([false, false, true]);
    expect(l.backdrop).toMatch(/^rgba\(10, 12, 16, 0\.7/); // the overlay's dimmed backdrop, as for the switcher
    expect(l.html).toEqual({ x: 0, y: 0, w: l.vw, h: l.vh }); // the switcher's page fills the overlay
    expect(l.header.w).toBe(l.vw); // the header spans the window, not the palette's width
    expect(l.palette.w).toBeLessThanOrEqual(680);
    expect(Math.abs(l.palette.x + l.palette.w / 2 - l.vw / 2)).toBeLessThanOrEqual(1); // centred
    expect(l.palette.y).toBeLessThan(120); // at the top, not pushed under the header
    // The overlay frame covers the page, and the page itself didn't move or change size.
    const host = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="overlay-frame"]');
      const r = f.getBoundingClientRect();
      return { frame: [r.x, r.y, r.width, r.height], scrollY, w: innerWidth, h: innerHeight };
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
    const list = () => frame.evaluate(() => { const l = document.querySelector('[data-testid="palette-list"]'); const r = l.getBoundingClientRect(); return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
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
