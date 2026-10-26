// Still more of Tabazing in real Firefox: the media player (what plays in a page, its buttons run in the page through the
// background: utils/api-bridge.js), snoozing, putting tabs to sleep, Backup & Restore's download, and texts that name
// the browser ("Firefox", where Chrome's say "Chrome").
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServers } from '../helpers/harness.js';
import { launchFirefox, sleep } from '../helpers/firefox.js';

const downloads = mkdtempSync(join(tmpdir(), 'tabazing-firefox-'));
const EN = JSON.parse(readFileSync(new URL('../../../dictionaries/en.json', import.meta.url), 'utf8'));
let servers, browser, extension;
const pages = {};
beforeAll(async () => {
  servers = await startServers();
  ({ browser, extension } = await launchFirefox({ preferences: {
    'media.autoplay.default': 0, 'media.volume_scale': '0.0', // (sound may play by itself, and nobody hears it)
    'browser.download.folderList': 2, 'browser.download.dir': downloads, 'browser.download.useDownloadDir': true, 'browser.download.always_ask_before_handling_new_types': false,
  } }));
  for (const name of ['Song', 'Later', 'Sleepy', 'Desk']) {
    pages[name] = await browser.newPage();
    await pages[name].setViewport({ width: 1280, height: 800 });
    await pages[name].goto(`${servers.main}/p/${name}`);
  }
  await sleep(2000);
}, 120_000);
afterAll(async () => { await browser?.close(); await servers?.close(); });

async function front(name) { await pages[name].bringToFront(); await sleep(1500); return pages[name]; }
async function openOver(page) {
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await sleep(80); await page.keyboard.up('Alt');
  for (let wait = 0; wait < 60; wait++) {
    await sleep(100);
    const frame = await extension.overlayFrame(page);
    if (frame && await page.evaluate(() => document.querySelector('[data-testid="overlay-frame"]')?.style.visibility === 'visible')) { await sleep(400); return frame; }
  }
  throw new Error('the overlay did not show');
}
async function close(page) { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(800); }
const tabNamed = (title) => extension.run((wanted) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.title === wanted) || null), title);

describe('Tabazing in Firefox: media, snooze, sleep, backup, words', () => {
  it('what plays in a page shows in the player; its pause button pauses it in the page', async () => {
    await pages.Song.evaluate(() => { window.song = new Audio(window.E2E.wav(30)); return window.song.play(); });
    for (let wait = 0; wait < 40; wait++) { await sleep(150); if (Object.keys(await extension.run(() => chrome.storage.session.get('media').then((stored) => stored.media || {}))).length) break; }
    const page = await front('Desk');
    const frame = await openOver(page);
    expect(await frame.evaluate(() => !document.querySelector('[data-testid="player"]').hidden)).toBe(true);
    await frame.evaluate(() => document.querySelector('[data-testid="player-toggle"]').click());
    await sleep(1000);
    expect(await pages.Song.evaluate(() => window.song.paused)).toBe(true);
    await close(page);
  });

  it('snoozing a tab closes it until then, and the alarm that brings it back is set', async () => {
    const page = await front('Desk');
    const frame = await openOver(page);
    // (the card's menu: its Snooze item, then the first choice it offers)
    await frame.evaluate(async () => {
      const card = [...document.querySelectorAll('[data-testid="card-tab"]')].find((element) => element.querySelector('[data-testid="card-title"]').textContent === 'Later');
      card.querySelector('[data-testid="quick-clock"]').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelectorAll('[data-testid="menu-item"]')[0].click();
    });
    await sleep(1500);
    expect(await tabNamed('Later')).toBe(null);
    const snoozed = await extension.run(() => chrome.storage.local.get('snoozed').then((stored) => stored.snoozed || []));
    expect(snoozed.map((item) => item.title)).toContain('Later');
    expect(await extension.run(() => chrome.alarms.getAll().then((alarms) => alarms.length))).toBeGreaterThan(0);
    await close(page);
  });

  it('a tab put to sleep is unloaded once Tabazing closes', async () => {
    const page = await front('Desk');
    const frame = await openOver(page);
    await frame.evaluate(async (label) => {
      const card = [...document.querySelectorAll('[data-testid="card-tab"]')].find((element) => element.querySelector('[data-testid="card-title"]').textContent === 'Sleepy');
      card.querySelector('[data-testid="quick-more"]').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      [...document.querySelectorAll('[data-testid="menu-item"]')].find((element) => element.textContent === label).click();
    }, EN.sleepThis);
    await sleep(300);
    await close(page);
    await sleep(1500);
    expect((await tabNamed('Sleepy')).discarded).toBe(true);
  });

  it('Back up downloads tabazing-backup-<date>.zip', async () => {
    const page = await front('Desk');
    const frame = await openOver(page);
    await frame.evaluate(() => document.querySelector('[data-testid="backup-button"]').click());
    await sleep(600);
    await frame.evaluate(() => document.querySelector('[data-testid="backup-export-button"]').click());
    let files = [];
    for (let wait = 0; wait < 50 && !files.some((name) => /^tabazing-backup-.*\.zip$/.test(name)); wait++) { await sleep(200); files = existsSync(downloads) ? readdirSync(downloads) : []; }
    expect(files.some((name) => /^tabazing-backup-\d{4}-\d{2}-\d{2}\.zip$/.test(name))).toBe(true);
    await close(page);
  });

  it('the texts name Firefox, not Chrome (Settings: “Auto (Firefox’s language)”)', async () => {
    const page = await front('Desk');
    const frame = await openOver(page);
    await frame.evaluate(() => document.querySelector('[data-testid="settings-button"]').click());
    await sleep(600);
    const text = await frame.evaluate(() => document.querySelector('[data-testid="settings"]').textContent);
    expect(text).toContain('Firefox');
    expect(text).not.toContain('Chrome');
    await close(page);
  });
});
