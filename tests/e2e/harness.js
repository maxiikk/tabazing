// The e2e suite's harness: a local http server for the test pages, and Chrome for Testing (puppeteer) with
// the unpacked extension loaded. Content scripts need http(s) pages; file:// would need extra permission.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const PAGE_MEDIA = readFileSync(resolve(HERE, 'page-media.js'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long a "nothing is listed" check waits: well past the hook's 150 ms debounce and a few timeupdates.
export const QUIET_MS = 1500;

// One handler, two listeners: the main origin (127.0.0.1:A) and a cross-site one (localhost:B) for iframes.
// /p/<name> and /frame/<name>: an empty page titled <name> with page-media.js; files added with serve().
export async function startServers() {
  const files = new Map();
  const handler = (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/page-media.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(PAGE_MEDIA); }
    if (files.has(path)) {
      const f = files.get(path);
      res.writeHead(200, { 'content-type': f.type, 'content-length': f.body.length });
      return res.end(f.body);
    }
    const m = /^\/(p|frame)\/([\w-]+)$/.exec(path);
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${m[2]}</title><script src="/page-media.js"></script><body></body>`);
  };
  const listen = () => new Promise((r) => { const s = http.createServer(handler); s.listen(0, () => r(s)); });
  const [a, b] = await Promise.all([listen(), listen()]);
  return {
    main: `http://127.0.0.1:${a.address().port}`,
    cross: `http://localhost:${b.address().port}`,
    serve: (path, body, type) => files.set(path, { body, type }),
    close: () => Promise.all([a, b].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))),
  };
}

// Headless (the new headless, which loads extensions) Chrome for Testing: branded Chrome 137+ no longer
// loads unpacked extensions from the command line. --mute-audio only silences the output: el.muted, the
// volume and the decoded-audio counters the hook reads are unchanged by it.
export async function launch() {
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: true,
    pipe: true,
    args: [
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--js-flags=--expose-gc',
    ],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const id = new URL(sw.url()).host;
  return { browser, ext: new Ext(browser, id) };
}

// The extension's side: its service worker, its storage, its view of the tabs.
export class Ext {
  constructor(browser, id) {
    this.browser = browser;
    this.id = id;
    this.sw = browser.targets().filter((t) => this.isWorker(t)).pop();
    // After a reload puppeteer still lists the old worker's target: the newest one is the live one.
    browser.on('targetcreated', (t) => { if (this.isWorker(t)) this.sw = t; });
  }
  isWorker(t) { return t.type() === 'service_worker' && t.url() === `chrome-extension://${this.id}/background.js`; }

  async worker() { return this.sw.worker(); }
  // Reloads the extension, as "Reload" on chrome://extensions does: puppeteer loads the unpacked folder
  // again (CDP Extensions.loadUnpacked). chrome.runtime.reload() can't be used: Chrome for Testing leaves an
  // extension loaded with --load-extension unloaded after it (its pages then fail with ERR_BLOCKED_BY_CLIENT).
  async reload() {
    const old = this.sw;
    await this.browser.installExtension(REPO);
    if (this.sw === old) await this.browser.waitForTarget((t) => this.isWorker(t) && t !== old);
  }
  async run(fn, ...args) { return (await this.worker()).evaluate(fn, ...args); }

  // storage.session 'media': { [tabId]: { [frameId]: state } }
  media() { return this.run(() => chrome.storage.session.get('media').then((r) => r.media || {})); }
  // A page's tab id, by its URL (each test page has its own).
  async tabId(page) {
    const url = page.url();
    const id = await this.run((u) => chrome.tabs.query({}).then((ts) => (ts.find((t) => t.url === u || t.pendingUrl === u) || {}).id), url);
    if (!Number.isInteger(id)) throw new Error(`no tab for ${url}`);
    return id;
  }
  // What is stored for a page's tab: { [frameId]: state }, or undefined.
  async framesOf(page, tabId) {
    const id = tabId ?? await this.tabId(page);
    return (await this.media())[id];
  }
  // The top frame's stored state, or undefined.
  async topOf(page) { const f = await this.framesOf(page); return f && f['0']; }
  // Each frame of the tab: [{ frameId, url }].
  async frames(page) {
    const tabId = await this.tabId(page);
    return this.run((id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => location.href })
      .then((rs) => rs.map((r) => ({ frameId: r.frameId, url: r.result }))), tabId);
  }
  // Runs `func` (its source) in a frame of the page's tab, in the page's world, through
  // chrome.scripting.executeScript from the service worker, as the extension's own calls do. The test pages
  // have no CSP, so the source can be evaluated there.
  async inMain(page, func, args = [], frameId = 0) {
    const tabId = await this.tabId(page);
    return this.run((id, f, src, a) => chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [f] }, world: 'MAIN', args: [src, a],
      func: (code, list) => (0, eval)(`(${code})`)(...list),
    }).then((rs) => rs[0] && rs[0].result), tabId, frameId, func.toString(), args);
  }
  // A tab with the extension's markup/switcher.html, loaded without a launch token: it shows nothing, but it is an
  // extension page the background accepts messages from (fromSwitcher) and can import the extension's modules.
  async extPage() {
    const page = await this.browser.newPage();
    await page.goto(`chrome-extension://${this.id}/markup/switcher.html`);
    return page;
  }
}
