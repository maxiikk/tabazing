// The Firefox copy (scripts/firefox.js) in real Firefox, through puppeteer's WebDriver BiDi: built afresh, installed as a
// temporary add-on, with a fixed internal address (Firefox gives each install a random moz-extension uuid otherwise).
// Uses the Firefox installed on the machine (FIREFOX_PATH, else the usual place on Windows, macOS and Linux).
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { build, OUT, GECKO_ID } from '../../../scripts/firefox.js';

export const UUID = '6f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
export const ORIGIN = `moz-extension://${UUID}`;
const FIREFOX = [process.env.FIREFOX_PATH, 'C:/Program Files/Mozilla Firefox/firefox.exe', '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox'].find((path) => path && existsSync(path));
export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function launchFirefox({ preferences = {} } = {}) {
  if (!FIREFOX) throw new Error('No Firefox found: set FIREFOX_PATH');
  build();
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: FIREFOX, headless: true,
    args: ['--remote-allow-system-access'], // (to run code in the extension's own pages)
    extraPrefsFirefox: { 'xpinstall.signatures.required': false, 'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: UUID }), ...preferences },
  });
  await browser.installExtension(OUT);
  const firstPages = await browser.pages();
  const extension = await FirefoxExtension.open(browser);
  for (const page of firstPages) await page.close(); // (Firefox's first tab: not one the tests use)
  return { browser, extension };
}

// The extension's side, through one of its own pages (a page may go to the switcher's page: it is web accessible).
export class FirefoxExtension {
  static async open(browser) {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.evaluate((url) => { location.href = url; }, `${ORIGIN}/markup/switcher.html`);
    for (let wait = 0; wait < 100; wait++) {
      await sleep(50);
      if (await page.evaluate(() => typeof chrome !== 'undefined' && !!chrome.tabs).catch(() => false)) break;
    }
    const extension = new FirefoxExtension(browser, page);
    await extension.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
    return extension;
  }
  constructor(browser, page) { this.browser = browser; this.page = page; }
  run(callback, ...parameters) { return this.page.evaluate(callback, ...parameters); }
  /** The switcher's frame over `page` (the overlay), or null. Puppeteer lists it as about:blank; it runs fine. */
  async overlayFrame(page) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frame.evaluate((origin) => location.origin === origin, ORIGIN).catch(() => false)) return frame;
    }
    return null;
  }
  /** The switcher in its own window, or null. */
  async switcherWindow() {
    for (const page of await this.browser.pages()) {
      if (page === this.page) continue;
      if (await page.evaluate((origin) => location.origin === origin && /[?&]t=/.test(location.search), ORIGIN).catch(() => false)) return page;
    }
    return null;
  }
}
